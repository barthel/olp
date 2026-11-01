/**
 * lib/fallback/cooldown.mjs — per-account cool-down after a limit hit (issue #75)
 *
 * When a hop that names an account fails with a usage-limit error, the engine
 * marks (provider, account) as cooling down and skips that hop for later
 * requests until the cool-down ends. State is in memory only: a restart
 * forgets it, and the next limit hit sets it again.
 *
 * Duration: when the plugin attached the reset time of the limit (err.limit.
 * resetsAtMs, taken from the claude rate_limit_event), the cool-down runs until
 * then, capped at MAX_ACCOUNT_COOLDOWN_MS. Otherwise a fixed configurable
 * window applies (routing.account_cooldown_seconds, default 300).
 */

export const DEFAULT_ACCOUNT_COOLDOWN_MS = 300_000;
/** Upper bound for a cool-down derived from a reported reset time (8 days). */
export const MAX_ACCOUNT_COOLDOWN_MS = 8 * 24 * 3600 * 1000;

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

/**
 * Cool-down duration for a limit error: until the reset time the plugin
 * reported (err.limit.resetsAtMs) when that lies in the future, else the
 * fallback window.
 *
 * @param {Error|null|undefined} err
 * @param {number} fallbackMs
 * @param {number} [now]
 * @returns {number} duration in ms
 */
export function accountCooldownDurationMs(err, fallbackMs = DEFAULT_ACCOUNT_COOLDOWN_MS, now = Date.now()) {
  const resetsAtMs = err?.limit?.resetsAtMs;
  if (Number.isFinite(resetsAtMs) && resetsAtMs > now) {
    return Math.min(resetsAtMs - now, MAX_ACCOUNT_COOLDOWN_MS);
  }
  return fallbackMs;
}

/** @internal test seam */
export function __resetAccountCooldowns() {
  cooldowns.clear();
}

/**
 * Does this error mean a usage or rate limit of the account? Applied only to
 * hops that name an account.
 *   1. err.limit set: the anthropic plugin saw a rate_limit_event with status
 *      'rejected' (observed in real transcripts; the CLI then exits 1 with
 *      unrelated or empty stderr). This is the reliable signal.
 *   2. Otherwise a text heuristic for other providers: HTTP 429 and the
 *      wording of documented limit messages. Not verified against real
 *      transcripts of those CLIs (ALIGNMENT.md Rules 1-3).
 * Errors about auth, timeouts and concurrency never count.
 *
 * @param {Error|null|undefined} err
 * @returns {boolean}
 */
export function isAccountLimitError(err) {
  if (!err) return false;
  if (err.code === 'AUTH_MISSING' || err.code === 'SPAWN_TIMEOUT' || err.code === 'CONCURRENCY_LIMIT') return false;
  if (err.limit) return true;
  if (err.statusCode === 429 || err.status === 429) return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return /(usage|rate|session|weekly|5-hour|five[- ]hour)\s+limit|limit\s+(reached|exceeded)|quota\s+(exceeded|exhausted)|too many requests|\b429\b/i.test(msg);
}
