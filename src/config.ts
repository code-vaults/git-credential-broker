/**
 * Broker configuration: loaded from a JSON file that lives on the host, outside every
 * mount the agent container can see, and validated eagerly so a broken or over-broad
 * configuration stops the daemon at startup instead of silently denying (or silently
 * allowing) at push time.
 */
import { readFileSync } from 'node:fs';

import type { BrokerConfig, GithubAppHostConfig, HostConfig, StaticHostConfig } from './types.ts';

/** Providers this build knows how to construct. */
export const KNOWN_PROVIDERS = ['github-app', 'static'] as const;

/**
 * Whether a value is a plain object.
 *
 * @param value - the value to test.
 * @returns true for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an optional string field, recording a type error instead of coercing.
 *
 * @param record - the object to read from.
 * @param key - the field name.
 * @param errors - the error accumulator.
 * @param at - the human-readable location, for messages.
 * @returns the string, or undefined when absent or invalid.
 */
function stringField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    errors.push(`${at}.${key} must be a string`);
    return undefined;
  }
  return value;
}

/**
 * Read an optional numeric field.
 *
 * @param record - the object to read from.
 * @param key - the field name.
 * @param errors - the error accumulator.
 * @param at - the human-readable location, for messages.
 * @returns the number, or undefined when absent or invalid.
 */
function numberField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${at}.${key} must be a finite number`);
    return undefined;
  }
  return value;
}

/**
 * Read an optional boolean field.
 *
 * @param record - the object to read from.
 * @param key - the field name.
 * @param errors - the error accumulator.
 * @param at - the human-readable location, for messages.
 * @returns the boolean, or undefined when absent or invalid.
 */
function booleanField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    errors.push(`${at}.${key} must be a boolean`);
    return undefined;
  }
  return value;
}

/**
 * Read an optional string-or-number field (the app ID may be written either way).
 *
 * @param record - the object to read from.
 * @param key - the field name.
 * @param errors - the error accumulator.
 * @param at - the human-readable location, for messages.
 * @returns the value, or undefined when absent or invalid.
 */
function stringOrNumberField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): string | number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number') return value;
  errors.push(`${at}.${key} must be a string or a number`);
  return undefined;
}

/**
 * Read an optional map of strings, for REST permission names.
 *
 * @param value - the raw value.
 * @param errors - the error accumulator.
 * @param at - the human-readable location, for messages.
 * @returns the map, or undefined when absent or invalid.
 */
function stringMapField(
  value: unknown,
  errors: string[],
  at: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    errors.push(`${at}.permissions must be an object of permission names to access levels`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      errors.push(`${at}.permissions["${key}"] must be a string`);
      continue;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Validate a parsed configuration object.
 *
 * @param raw - the parsed JSON.
 * @param source - where it came from, for error messages.
 * @returns the validated configuration with defaults applied.
 * @throws {Error} when any field is missing or malformed.
 */
export function validateConfig(raw: unknown, source = '<config>'): BrokerConfig {
  if (!isRecord(raw)) {
    throw new Error(`invalid config (${source}): top level must be a JSON object`);
  }

  const errors: string[] = [];

  const socketPathRaw = raw['socketPath'];
  if (typeof socketPathRaw !== 'string' || !socketPathRaw) {
    errors.push('socketPath is required (absolute path of the broker unix socket)');
  }

  const auditRaw = raw['auditPath'];
  if (auditRaw !== undefined && auditRaw !== null && typeof auditRaw !== 'string') {
    errors.push('auditPath must be a string when present');
  }

  const socketModeRaw = raw['socketMode'];
  if (socketModeRaw !== undefined && !Number.isInteger(socketModeRaw)) {
    errors.push('socketMode must be an integer (octal literal, e.g. 432 for 0660)');
  }

  const skewRaw = raw['tokenCacheSkewSeconds'];
  if (skewRaw !== undefined && (typeof skewRaw !== 'number' || !Number.isFinite(skewRaw))) {
    errors.push('tokenCacheSkewSeconds must be a number');
  }

  const hostsRaw = raw['hosts'];
  const hosts: Record<string, HostConfig> = {};
  if (!isRecord(hostsRaw) || Object.keys(hostsRaw).length === 0) {
    errors.push('hosts must be a non-empty object keyed by host as git reports it (e.g. "github.com")');
  } else {
    for (const [host, blockRaw] of Object.entries(hostsRaw)) {
      const at = `hosts["${host}"]`;
      if (!isRecord(blockRaw)) {
        errors.push(`${at} must be an object`);
        continue;
      }

      const provider = blockRaw['provider'];
      if (provider !== 'static' && provider !== 'github-app') {
        errors.push(`${at}.provider must be one of: ${KNOWN_PROVIDERS.join(', ')}`);
        continue;
      }

      const allowRaw = blockRaw['allow'];
      if (!Array.isArray(allowRaw) || allowRaw.length === 0) {
        errors.push(
          `${at}.allow must be a non-empty array; the broker is default deny, so an empty allowlist is almost certainly a mistake`,
        );
        continue;
      }
      const allow: string[] = [];
      for (const entry of allowRaw) {
        if (typeof entry !== 'string') {
          errors.push(`${at}.allow must contain only strings`);
          continue;
        }
        allow.push(entry);
      }

      if (provider === 'static') {
        const block: StaticHostConfig = {
          provider: 'static',
          allow,
          allowInsecureHttp: booleanField(blockRaw, 'allowInsecureHttp', errors, at),
          username: stringField(blockRaw, 'username', errors, at),
          password: stringField(blockRaw, 'password', errors, at),
          passwordPath: stringField(blockRaw, 'passwordPath', errors, at),
          passwordEnv: stringField(blockRaw, 'passwordEnv', errors, at),
          expiresInSeconds: numberField(blockRaw, 'expiresInSeconds', errors, at),
        };
        hosts[host] = block;
      } else {
        const block: GithubAppHostConfig = {
          provider: 'github-app',
          allow,
          allowInsecureHttp: booleanField(blockRaw, 'allowInsecureHttp', errors, at),
          clientId: stringField(blockRaw, 'clientId', errors, at),
          appId: stringOrNumberField(blockRaw, 'appId', errors, at),
          privateKeyPath: stringField(blockRaw, 'privateKeyPath', errors, at),
          privateKeyPem: stringField(blockRaw, 'privateKeyPem', errors, at),
          permissions: stringMapField(blockRaw['permissions'], errors, at),
          apiBaseUrl: stringField(blockRaw, 'apiBaseUrl', errors, at),
          apiVersion: stringField(blockRaw, 'apiVersion', errors, at),
          installationCacheSeconds: numberField(blockRaw, 'installationCacheSeconds', errors, at),
          verifyAppPermissions: booleanField(blockRaw, 'verifyAppPermissions', errors, at),
        };
        hosts[host] = block;
      }
    }
  }

  if (errors.length > 0) {
    const error = new Error(`invalid config (${source}):\n - ${errors.join('\n - ')}`);
    error.name = 'ConfigError';
    throw error;
  }

  return {
    socketPath: typeof socketPathRaw === 'string' ? socketPathRaw : '',
    socketMode: typeof socketModeRaw === 'number' ? socketModeRaw : 0o660,
    auditPath: typeof auditRaw === 'string' ? auditRaw : null,
    tokenCacheSkewSeconds: typeof skewRaw === 'number' ? skewRaw : 300,
    hosts,
  };
}

/**
 * Read and validate a configuration file.
 *
 * @param path - path to the JSON config.
 * @returns the validated configuration.
 */
export function loadConfig(path: string): BrokerConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read config ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`config ${path} is not valid JSON: ${(error as Error).message}`);
  }
  return validateConfig(parsed, path);
}
