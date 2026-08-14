#!/usr/bin/env node
/**
 * Governed Edge Function test runner (Deno).
 *
 * WHY THIS EXISTS: `scripts/run-all-tests.js` discovers `__tests__/**.test.js` and
 * runs them under `node --test`. The Edge Functions are Deno modules with `.ts`
 * import specifiers and Deno globals, so their tests cannot run under Node and
 * were therefore not covered by any npm script — they had to be remembered and
 * invoked by hand, which is exactly how a suite stops being run.
 *
 * This registers them. Discovery is done here in Node rather than delegated to a
 * shell glob, for the same portability reason the Node runner gives: `**` is not
 * portable across cmd.exe / PowerShell / bash.
 *
 * `--allow-read` is required and load-bearing: several of these tests read their
 * own function's source to assert wiring (that `index.ts` calls a particular
 * validator, for instance). Without it Deno denies the read and the test fails
 * for a permissions reason that looks exactly like a real regression.
 *
 * `--allow-env` is required by the account-deletion suites: the shared deletion
 * helpers resolve `ACCOUNT_RESTORATION_BASE_URL` at call time. It grants no
 * network reach.
 *
 * No network permission is granted. These suites are deterministic: no Supabase,
 * no provider call, no live model.
 *
 * Usage:  node scripts/run-backend-tests.js [functionDir ...]
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'supabase', 'functions');
const TEST_SUFFIX = '.test.ts';

/**
 * The governed identification/styling closures.
 *
 * Deliberately an explicit list, not "every directory under functions/". A new
 * function appearing should be a decision to include it, not an accident of
 * directory layout — and the release gates speak about these by name.
 *
 * `style-outfit-generate` was added in Build 3 Phase 4, and it was a decision:
 * it hosts the versioned private Dressing Room contract, it is deployed
 * (project wyyuqfdxucjksghsmhry, ACTIVE), and it had no backend coverage at all
 * before that phase. Discovery also found its `index.ts` had drifted between the
 * platform branches while nothing in the repository objected — precisely the
 * Phase 2A failure this list exists to prevent.
 */
const GOVERNED = [
  'scan-identify',
  'stylechat-generate',
  'style-outfit-generate',
  // Build 29 account-deletion lifecycle. Added deliberately: this function
  // creates the `deactivated` state and the restoration token, so its ordering
  // invariant (hash persisted before the link is mailed) and its
  // no-raw-token-anywhere property are release-blocking and must be gated, not
  // remembered.
  'handle-user-deletion',
  // Build 29 speech. Added deliberately, and late: 75057d1 brought
  // stylist-speech under the parity manifest and deploy coverage and added it
  // to parity.expectedFunctions, but this list was not updated with it — so a
  // governed, deployed function shipped with its Deno suites (handler,
  // speechText, speechCues) discovered by nothing and run by no npm script.
  // That is the exact failure this file's header describes: tests that must be
  // remembered are tests that stop being run. E4.1 makes it load-bearing,
  // because longer room-reasoning answers put real pressure on the spoken
  // bound.
  'stylist-speech',
  // Shared Room image resolution. Also added late, and found the same way: its
  // validation suite covers the bucket allowlist, owner-scoped path contract
  // and the exclusion of detached/deleted/foreign-owner rows — authorization
  // logic for exactly the "images resolve in a shared room" requirement — and
  // none of it was being executed.
  'shared-room-image-url',
  '_shared',
];

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : GOVERNED;

const found = [];
const missing = [];

for (const name of targets) {
  const dir = path.join(FUNCTIONS_DIR, name);
  if (!fs.existsSync(dir)) {
    missing.push(name);
    continue;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
      found.push(path.relative(ROOT, path.join(dir, entry.name)));
    }
  }
}

console.log('─'.repeat(64));
console.log('Backend (Deno) test discovery');
console.log(`Function directories: ${targets.join(', ')}`);
for (const name of missing) console.log(`  ABSENT  ${name} — no such function directory`);
console.log(`Total backend test files: ${found.length}`);
for (const file of found) console.log(`  ${file}`);
console.log('─'.repeat(64));

if (found.length === 0) {
  // Never report a passing backend suite because discovery found nothing.
  console.error('No backend test files discovered — refusing to report a passing suite.');
  process.exit(1);
}

const result = spawnSync('deno', ['test', '--allow-read', '--allow-env', ...found], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`Failed to launch deno: ${result.error.message}`);
  console.error('Install Deno, or run the gate on a machine that has it.');
  process.exit(1);
}

process.exit(result.status == null ? 1 : result.status);
