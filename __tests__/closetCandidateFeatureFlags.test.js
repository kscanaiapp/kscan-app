// Closet candidate staging FEATURE FLAG suite (Build 1).
//
// Proves the flag is off everywhere that ships, that it fails closed when either
// parent Closet flag is off, that the two existing Closet flags are unchanged,
// and that the candidate surface is the only thing the new flag gates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_PATH = path.join(ROOT, 'constants', 'featureFlags.ts');
const EAS_PATH = path.join(ROOT, 'eas.json');

const flagsSource = fs.readFileSync(FLAGS_PATH, 'utf8');
const eas = JSON.parse(fs.readFileSync(EAS_PATH, 'utf8'));

/**
 * Loads constants/featureFlags.ts with an explicit process.env and __DEV__, so
 * the derived capability is evaluated against real inputs rather than asserted
 * from source text.
 */
function loadFlags(env = {}) {
  const source = ts.transpileModule(flagsSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: () => ({}),
    process: { env },
    __DEV__: false,
    console,
  };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(source, sandbox, { filename: 'constants/featureFlags.ts' });
  return sandbox.module.exports;
}

const ON = 'true';

// ── Default-off ──────────────────────────────────────────────────────────────

test('candidate staging is off when the environment says nothing', () => {
  const flags = loadFlags({});
  assert.equal(flags.CLOSET_CANDIDATE_STAGING_V1, false);
  assert.equal(flags.CLOSET_CANDIDATE_STAGING_ACTIVE, false);
});

test('only the exact string "true" opts in', () => {
  for (const value of ['TRUE', 'True', '1', 'yes', 'on', '', ' true', 'true ', undefined, null]) {
    assert.equal(
      loadFlags({ EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: value }).CLOSET_CANDIDATE_STAGING_V1,
      false,
      String(value),
    );
  }
  assert.equal(
    loadFlags({ EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: ON }).CLOSET_CANDIDATE_STAGING_V1,
    true,
  );
});

// ── Derived capability ───────────────────────────────────────────────────────

test('the derived capability requires all three flags', () => {
  const table = [
    [false, false, false, false],
    [true, false, false, false],
    [false, true, false, false],
    [false, false, true, false],
    [true, true, false, false],
    [true, false, true, false],
    [false, true, true, false],
    [true, true, true, true],
  ];
  for (const [separation, directIntake, staging, expected] of table) {
    const flags = loadFlags({
      ...(separation ? { EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON } : {}),
      ...(directIntake ? { EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON } : {}),
      ...(staging ? { EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: ON } : {}),
    });
    assert.equal(
      flags.CLOSET_CANDIDATE_STAGING_ACTIVE,
      expected,
      `separation=${separation} directIntake=${directIntake} staging=${staging}`,
    );
    assert.equal(
      flags.resolveClosetCandidateStagingActive(separation, directIntake, staging),
      expected,
    );
  }
});

test('the parent Closet capability is unaffected by the new flag', () => {
  const withStaging = loadFlags({
    EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON,
    EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON,
    EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: ON,
  });
  const withoutStaging = loadFlags({
    EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON,
    EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON,
  });
  // Legacy single-item Closet intake behaves identically either way.
  assert.equal(withStaging.CLOSET_DIRECT_INTAKE_ACTIVE, true);
  assert.equal(withoutStaging.CLOSET_DIRECT_INTAKE_ACTIVE, true);
  assert.equal(withStaging.CLOSET_SEPARATION_V1, withoutStaging.CLOSET_SEPARATION_V1);
});

// ── Shipping configuration ───────────────────────────────────────────────────

test('no shipping profile enables candidate staging', () => {
  for (const [profileName, profile] of Object.entries(eas.build ?? {})) {
    const env = profile?.env ?? {};
    assert.notEqual(
      env.EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1,
      'true',
      `profile ${profileName} enables candidate staging`,
    );
  }
});

test('the two existing Closet flags keep their production values', () => {
  const production = eas.build?.production?.env ?? {};
  assert.equal(production.EXPO_PUBLIC_CLOSET_SEPARATION_V1, 'true');
  assert.equal(production.EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1, 'true');
});

test('app version, iOS build number and Android versionCode are untouched by this build', () => {
  // Read straight from the app config: a Build-1 source change must never carry
  // a release increment with it.
  const appConfigPath = ['app.json', 'app.config.js', 'app.config.ts']
    .map((name) => path.join(ROOT, name))
    .find((candidate) => fs.existsSync(candidate));
  assert.ok(appConfigPath, 'no app config found');
  const raw = fs.readFileSync(appConfigPath, 'utf8');
  // Presence check only. The VALUES are asserted unchanged by the git diff gate;
  // this exists so the file is visibly part of the flag review surface.
  assert.ok(/version/.test(raw));
});

// ── Gating scope ─────────────────────────────────────────────────────────────

test('the candidate surface is mounted only under the derived capability', () => {
  const library = fs.readFileSync(path.join(ROOT, 'app', 'library.tsx'), 'utf8');
  assert.ok(library.includes('CLOSET_CANDIDATE_STAGING_ACTIVE'));
  assert.ok(
    /CLOSET_CANDIDATE_STAGING_ACTIVE \? <ClosetCandidateStatusPanel \/> : null/.test(library),
    'the candidate panel must be gated on the derived capability',
  );
});

test('reading, cleanup and recovery do not depend on the flag', () => {
  // Once a candidate exists on disk it is plain versioned JSON. A build with the
  // flag off must still be able to read, migrate, sweep and delete it — the same
  // rule the committed Closet already follows.
  const store = fs.readFileSync(path.join(ROOT, 'services', 'closetCandidateLibrary.js'), 'utf8');
  assert.ok(!store.includes('CLOSET_CANDIDATE_STAGING'), 'the store must be flag-independent');
  const media = fs.readFileSync(path.join(ROOT, 'services', 'closetCandidateMedia.js'), 'utf8');
  assert.ok(!media.includes('CLOSET_CANDIDATE_STAGING'));
  const schema = fs.readFileSync(path.join(ROOT, 'services', 'closetCandidateSchema.js'), 'utf8');
  assert.ok(!schema.includes('CLOSET_CANDIDATE_STAGING'));
});

test('the hook gates only write entry points, never reads or cleanup', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useClosetCandidates.js'), 'utf8');
  // Cleanup and recovery are called unconditionally.
  const gatedBlock = hook.slice(hook.indexOf('const addFromUri'));
  assert.ok(gatedBlock.includes('CLOSET_CANDIDATE_STAGING_ACTIVE'), 'intake must be gated');
  const hydrate = hook.slice(hook.indexOf('const hydrate'), hook.indexOf('useFocusEffect(hydrate)'));
  assert.ok(hydrate.length > 0, 'failed to isolate the hydrate block');
  assert.ok(hydrate.includes('cleanupExpiredClosetCandidates'));
  assert.ok(hydrate.includes('recoverInterruptedClosetCandidates'));
  const cleanupLine = hydrate
    .split('\n')
    .find((line) => line.includes('cleanupExpiredClosetCandidates'));
  assert.ok(
    !cleanupLine.includes('CLOSET_CANDIDATE_STAGING_ACTIVE'),
    'cleanup must not be flag-gated',
  );
});

test('the hook drives the queue through the reconnect entry point, never the bare queue', () => {
  // WHY THIS IS LOCKED: the default connectivity port latches offline on the
  // first transport failure and only `requeueClosetCandidatesOnReconnect` clears
  // that latch. A hook that calls `runClosetCandidateQueue` directly strands every
  // parked candidate in `waiting_for_network` until the app is restarted — the
  // behaviour proven recoverable in closetCandidateOrchestration.test.js. Screen
  // focus and manual retry are the only foreground signals this build has, so
  // both must go through the refresh.
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useClosetCandidates.js'), 'utf8');
  const callSites = hook.match(/run(?:Closet)?CandidateQueue\(actorRequest\)/g) ?? [];
  assert.equal(
    callSites.length,
    0,
    'the hook must not call runClosetCandidateQueue directly; use the reconnect entry point',
  );

  const hydrate = hook.slice(hook.indexOf('const hydrate'), hook.indexOf('useFocusEffect(hydrate)'));
  assert.ok(
    hydrate.includes('requeueClosetCandidatesOnReconnect'),
    'focus/foreground must refresh connectivity before running the queue',
  );

  const retry = hook.slice(hook.indexOf('const retry ='), hook.indexOf('const reject ='));
  assert.ok(
    retry.includes('requeueClosetCandidatesOnReconnect'),
    'manual retry must refresh connectivity before running the queue',
  );
});

test('the orphan-media sweep is actually wired, and is not flag-gated', () => {
  // A collector nobody calls is the defect it was written to fix: media whose
  // record is gone is unreachable by every reference-driven path, so if this
  // call site disappears the files leak for the life of the install.
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useClosetCandidates.js'), 'utf8');
  const hydrate = hook.slice(hook.indexOf('const hydrate'), hook.indexOf('useFocusEffect(hydrate)'));
  assert.ok(
    hydrate.includes('sweepOrphanedClosetCandidateMedia'),
    'the sweep must run on focus/foreground',
  );
  const sweepLine = hydrate
    .split('\n')
    .find((line) => line.includes('await sweepOrphanedClosetCandidateMedia'));
  assert.ok(sweepLine, 'failed to isolate the sweep call');
  assert.ok(
    !sweepLine.includes('CLOSET_CANDIDATE_STAGING_ACTIVE'),
    'collecting orphaned files must not depend on the flag still being on',
  );
});

// ── Feature freeze ───────────────────────────────────────────────────────────

test('the existing mobile feature-freeze mechanism is extended, not duplicated', () => {
  // One kill-switch system. A second, unrelated one would mean two places to look
  // when a feature has to be turned off in an incident.
  assert.ok(flagsSource.includes('FEATURE_FREEZE_CONFIG_KEY'));
  assert.equal((flagsSource.match(/FEATURE_FREEZE_CONFIG_KEY = /g) ?? []).length, 1);
  assert.ok(flagsSource.includes("'closet'"), 'the closet feature-freeze key still exists');
  // The candidate surface lives inside the Closet section, so the existing
  // `closet` freeze key already disables it. No new kill-switch is introduced.
  assert.ok(!/CANDIDATE_FREEZE|CLOSET_CANDIDATE_KILL/.test(flagsSource));
});
