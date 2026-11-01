/**
 * lib/accounts.mjs — account resolution for multi-account-per-provider (issue #75)
 *
 * Config shape (~/.olp/config.json):
 *
 *   "providers": {
 *     "anthropic": {
 *       "accounts": {
 *         "work": { "dir": "/absolute/path/to/credential/dir" }
 *       }
 *     }
 *   }
 *
 * `dir` is the credential directory of one login of that provider's CLI. Its
 * layout mirrors what the plugin's ISOLATION.accountCredentialMounts expects
 * (anthropic: <dir>/.credentials.json; codex: <dir>/auth.json). OLP never
 * writes into it; the spawn sees it only through the ephemeral home.
 *
 * A hop `{ provider, model, account }` selects one of these entries. A hop
 * without `account` keeps using the operator's default login (unchanged).
 */

import { isAbsolute } from 'node:path';
import { ProviderError } from './providers/base.mjs';

/**
 * Reads the per-provider account map out of a parsed config.json `providers`
 * object. Entries that are not objects with a string `dir` are dropped.
 *
 * @param {object|undefined} providers — parsed config.providers
 * @returns {Record<string, Record<string, { dir: string }>>}
 */
export function extractAccounts(providers) {
  const out = {};
  if (!providers || typeof providers !== 'object') return out;
  for (const [providerName, providerCfg] of Object.entries(providers)) {
    const accounts = providerCfg?.accounts;
    if (!accounts || typeof accounts !== 'object') continue;
    const valid = {};
    for (const [accountId, entry] of Object.entries(accounts)) {
      if (entry && typeof entry.dir === 'string' && entry.dir !== '') {
        valid[accountId] = { dir: entry.dir };
      }
    }
    if (Object.keys(valid).length > 0) out[providerName] = valid;
  }
  return out;
}

/**
 * Resolves the credential directory for (provider, account).
 *
 * Throws ProviderError AUTH_MISSING when the account is not configured or its
 * dir is not absolute. AUTH_MISSING is not a fallback trigger (ADR 0004): a
 * misconfigured account must surface instead of being masked by the next hop.
 *
 * @param {{ accounts?: Record<string, Record<string, { dir: string }>> }|null|undefined} config
 * @param {string} provider
 * @param {string} account
 * @returns {string} absolute directory path
 */
export function resolveAccountDir(config, provider, account) {
  const entry = config?.accounts?.[provider]?.[account];
  if (!entry || typeof entry.dir !== 'string' || entry.dir === '') {
    throw new ProviderError(
      `Account "${account}" is not configured for provider "${provider}" ` +
      `(expected providers.${provider}.accounts.${account}.dir in config.json)`,
      'AUTH_MISSING',
    );
  }
  if (!isAbsolute(entry.dir)) {
    throw new ProviderError(
      `Account "${account}" of provider "${provider}": dir must be an absolute path, got "${entry.dir}"`,
      'AUTH_MISSING',
    );
  }
  return entry.dir;
}
