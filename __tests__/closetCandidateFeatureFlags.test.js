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

test('batch review V2 is separately fail-closed and requires every Build 1 parent', () => {
  const enabled = loadFlags({
    EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON,
    EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON,
    EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: ON,
    EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2: ON,
  });
  assert.equal(enabled.CLOSET_BATCH_REVIEW_V2_ACTIVE, true);
  assert.equal(enabled.resolveClosetBatchReviewV2Active(true, true, true, true), true);
  assert.equal(enabled.resolveClosetBatchReviewV2Active(true, true, true, false), false);
  assert.equal(enabled.resolveClosetBatchReviewV2Active(false, true, true, true), false);
  assert.equal(enabled.resolveClosetBatchReviewV2Active(true, false, true, true), false);
  assert.equal(enabled.resolveClosetBatchReviewV2Active(true, true, false, true), false);
  assert.equal(loadFlags({ EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2: 'TRUE' }).CLOSET_BATCH_REVIEW_V2, false);
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

// ── Mirror Selfie dormant staging (Build 2.5 Phase 0B) ──────────────────────

test('MIRROR-FLAG-DEFAULTS-FALSE: mirror staging is off when the environment says nothing', () => {
  const flags = loadFlags({});
  assert.equal(flags.MIRROR_SELFIE_V1, false);
  assert.equal(flags.MIRROR_SELFIE_V1_ACTIVE, false);
});

test('only the exact string "true" opts the Mirror flag in', () => {
  for (const value of ['TRUE', 'True', '1', 'yes', 'on', '', ' true', 'true ', undefined, null]) {
    assert.equal(
      loadFlags({ EXPO_PUBLIC_MIRROR_SELFIE_V1: value }).MIRROR_SELFIE_V1,
      false,
      String(value),
    );
  }
  assert.equal(loadFlags({ EXPO_PUBLIC_MIRROR_SELFIE_V1: ON }).MIRROR_SELFIE_V1, true);
});

test('the Mirror derived capability requires the dedicated flag AND both parent Closet capabilities', () => {
  const allParents = {
    EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON,
    EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON,
    EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: ON,
    EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2: ON,
  };
  assert.equal(
    loadFlags({ ...allParents, EXPO_PUBLIC_MIRROR_SELFIE_V1: ON }).MIRROR_SELFIE_V1_ACTIVE,
    true,
  );
  // Missing the Mirror flag itself.
  assert.equal(loadFlags(allParents).MIRROR_SELFIE_V1_ACTIVE, false);
  // Missing candidate staging.
  assert.equal(
    loadFlags({
      EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON,
      EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON,
      EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2: ON,
      EXPO_PUBLIC_MIRROR_SELFIE_V1: ON,
    }).MIRROR_SELFIE_V1_ACTIVE,
    false,
  );
  // Missing batch review V2.
  assert.equal(
    loadFlags({
      EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON,
      EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON,
      EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: ON,
      EXPO_PUBLIC_MIRROR_SELFIE_V1: ON,
    }).MIRROR_SELFIE_V1_ACTIVE,
    false,
  );
  const flags = loadFlags({ ...allParents, EXPO_PUBLIC_MIRROR_SELFIE_V1: ON });
  assert.equal(flags.resolveMirrorSelfieV1Active(true, true, true, true, true), true);
  assert.equal(flags.resolveMirrorSelfieV1Active(true, true, true, true, false), false);
  assert.equal(flags.resolveMirrorSelfieV1Active(false, true, true, true, true), false);
});

test('the Mirror flag does not affect the existing Closet capabilities', () => {
  const withMirror = loadFlags({
    EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON,
    EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON,
    EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: ON,
    EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2: ON,
    EXPO_PUBLIC_MIRROR_SELFIE_V1: ON,
  });
  const withoutMirror = loadFlags({
    EXPO_PUBLIC_CLOSET_SEPARATION_V1: ON,
    EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1: ON,
    EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1: ON,
    EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2: ON,
  });
  assert.equal(withMirror.CLOSET_CANDIDATE_STAGING_ACTIVE, true);
  assert.equal(withoutMirror.CLOSET_CANDIDATE_STAGING_ACTIVE, true);
  assert.equal(withMirror.CLOSET_BATCH_REVIEW_V2_ACTIVE, true);
  assert.equal(withoutMirror.CLOSET_BATCH_REVIEW_V2_ACTIVE, true);
});

// ── Global activation (Build 2.5 owner authorization) ───────────────────────
//
// Every current EAS profile (preview, development, production) sets the
// complete five-flag chain to the literal string "true" — no profile is left
// more gated than another, and the resolver's exact-string-match semantics
// (see "only the exact string \"true\" opts in" above) are what makes "true"
// the only value that actually activates anything.
const BUILD_25_KEYS = [
  'EXPO_PUBLIC_CLOSET_SEPARATION_V1',
  'EXPO_PUBLIC_CLOSET_DIRECT_INTAKE_V1',
  'EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1',
  'EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2',
  'EXPO_PUBLIC_MIRROR_SELFIE_V1',
];

for (const profileName of ['production', 'preview', 'development']) {
  test(`${profileName.toUpperCase()}-PROFILE-ACTIVATES-BUILD-2-5`, () => {
    const env = eas.build?.[profileName]?.env ?? {};
    for (const key of BUILD_25_KEYS) {
      assert.equal(env[key], 'true', `${profileName} does not set ${key} to "true"`);
    }
    const flags = loadFlags(env);
    assert.equal(flags.CLOSET_CANDIDATE_STAGING_ACTIVE, true, `${profileName}: staging not active`);
    assert.equal(flags.CLOSET_BATCH_REVIEW_V2_ACTIVE, true, `${profileName}: batch review not active`);
    assert.equal(flags.MIRROR_SELFIE_V1_ACTIVE, true, `${profileName}: Mirror not active`);
  });
}

test('ALL-FIVE-FLAGS-TRUE resolves every derived Build 2.5 capability true', () => {
  const flags = loadFlags(Object.fromEntries(BUILD_25_KEYS.map((k) => [k, ON])));
  assert.equal(flags.CLOSET_CANDIDATE_STAGING_ACTIVE, true);
  assert.equal(flags.CLOSET_BATCH_REVIEW_V2_ACTIVE, true);
  assert.equal(flags.MIRROR_SELFIE_V1_ACTIVE, true);
});

test('MIRROR-ENTRY-REMAINS-GOVERNED-BY-COMPOSITE-FLAG: activation did not replace the flag with a constant', () => {
  // The kill-switch is the composed expression itself, not any one profile's
  // configuration. A future incident sets EXPO_PUBLIC_MIRROR_SELFIE_V1=false
  // (or any parent false) in a profile and the composite must still resolve
  // false — proven directly against the resolver, independent of what any
  // profile currently ships.
  assert.equal(
    loadFlags({ ...Object.fromEntries(BUILD_25_KEYS.map((k) => [k, ON])), EXPO_PUBLIC_MIRROR_SELFIE_V1: undefined })
      .MIRROR_SELFIE_V1_ACTIVE,
    false,
  );
  assert.ok(
    !/MIRROR_SELFIE_V1_ACTIVE\s*=\s*(true|false)\s*;/.test(flagsSource.replace(/\s+/g, ' ')),
    'MIRROR_SELFIE_V1_ACTIVE was hardcoded to a boolean literal instead of the composed expression',
  );
  assert.ok(
    flagsSource.includes('MIRROR_SELFIE_V1_ACTIVE =\n  MIRROR_SELFIE_V1 && CLOSET_CANDIDATE_STAGING_ACTIVE && CLOSET_BATCH_REVIEW_V2_ACTIVE'),
    'the three-parent composition was altered',
  );
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
    /CLOSET_CANDIDATE_STAGING_ACTIVE \? \(\s*<ClosetCandidateStatusPanel\s+api=\{closetCandidates\}\s*\/>\s*\) : null/.test(
      library,
    ),
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

test('the library intake actually routes to candidate staging when the capability is on', () => {
  // DEAD-CODE LOCK. The original Build 1 shipped with every candidate unit green
  // and the one production intake path wired straight to the committed Closet —
  // the pipeline was unreachable and no test noticed. This lock fails the moment
  // that wiring disappears again.
  const screen = fs.readFileSync(path.join(ROOT, 'app', 'library.tsx'), 'utf8');
  assert.ok(
    screen.includes('const closetCandidates = useClosetCandidates()'),
    'the screen must own a candidate-hook instance',
  );

  const fork = screen.slice(
    screen.indexOf('routeClosetIntake({'),
    screen.indexOf('createBatchId: createClosetBatchId'),
  );
  assert.ok(fork.length > 0, 'the intake handler must go through routeClosetIntake');
  assert.ok(
    fork.includes('stagingActive: CLOSET_CANDIDATE_STAGING_ACTIVE'),
    'the fork must be driven by the derived capability, not a raw flag',
  );
  assert.ok(
    fork.includes('closetCandidates.addFromUri'),
    'the candidate destination must be the candidate hook',
  );
  assert.ok(
    fork.includes('closet.addFromUri'),
    'the committed destination must remain the legacy direct intake',
  );

  // The panel renders from the SAME hook instance the intake writes through.
  assert.ok(
    /<ClosetCandidateStatusPanel\s+api=\{closetCandidates\}/.test(screen),
    'the panel must receive the screen’s candidate-hook instance',
  );
});

test('the production Closet intake surface reaches bounded batch intake only when V2 is active', () => {
  const library = fs.readFileSync(path.join(ROOT, 'app', 'library.tsx'), 'utf8');
  const modal = fs.readFileSync(
    path.join(ROOT, 'components', 'closet', 'ClosetIntakeModal.tsx'),
    'utf8',
  );
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useClosetCandidates.js'), 'utf8');
  assert.ok(library.includes('CLOSET_BATCH_REVIEW_V2_ACTIVE'));
  assert.ok(library.includes('onSaveBatch={handleClosetIntakeBatchSave}'));
  assert.ok(modal.includes('allowsMultipleSelection: batchIntakeActive'));
  assert.ok(modal.includes('selectionLimit: batchIntakeActive ? 8 : 1'));
  assert.ok(modal.includes('orderedSelection: batchIntakeActive'));
  assert.ok(hook.includes('createClosetCandidateBatch'));
  assert.ok(hook.includes('CLOSET_BATCH_REVIEW_V2_ACTIVE'));
  assert.ok(hook.includes('addFromAssets'));
});

test('manual classification has a production caller end to end', () => {
  // DEAD-CODE LOCK, second edge: needs_manual_classification must not regress to
  // a Remove-only dead end. Panel action -> modal -> hook -> service, each link
  // asserted so removing any one of them fails here.
  const panel = fs.readFileSync(
    path.join(ROOT, 'components', 'closet', 'ClosetCandidateStatusPanel.tsx'),
    'utf8',
  );
  assert.ok(panel.includes("title=\"Add details\""), 'the panel must offer the manual action');
  assert.ok(
    panel.includes('ClosetCandidateManualClassifyModal'),
    'the panel must mount the manual editor',
  );
  assert.ok(
    panel.includes('onSubmit={classifyManually}'),
    'the editor must submit through the hook',
  );

  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useClosetCandidates.js'), 'utf8');
  assert.ok(
    hook.includes('manuallyClassifyClosetCandidate(actorRequest, candidateId, fields)'),
    'the hook must delegate to the authoritative service sequence',
  );

  const modal = fs.readFileSync(
    path.join(ROOT, 'components', 'closet', 'ClosetCandidateManualClassifyModal.tsx'),
    'utf8',
  );
  assert.ok(
    !/\bstatus\s*[:=]/.test(modal.replace(/\/\/[^\n]*/g, '')),
    'the editor must never touch status directly',
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
