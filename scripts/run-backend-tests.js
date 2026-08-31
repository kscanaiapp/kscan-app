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
 * `--allow-read`, `--allow-env`, and `--allow-run` are required and load-bearing:
 * several tests read their own function source to assert wiring, exercise env
 * flag overrides, and launch the nested `deno check` compile gate. Without
 * those grants Deno fails the suite for permissions reasons that look exactly
 * like product regressions.
 *
 * `--allow-env` is required for the same reason: the commerce funnel suites set
 * and restore provider-key and feature-flag env vars to exercise flag-on and
 * flag-off behaviour. Denied, they fail as `NotCapable`, which reads exactly
 * like a behavioural regression and hides nine real invariants -- including the
 * MODE B image-payload and provider-privacy checks.
 *
 * `--allow-run=deno` is scoped deliberately to the Deno binary alone. Exactly one
 * test needs it: the typecheck gate that shells out to `deno check` to prove the
 * Edge Function still compiles. Blanket `--allow-run` is not granted.
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
/**
 * `vto-generate` joined in VTO Alpha Foundation 01, and it was a decision: it
 * is the only place a generation provider is ever called, it holds the
 * identity / kill-switch / K+ / eligibility chain, and its guards are only
 * meaningful if they actually run. Registering it here is what makes
 * `npm run test:backend` cover them.
 */
const GOVERNED = [
  'scan-identify',
  'stylechat-generate',
  'style-outfit-generate',
  'commerce-watch-refresh',
  'vto-generate',
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

const result = spawnSync('deno', ['test', '--allow-read', '--allow-env', '--allow-run=deno', ...found], {
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
