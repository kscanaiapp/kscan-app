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
// The live diff check runs too, on a branch that is actually VTO-scoped work
// (see "VTO live-diff lane applicability" below). It is not the only
// assertion here on purpose: a guard that can only be proven by the diff it
// was written against is a guard that proves nothing -- which is also why the
// manifest/matcher/protected-path controls above keep running on every
// branch regardless of lane applicability.

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

// ── VTO live-diff lane applicability ────────────────────────────────────────
//
// The two tests below diff this branch against the VTO integration base and
// refuse any changed path the manifest does not authorize. That is only a
// meaningful question on a branch that is actually VTO-scoped work. Every
// branch in this repository normally has the integration ref available
// (`resolveBaseRef()` below resolves in almost any checkout), so "a base ref
// resolved" was never a signal that THIS branch is VTO work -- it just meant
// the diff ran, judged an unrelated branch's own files against the VTO
// manifest, and failed them for it.
//
// Lane membership is decided here, before the base ref even matters. An
// explicit operator override wins outright:
//
//   KSCAN_VTO_SCOPE_LIVE_DIFF=1   force the live diff on, any branch
//   KSCAN_VTO_SCOPE_LIVE_DIFF=0   force the live diff off, any branch
//
// Absent that, the branch name decides -- read from whichever source actually
// has it: GitHub Actions' own `GITHUB_HEAD_REF` (the PR's source branch, only
// set on `pull_request` events) first, then `GITHUB_REF_NAME` (set on
// `push`), then the local checkout's current branch as a fallback for running
// this file by hand. `isVtoLiveDiffApplicable` takes all of that as plain
// arguments rather than reading `process.env` itself, so every branch of the
// decision -- including this repair's own non-VTO branch -- is unit-tested
// below without mutating process state.

const VTO_BRANCH_TOKEN_PATTERN = /(^|[^a-z0-9])vto([^a-z0-9]|$)/i;
const VTO_BRANCH_PHRASE_PATTERN = /virtual[-_]try[-_]on/i;

// Deliberately conservative: a bare `vto` TOKEN (bounded by the start/end of
// the branch name or a non-alphanumeric separator), or the explicit
// `virtual-try-on` / `virtual_try_on` phrase. A loose substring match on
// "vto" would risk matching an unrelated branch name that merely contains
// those three letters in sequence inside a longer word.
function branchLooksLikeVtoLane(branchName) {
  if (!branchName) return false;
  return VTO_BRANCH_TOKEN_PATTERN.test(branchName) || VTO_BRANCH_PHRASE_PATTERN.test(branchName);
}

/**
 * Pure decision: should the live branch-vs-base diff run on this execution?
 * Returns `{ applicable, reason }` -- the reason is surfaced in the test skip
 * message so a run explains itself instead of silently doing nothing.
 */
function isVtoLiveDiffApplicable({
  explicitFlag,
  githubHeadRef,
  githubRefName,
  localBranch,
} = {}) {
  if (explicitFlag === '1') {
    return {
      applicable: true,
      reason: 'KSCAN_VTO_SCOPE_LIVE_DIFF=1 forces the live diff on for this execution',
    };
  }
  if (explicitFlag === '0') {
    return {
      applicable: false,
      reason: 'KSCAN_VTO_SCOPE_LIVE_DIFF=0 forces the live diff off for this execution',
    };
  }

  const branch = githubHeadRef || githubRefName || localBranch || '';
  if (!branch) {
    return {
      applicable: false,
      reason:
        'no branch name could be determined (no GITHUB_HEAD_REF, no GITHUB_REF_NAME, ' +
        'and no local branch)',
    };
  }
  if (branchLooksLikeVtoLane(branch)) {
    return { applicable: true, reason: `branch "${branch}" looks like a VTO lane` };
  }
  return { applicable: false, reason: `branch "${branch}" is not a VTO lane` };
}

function currentLocalBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function resolveLiveDiffApplicability() {
  return isVtoLiveDiffApplicable({
    explicitFlag: process.env.KSCAN_VTO_SCOPE_LIVE_DIFF,
    githubHeadRef: process.env.GITHUB_HEAD_REF,
    githubRefName: process.env.GITHUB_REF_NAME,
    localBranch: currentLocalBranch(),
  });
}

test('applicability: research branches (quality lab, performance lab) are NOT VTO lanes', () => {
  assert.equal(
    isVtoLiveDiffApplicable({ githubHeadRef: 'research/fashion-match-quality-lab-v1' }).applicable,
    false,
  );
  assert.equal(
    isVtoLiveDiffApplicable({ githubHeadRef: 'research/curiosity-gap-performance-v1' }).applicable,
    false,
  );
});

test('applicability: branch names carrying vto / virtual-try-on ARE VTO lanes', () => {
  assert.equal(
    isVtoLiveDiffApplicable({ githubHeadRef: 'feature/vto-phase4-2-catalog-addressability' })
      .applicable,
    true,
  );
  assert.equal(
    isVtoLiveDiffApplicable({ githubHeadRef: 'feature/virtual-try-on-native' }).applicable,
    true,
  );
  assert.equal(isVtoLiveDiffApplicable({ githubHeadRef: 'repair/vto-provider' }).applicable, true);
  assert.equal(isVtoLiveDiffApplicable({ githubHeadRef: 'research/vto-live' }).applicable, true);
});

test('applicability: unrelated branch names, including this repair\'s own branch, are NOT VTO lanes', () => {
  for (const branch of [
    'fix/scope-guard-lane-gating',
    'feature/closet-intelligence',
    'integration/backend-kplus-complimentary-staging-v1',
  ]) {
    assert.equal(isVtoLiveDiffApplicable({ githubHeadRef: branch }).applicable, false, branch);
  }
});

test('applicability: an explicit override wins regardless of branch name', () => {
  assert.equal(
    isVtoLiveDiffApplicable({
      explicitFlag: '1',
      githubHeadRef: 'research/curiosity-gap-performance-v1',
    }).applicable,
    true,
    'KSCAN_VTO_SCOPE_LIVE_DIFF=1 must force the diff on for a non-VTO branch',
  );
  assert.equal(
    isVtoLiveDiffApplicable({
      explicitFlag: '0',
      githubHeadRef: 'feature/vto-phase4-2-catalog-addressability',
    }).applicable,
    false,
    'KSCAN_VTO_SCOPE_LIVE_DIFF=0 must force the diff off for a VTO branch',
  );
});

test('applicability: GITHUB_HEAD_REF wins over GITHUB_REF_NAME, which wins over the local branch', () => {
  assert.equal(
    isVtoLiveDiffApplicable({
      githubHeadRef: 'feature/vto-phase4',
      githubRefName: 'merge',
      localBranch: 'fix/scope-guard-lane-gating',
    }).applicable,
    true,
  );
  assert.equal(
    isVtoLiveDiffApplicable({
      githubRefName: 'feature/vto-phase4',
      localBranch: 'fix/scope-guard-lane-gating',
    }).applicable,
    true,
  );
});

test('applicability: with no branch signal at all, the live diff does not apply -- never a silent pass', () => {
  const result = isVtoLiveDiffApplicable({});
  assert.equal(result.applicable, false);
  assert.match(result.reason, /no branch name could be determined/);
});

function resolveBaseRef() {
  for (const candidate of [
    'origin/integration/backend-kplus-complimentary-staging-v1',
    'integration/backend-kplus-complimentary-staging-v1',
    'f2ef091aae0f270a8b966dc03d7c18198070b42f',
  ]) {
    try {
      execFileSync('git', ['rev-parse', '--verify', `${candidate}^{commit}`], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return candidate;
    } catch {
      // Try the next.
    }
  }
  return null;
}

test('guard: this branch\'s actual diff stays inside the boundary', (t) => {
  const applicability = resolveLiveDiffApplicability();
  if (!applicability.applicable) {
    // Not silently passed, not silently skipped either: the skip message
    // names the exact reason, so a run explains why the live diff did not
    // execute. The static controls above ran regardless.
    t.skip(`NOT A VTO LANE -- ${applicability.reason}`);
    return;
  }
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    // A shallow CI checkout with no integration ref cannot run this. Skipping
    // is reported, never silently passed -- and the boundary logic above ran
    // regardless, so this file still asserts something either way.
    t.skip('no base ref available in this checkout');
    return;
  }
  const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const changed = output ? output.split('\n').filter(Boolean) : [];
  const { patterns } = guard.parseAuthorizedPatterns(manifest);
  const { unauthorized } = guard.classifyChangedPaths(changed, patterns);
  assert.deepEqual(
    unauthorized,
    [],
    'this lane touched a path the manifest does not authorize',
  );
});

test('guard: the generative backend was read, never written', (t) => {
  const applicability = resolveLiveDiffApplicability();
  if (!applicability.applicable) {
    t.skip(`NOT A VTO LANE -- ${applicability.reason}`);
    return;
  }
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    t.skip('no base ref available in this checkout');
    return;
  }
  const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const changed = output ? output.split('\n').filter(Boolean) : [];
  const backendTouches = changed.filter(
    (file) => file.startsWith('supabase/') || file === 'eas.json' || file === 'app.json',
  );
  assert.deepEqual(
    backendTouches,
    [],
    'GENERATIVE BACKEND MUTATION must be NO, and no EAS/app config may change',
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
