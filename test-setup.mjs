/**
 * test-setup.mjs — isolates test-features.mjs from the operator's real home.
 *
 * Must be the FIRST import of test-features.mjs. ESM evaluates imports in
 * order, so this runs before server.mjs reads its startup config through
 * os.homedir() (lib/fallback/engine.mjs defaultConfigPath, lib/keys.mjs,
 * lib/audit.mjs, lib/providers/anthropic.mjs). On POSIX os.homedir() honours
 * $HOME, so a temp HOME hides ~/.olp/config.json (accounts, chains) and
 * ~/.claude credentials from the suite.
 *
 * lib/accounts.mjs keychainEnv() still resolves the real home through
 * userInfo() on purpose (macOS keychain lookup); tests cover that separately.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_HOME = mkdtempSync(join(tmpdir(), 'olp-test-realhome-'));
process.env.HOME = TEST_HOME;

process.on('exit', () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // best-effort; do not throw at exit
  }
});
