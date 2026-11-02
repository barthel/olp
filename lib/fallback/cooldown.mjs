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
  lastServed.clear();
}

/** @type {Map<string, { account: string, at: number }>} provider -> account that served the latest request */
const lastServed = new Map();

/**
 * Remembers which account of a provider served the latest request (in memory,
 * like the cool-downs). Hops without account are not recorded.
 */
export function recordAccountServed(provider, account, now = Date.now()) {
  if (typeof account !== 'string' || account === '') return;
  lastServed.set(provider, { account, at: now });
}

/** @returns {{ account: string, at: number }|null} */
export function lastServedAccount(provider) {
  return lastServed.get(provider) ?? null;
}

/**
 * Marks accounts as cooling down at startup when their quota already shows a
 * hit limit, so the first request after a restart does not spend a failing
 * spawn on them. Cool-downs live in memory only and a restart forgets them.
 * Every account is looked up independently; a lookup that fails, or yields no
 * future reset, leaves that account alone.
 *
 * @param {object} args
 * @param {Record<string, Record<string, object>>} args.accounts — provider -> account id -> entry
 * @param {(provider: string, account: string) => Promise<number|null>} args.resolveReset — epoch ms of the reset when the account is at its limit, else null
 * @param {(level: string, event: string, data?: object) => void} [args.logEvent]
 * @param {number} [args.now]
 * @returns {Promise<Array<{ provider: string, account: string, cooldown_until: number }>>} accounts that were seeded
 */
export async function seedAccountCooldowns({ accounts, resolveReset, logEvent = () => {}, now = Date.now() }) {
  const targets = [];
  for (const [provider, entries] of Object.entries(accounts ?? {})) {
    for (const account of Object.keys(entries ?? {})) targets.push({ provider, account });
  }
  const settled = await Promise.allSettled(targets.map(async ({ provider, account }) => {
    const resetsAtMs = await resolveReset(provider, account);
    if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now) return null;
    const until = markAccountCooldown(provider, account, accountCooldownDurationMs({ limit: { resetsAtMs } }, DEFAULT_ACCOUNT_COOLDOWN_MS, now), now);
    logEvent('info', 'account_cooldown_seeded', { provider, account, cooldown_until: until });
    return { provider, account, cooldown_until: until };
  }));
  return settled.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
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
