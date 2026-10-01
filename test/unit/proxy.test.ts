/**
 * The refusal that replaces a fetch wrapper.
 *
 * Node 24's own fetch reads the proxy variables once `NODE_USE_ENV_PROXY=1`, so this project needs no
 * wrapper — but a deployment with a proxy configured and the variable forgotten would reach GitHub
 * directly and silently. These three cases are the whole contract.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertProxyEnabled } from '../../src/proxy.ts';

describe('refusing a proxy this process would ignore', () => {
  it('says nothing when no proxy is configured, which is the direct case', () => {
    assert.doesNotThrow(() => assertProxyEnabled({}));
  });

  it('says nothing when a proxy is configured and the variable enables it', () => {
    assert.doesNotThrow(() =>
      assertProxyEnabled({ https_proxy: 'http://proxy.invalid:7890', NODE_USE_ENV_PROXY: '1' }, []),
    );
  });

  it('refuses when a proxy is configured and nothing would make fetch use it', () => {
    assert.throws(
      () => assertProxyEnabled({ http_proxy: 'http://proxy.invalid:7890' }, []),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /http_proxy is set/, 'it names the variable it found');
        assert.match(message, /NODE_USE_ENV_PROXY=1/, 'and the setting that fixes it');
        return true;
      },
    );
  });

  it('treats a variable set to nothing as unset', () => {
    assert.doesNotThrow(() => assertProxyEnabled({ https_proxy: '' }));
  });
});
