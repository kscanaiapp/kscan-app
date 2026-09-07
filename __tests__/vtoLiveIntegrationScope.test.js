// P3-C scope guard: the mutation boundary this lane is allowed to touch.
//
// WHY THE GUARD ITSELF IS TESTED. The research lanes enforced "no production
// VTO path may change" mechanically. P3-C deliberately reverses that rule, and
// the honest way to reverse it is to replace a blanket denial with a narrow,
// justified allow-list -- not to delete the protection. That only works if the
// replacement actually refuses something, so the matcher and the manifest
// parser are exercised against paths that MUST be rejected, not just against
// the ones this branch happens to touch.
//
// The live diff check runs too, on a lane that has explicitly declared itself
// a VTO enforcement lane. It is not the only assertion here on purpose: a
// guard that can only be proven by the diff it was written against is a guard
// that proves nothing -- which is also why the static half above keeps running
// on branches the live half does not apply to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const guard = require('../scripts/check-vto-live-integration-scope.js');
const manifest = fs.readFileSync(path.join(ROOT, guard.MANIFEST), 'utf8');

// ── The manifest parses, and every row carries its justification ────────────

test('manifest: the authorized-path table parses with no missing justification', () => {
  const { patterns, problems } = guard.parseAuthorizedPatterns(manifest);
  assert.deepEqual(problems, [], 'every row needs a path, a reason and an authority');
  assert.ok(patterns.length >= 10, 'the boundary is declared, not empty');
});

test('manifest: a row with no reason or no authority is REFUSED', () => {
  // The control is that a path cannot be authorized by being appended to a
  // list -- it has to acquire a justification.
  const noReason = [
    '| AUTHORIZED PATH | WHY MUTATION IS REQUIRED | SOURCE AUTHORITY |',
    '| --- | --- | --- |',
    '| `services/vto/**` |  | Amendment §4 |',
  ].join('\n');
  assert.ok(guard.parseAuthorizedPatterns(noReason).problems.length > 0);

  const noAuthority = [
    '| AUTHORIZED PATH | WHY MUTATION IS REQUIRED | SOURCE AUTHORITY |',
    '| --- | --- | --- |',
    '| `services/vto/**` | because I said so |  |',
  ].join('\n');
  assert.ok(guard.parseAuthorizedPatterns(noAuthority).problems.length > 0);
});

test('manifest: a malformed path cell is reported rather than silently skipped', () => {
  const malformed = [
    '| AUTHORIZED PATH | WHY MUTATION IS REQUIRED | SOURCE AUTHORITY |',
    '| --- | --- | --- |',
    '| services/vto/** | no backticks | Amendment §4 |',
  ].join('\n');
  const { patterns, problems } = guard.parseAuthorizedPatterns(malformed);
  assert.equal(patterns.length, 0);
  assert.ok(problems.some((p) => p.includes('backtick')));
});

// ── The matcher ─────────────────────────────────────────────────────────────

test('matcher: `**` covers a subtree, a bare path is exact', () => {
  assert.equal(guard.matchesPattern('services/vto/vtoLiveCapability.ts', 'services/vto/**'), true);
  assert.equal(guard.matchesPattern('services/vto/nested/deep.ts', 'services/vto/**'), true);
  assert.equal(guard.matchesPattern('services/kplus/kplusClient.ts', 'services/vto/**'), false);

  assert.equal(guard.matchesPattern('types/vto.ts', 'types/vto.ts'), true);
  assert.equal(guard.matchesPattern('types/vtoLive.ts', 'types/vto.ts'), false);

  assert.equal(guard.matchesPattern('hooks/useVirtualTryOn.ts', 'hooks/useVirtualTryOn*'), true);
  assert.equal(guard.matchesPattern('hooks/useCloset.js', 'hooks/useVirtualTryOn*'), false);
});

// ── The guard REFUSES the protected subsystems ─────────────────────────────

test('guard: the protected boundaries are rejected by the real manifest', () => {
  const { patterns } = guard.parseAuthorizedPatterns(manifest);
  // Amendment §5: these remain mechanically protected. If any of them ever
  // matched, this lane's scope claim would be false.
  const protectedPaths = [
    'supabase/functions/vto-generate/index.ts',
    'supabase/functions/vto-generate/vtoHandler.ts',
    'supabase/functions/vto-generate/providers/aiLabToolsProvider.ts',
    'supabase/migrations/20260830174616_vto_feature_control.sql',
    'components/ProductShelf.tsx',
    'components/scan-results/types.ts',
    'services/commerceDestination.ts',
    'hooks/useCloset.js',
    'hooks/usePrivateDressingRoom.ts',
    'hooks/useKPlusEntitlement.ts',
    'services/kplus/kplusEntitlementStore.ts',
    'app/index.js',
    'server.js',
    'eas.json',
    '.github/workflows/security-code.yml',
    '.github/workflows/staging-controlled-deploy.yml',
    'scripts/deploy-edge-functions.js',
    'android/app/build.gradle',
    'app.json',
  ];
  const { unauthorized } = guard.classifyChangedPaths(protectedPaths, patterns);
  assert.deepEqual(
    unauthorized.sort(),
    [...protectedPaths].sort(),
    'every protected path must be refused by the boundary',
  );
});

test('guard: the paths this lane legitimately touches are accepted', () => {
  const { patterns } = guard.parseAuthorizedPatterns(manifest);
  const lanePaths = [
    'types/vtoLive.ts',
    'types/vto.ts',
    'services/vto/vtoLiveCapability.ts',
    'services/vto/liveVtoNativeModule.ts',
    'hooks/useVirtualTryOn.ts',
    'hooks/useVtoAvailability.ts',
    'hooks/useVtoLiveSession.ts',
    'components/vto/VirtualTryOnSheet.tsx',
    'components/vto/VtoLivePanel.tsx',
    'constants/featureFlags.ts',
    'docs/vto-live-integration-manifest.md',
    'docs/vto-integration-defect-ledger.md',
    'scripts/check-vto-live-integration-scope.js',
    '__tests__/vtoLiveCapabilityRouter.test.js',
    '__tests__/vtoPrivacyAndWiring.test.js',
  ];
  const { unauthorized } = guard.classifyChangedPaths(lanePaths, patterns);
  assert.deepEqual(unauthorized, []);
});

test('guard: authorization is per-path, not per-directory-of-the-repo', () => {
  const { patterns } = guard.parseAuthorizedPatterns(manifest);
  // `services/vto/**` must not accidentally authorize all of `services/`, and
  // `__tests__/vto*` must not authorize every test in the repo.
  const { unauthorized } = guard.classifyChangedPaths(
    ['services/haptics.js', 'services/supabaseClient.js', '__tests__/closetCloudSync.test.js'],
    patterns,
  );
  assert.equal(unauthorized.length, 3);
});

// ── The live diff, on a lane that has DECLARED itself a VTO lane ───────────
//
// Everything above is a policy control about the manifest and the matcher: it
// is true of this repository on every branch, so it runs on every branch. The
// two checks below are different in kind -- they judge one branch's actual
// diff against the VTO integration base authority, which is only a meaningful
// question on a lane derived from, and answerable to, that base.
//
// They used to be run the same way regardless, because the base ref was
// DISCOVERED (first of three candidates that resolved) rather than declared.
// Every branch in this repository contains the VTO integration commit, so
// every branch was judged against the VTO manifest and every non-VTO branch
// failed for its own unrelated work. The discovery list is gone; lane
// membership is now an explicit signal that the VTO workflow declares. See
// scripts/check-vto-live-integration-scope.js and
// __tests__/vtoScopeGuardEnforcementMode.test.js, which proves the signal
// cannot silently degrade to a skip.

/**
 * Shared by both live checks: either the changed paths to judge, or an
 * explicit reason this lane is not judged. Never "the base didn't resolve, so
 * we're fine" -- resolveScopeMode returns FAIL for that on an enforcing lane,
 * and this asserts on it.
 */
function changedPathsForThisLane(t) {
  const mode = guard.resolveScopeMode();

  if (mode.decision === 'SKIP') {
    t.skip(`NOT APPLICABLE — ${mode.reason}`);
    return null;
  }

  assert.notEqual(
    mode.decision,
    'FAIL',
    `VTO scope enforcement is declared but cannot be carried out: ${mode.reason}`,
  );

  return guard.diffChangedPaths(mode.baseRef);
}

test('guard: this branch\'s actual VTO-owned diff stays inside the boundary', (t) => {
  const changed = changedPathsForThisLane(t);
  if (changed === null) return;

  // The VTO-OWNED SUBSET, exactly as the guard script judges it. This
  // assertion is the same question the CLI answers, so it has to be asked the
  // same way -- when it classified the WHOLE diff instead, the workflow's two
  // enforcement steps disagreed with each other on an integration branch: the
  // CLI passed and this test refused the research labs it had just, correctly,
  // declined to judge.
  const { vtoOwned } = guard.partitionByVtoOwnership(changed);
  const { patterns } = guard.parseAuthorizedPatterns(manifest);
  const { unauthorized } = guard.classifyChangedPaths(vtoOwned, patterns);
  assert.deepEqual(
    unauthorized,
    [],
    'this lane touched a VTO path the manifest does not authorize',
  );
});

test('guard: the generative backend was read, never written', (t) => {
  const changed = changedPathsForThisLane(t);
  if (changed === null) return;

  // `supabase/` and `app.json` stay ABSOLUTE: this control's core claim is
  // that a VTO lane does not mutate the generative backend, and nothing has
  // been ruled about that.
  const backendTouches = changed.filter(
    (file) => file.startsWith('supabase/') || file === 'app.json',
  );
  assert.deepEqual(
    backendTouches,
    [],
    'GENERATIVE BACKEND MUTATION must be NO, and app config may not change',
  );

  // `eas.json` is now a NARROW, RULED exception rather than an absolute
  // refusal (OWNER RULING 2026-09-07, Build 35 staging-only Live VTO
  // readiness). The lane wrote the flag, this control and three others
  // refused it, the lane reverted and escalated, and the owner approved
  // enabling `EXPO_PUBLIC_LIVE_VTO_ENABLED` on the existing
  // `staging-certification` profile and nowhere else.
  //
  // THE EXCEPTION IS THE CONTENT, NOT THE FILENAME. Allowing `eas.json`
  // wholesale would retire a control that exists to stop a VTO lane retargeting
  // a backend, changing a release channel, or altering a submit configuration.
  // So the diff of that one file is read and every changed line has to be the
  // one key the ruling names -- anything else in it still fails here.
  if (!changed.includes('eas.json')) return;

  const diff = execFileSync(
    'git',
    ['diff', '--unified=0', `${guard.resolveScopeMode().baseRef}...HEAD`, '--', 'eas.json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const changedLines = diff
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0);

  // Every line the diff touched, added or removed, must be the ruled key --
  // allowing for the trailing comma the previous last entry acquires.
  const RULED = /^"EXPO_PUBLIC_LIVE_VTO_ENABLED": "true",?$/;
  const TRAILING_COMMA_ONLY = /^"KSCAN_VOICE_CERTIFICATION": "true",?$/;
  const offending = changedLines.filter(
    (line) => !RULED.test(line) && !TRAILING_COMMA_ONLY.test(line),
  );
  assert.deepEqual(
    offending,
    [],
    'eas.json is authorized ONLY for the owner-ruled Live VTO staging flag. '
      + 'Any other EAS change -- a backend URL, a release channel, a submit '
      + 'configuration, another feature flag -- is outside that ruling.',
  );

  // And the ruling was staging-certification ONLY. Asserted here as well as in
  // the dedicated environment gate, because a control that trusts another file
  // to have run is not a control.
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  const enabled = Object.entries(eas.build)
    .filter(([, profile]) => (profile.env ?? {}).EXPO_PUBLIC_LIVE_VTO_ENABLED !== undefined)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(
    enabled,
    ['staging-certification'],
    'the Live flag is declared on a profile the owner ruling did not authorize',
  );
});

test('guard: the research workspace is not a dependency of the app', () => {
  // PRs #291 and #295 are evidence authorities. Their package tree must not
  // reach the production bundle, and nothing in the app may import it.
  //
  // Scanned as CODE, not as text. This codebase documents what it deliberately
  // does NOT do, so a naive search finds the very words a comment exists to
  // disclaim -- types/vtoLive.ts names the research workspace precisely to say
  // it is not a dependency -- and reports the discipline as a violation of
  // itself. The house convention (vtoPrivacyAndWiring.test.js) is to strip
  // comments first, and then look for a real import or require.
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const IMPORTS_RESEARCH = /(?:from|require\()\s*['"][^'"]*kscan-live-vto[^'"]*['"]/;

  const appDirs = ['components', 'hooks', 'services', 'types', 'constants', 'app'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        if (IMPORTS_RESEARCH.test(stripComments(fs.readFileSync(full, 'utf8')))) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    }
  };
  for (const dir of appDirs) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  assert.deepEqual(offenders, [], 'no app module may import the research workspace');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of Object.keys(allDeps)) {
    assert.ok(!name.startsWith('@kscan-live-vto/'), `${name} must not be an app dependency`);
  }

  // The detector is proven to detect. A comment-stripping absence check that
  // strips too eagerly would pass over a real import and report nothing --
  // which is indistinguishable from success.
  assert.ok(
    IMPORTS_RESEARCH.test(
      stripComments("import { BodyFrame } from '@kscan-live-vto/contract';"),
    ),
    'the detector must catch a real research import',
  );
  assert.ok(
    !IMPORTS_RESEARCH.test(stripComments('// kscan-live-vto/ is not a dependency of this app')),
    'the detector must not fire on prose that says so',
  );
});
