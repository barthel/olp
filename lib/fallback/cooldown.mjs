/**
 * lib/fallback/cooldown.mjs — per-account cool-down after a limit hit (issue #75)
 *
 * When a hop that names an account fails with a usage-limit error, the engine
 * marks (provider, account) as cooling down and skips that hop for later
 * requests until the cool-down ends. State is in memory only: a restart
 * forgets it, and the next limit hit sets it again.
 *
 * The duration is a fixed configurable window (routing.account_cooldown_seconds,
 * default 300). The real reset time of a limit is not parsed from the CLI
 * error because no verified transcript of that message exists yet.
 */

export const DEFAULT_ACCOUNT_COOLDOWN_MS = 300_000;

/** @type {Map<string, number>} key "provider#account" -> epoch ms when the cool-down ends */
const cooldowns = new Map();

const keyOf = (provider, account) => `${provider}#${account}`;

/**
 * Marks (provider, account) as cooling down. A later end time is never
 * shortened by an earlier call.
 *
 * @returns {number} epoch ms when the cool-down ends
 */
export function markAccountCooldown(provider, account, durationMs = DEFAULT_ACCOUNT_COOLDOWN_MS, now = Date.now()) {
  const key = keyOf(provider, account);
  const until = Math.max(cooldowns.get(key) ?? 0, now + durationMs);
  cooldowns.set(key, until);
  return until;
}

/**
 * @returns {number|null} epoch ms when the cool-down ends, or null when the
 *   account is not cooling down (expired entries are dropped).
 */
export function accountCooldownUntil(provider, account, now = Date.now()) {
  const key = keyOf(provider, account);
  const until = cooldowns.get(key);
  if (until === undefined) return null;
  if (until <= now) {
    cooldowns.delete(key);
    return null;
  }
  return until;
}

/** @internal test seam */
export function __resetAccountCooldowns() {
  cooldowns.clear();
}

/**
 * Heuristic: does this error look like a usage or rate limit of the account?
 * Applied only to hops that name an account. The patterns are NOT verified
 * against real limit transcripts of the CLIs (ALIGNMENT.md Rules 1-3 need
 * those); they cover the wording of the documented limit messages and HTTP
 * 429. Errors about auth, timeouts and concurrency never count.
 *
 * @param {Error|null|undefined} err
 * @returns {boolean}
 */
export function isAccountLimitError(err) {
  if (!err) return false;
  if (err.code === 'AUTH_MISSING' || err.code === 'SPAWN_TIMEOUT' || err.code === 'CONCURRENCY_LIMIT') return false;
  if (err.statusCode === 429 || err.status === 429) return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return /(usage|rate|session|weekly|5-hour|five[- ]hour)\s+limit|limit\s+(reached|exceeded)|quota\s+(exceeded|exhausted)|too many requests|\b429\b/i.test(msg);
}
