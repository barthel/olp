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

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { ProviderError } from './providers/base.mjs';

/**
 * Token source fields of an account entry, in lookup order. The first source
 * that yields a non-empty token wins; the others are fallbacks.
 *   token_file     absolute path to a file holding only the token
 *   token_env      name of an environment variable of the OLP process
 *   token_keychain service name of an OS keychain item (macOS: `security`,
 *                  Linux: `secret-tool lookup service <name>`)
 */
const TOKEN_SOURCE_FIELDS = ['token_file', 'token_env', 'token_keychain'];

/**
 * Environment for the keychain helper. macOS `security` locates the user's
 * keychain through $HOME, so an OLP started with a redirected HOME (test
 * instance, service wrapper) would otherwise look into an empty keychain.
 * The home directory is taken from the user database, not from the env.
 *
 * @internal exported for tests
 */
export function keychainEnv(baseEnv = process.env) {
  let home = baseEnv.HOME;
  try { home = userInfo().homedir || home; } catch { /* keep env HOME */ }
  return { ...baseEnv, HOME: home };
}

function defaultKeychainReader(service) {
  const opts = { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: keychainEnv() };
  try {
    if (process.platform === 'darwin') {
      return execFileSync('security', ['find-generic-password', '-s', service, '-w'], opts).trim();
    }
    return execFileSync('secret-tool', ['lookup', 'service', service], opts).trim();
  } catch {
    return '';
  }
}

let _keychainReader = defaultKeychainReader;

/** @internal test seam: replace the keychain lookup. */
export function __setKeychainReader(fn) { _keychainReader = fn; }
/** @internal */
export function __resetKeychainReader() { _keychainReader = defaultKeychainReader; }

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
        continue;
      }
      const tokenSource = {};
      for (const field of TOKEN_SOURCE_FIELDS) {
        if (entry && typeof entry[field] === 'string' && entry[field] !== '') {
          tokenSource[field] = entry[field];
        }
      }
      if (Object.keys(tokenSource).length > 0) valid[accountId] = tokenSource;
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

/**
 * Resolves the credential source of (provider, account).
 *
 * Entry kinds in config.json:
 *   - { dir }  credential directory of a CLI login (see resolveAccountDir)
 *   - any of { token_file, token_env, token_keychain }: long-lived token, e.g.
 *     the output of `claude setup-token`. Sources are tried in that order and
 *     the first non-empty token wins, so a keychain item can back up a file.
 *     Nothing is cached: replacing the token needs no restart. The token
 *     itself never appears in config.json or in errors.
 *
 * Throws ProviderError AUTH_MISSING for an unknown account, a relative
 * token_file, or when no configured source yields a token.
 *
 * @returns {{ dir: string } | { token: string }}
 */
export function resolveAccount(config, provider, account) {
  const entry = config?.accounts?.[provider]?.[account];
  const configured = TOKEN_SOURCE_FIELDS.filter((f) => typeof entry?.[f] === 'string' && entry[f] !== '');
  if (configured.length === 0) {
    return { dir: resolveAccountDir(config, provider, account) };
  }
  const prefix = `Account "${account}" of provider "${provider}"`;
  if (configured.includes('token_file') && !isAbsolute(entry.token_file)) {
    throw new ProviderError(
      `${prefix}: token_file must be an absolute path, got "${entry.token_file}"`,
      'AUTH_MISSING',
    );
  }
  const tried = [];
  for (const field of configured) {
    let token = '';
    if (field === 'token_file') {
      try { token = readFileSync(entry.token_file, 'utf8').trim(); } catch { token = ''; }
      tried.push(`token_file ${entry.token_file}`);
    } else if (field === 'token_env') {
      token = (process.env[entry.token_env] ?? '').trim();
      tried.push(`token_env ${entry.token_env}`);
    } else {
      try { token = String(_keychainReader(entry.token_keychain) ?? '').trim(); } catch { token = ''; }
      tried.push(`token_keychain "${entry.token_keychain}"`);
    }
    if (token !== '') return { token };
  }
  throw new ProviderError(
    `${prefix}: no token found (tried ${tried.join(', ')}; missing, unreadable or empty)`,
    'AUTH_MISSING',
  );
}
