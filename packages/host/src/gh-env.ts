/**
 * The two gh token families and the host classification that chooses between them.
 *
 * Github.com and GitHub Enterprise Cloud (`*.ghe.com`) use `GH_TOKEN`/`GITHUB_TOKEN`; GitHub
 * Enterprise Server uses `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`.
 */

const DOT_COM_TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const
const ENTERPRISE_TOKEN_KEYS = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const

/** Whether the host uses the github.com token family, including Enterprise Cloud. */
export function dotComHost(host: string): boolean {
  const lower = host.toLowerCase()
  return lower === 'github.com' || lower.endsWith('.ghe.com')
}

/** The token environment variables gh reads for one host. */
export function tokenKeys(host: string): readonly [string, string] {
  return dotComHost(host) ? DOT_COM_TOKEN_KEYS : ENTERPRISE_TOKEN_KEYS
}

/** Remove every inherited gh token, leaving the config directory or a new token to decide. */
export function clearInheritedTokens(env: NodeJS.ProcessEnv): void {
  for (const key of [...DOT_COM_TOKEN_KEYS, ...ENTERPRISE_TOKEN_KEYS]) {
    delete env[key]
  }
}

/** Put one token in the variable gh reads for that host. */
export function setHostToken(env: NodeJS.ProcessEnv, host: string, token: string): void {
  clearInheritedTokens(env)
  env[tokenKeys(host)[0]] = token
}
