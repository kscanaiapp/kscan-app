'use strict';

/**
 * Guardrail authority regression test — prefix semantics, not existence
 * semantics.
 *
 * WHY THIS EXISTS. The isolated Live VTO program branches from `master`
 * (688dc35), and the protected-path validator diffs against `origin/master`.
 * But the current governed VTO authority lives on
 * `integration/backend-kplus-complimentary-staging-v1`, and those two
 * histories share NO common ancestor — `git merge-base origin/master
 * <integration>` exits 1. Six of the seven VTO authority paths
 * (components/vto/, hooks/useVirtualTryOn.ts, hooks/useVtoAvailability.ts,
 * services/vto/, types/vto.ts, supabase/functions/vto-generate/) therefore
 * do not exist anywhere in the baseline this branch is compared against.
 * Only eas.json does.
 *
 * That could invite a wrong conclusion — "those files aren't in our diff
 * base, so the guardrail can't be protecting them." This test pins the
 * opposite, which is what the guardrail actually does: protection is decided
 * by PATH PREFIX, so `components/vto/anything.tsx` is blocked by the
 * `components/` entry whether or not that file has ever existed on any
 * branch the validator can see.
 *
 * Every path below is SYNTHETIC INPUT to the classifier. No production file
 * is created, modified, or read to run this test — per the standing rule
 * that this program may read production paths but never mutate them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { classifyPath, config } = require(path.resolve(__dirname, '..', '..', 'tools', 'validate-protected-paths.js'));

/**
 * The current VTO authority surface, as enumerated by the program owner.
 * These are real paths on the integration branch; here they are used only as
 * strings.
 */
const VTO_AUTHORITY_PATHS = [
  'components/vto/TryItOnEntry.tsx',
  'components/vto/VirtualTryOnSheet.tsx',
  'hooks/useVirtualTryOn.ts',
  'hooks/useVtoAvailability.ts',
  'services/vto/vtoClient.ts',
  'types/vto.ts',
  'supabase/functions/vto-generate/index.ts',
  'eas.json',
];

test('every current VTO authority path is blocked by a protected prefix', () => {
  for (const file of VTO_AUTHORITY_PATHS) {
    assert.equal(
      classifyPath(file),
      'blocked',
      `${file} must be blocked by the protected-path guardrail`,
    );
  }
});

test('a file that never existed on the master baseline is still blocked (prefix, not existence)', () => {
  // Deliberately invented filenames. None of these exist on master, on the
  // integration branch, or in this workspace — which is the point: the
  // guardrail must not depend on a file being present in the diff base to
  // protect the tree it lives in.
  const inventedIntegrationLineFiles = [
    'components/vto/SomeFileThatDoesNotExist.tsx',
    'services/vto/anotherInventedModule.ts',
    'supabase/functions/vto-generate/handlers/inventedHandler.ts',
    'hooks/useSomeVtoHookThatDoesNotExist.ts',
  ];

  for (const file of inventedIntegrationLineFiles) {
    assert.equal(
      classifyPath(file),
      'blocked',
      `${file} must be blocked even though it exists on no branch`,
    );
  }
});

test('the isolated workspace itself stays writable', () => {
  assert.equal(classifyPath('kscan-live-vto/packages/evaluation/src/index.ts'), 'allowed:workspace');
  assert.equal(classifyPath('kscan-live-vto/tools/protected-paths.json'), 'allowed:workspace');
});

test('the program\'s own allow-listed docs stay writable, and only those', () => {
  assert.equal(classifyPath('docs/vto-phase1-status.md'), 'allowed:exception');
  assert.equal(classifyPath('docs/vto-visual-verdicts.md'), 'allowed:exception');

  // A docs/ file that is NOT on the exception list must be blocked. This is
  // the check that actually fired in CI when
  // docs/vto-physical-device-blockers.md was first added without its
  // allow-list entry.
  assert.equal(classifyPath('docs/some-other-teams-document.md'), 'blocked');
  assert.equal(classifyPath('docs/README.md'), 'blocked');
});

test('CI and deploy configuration outside the one additive workflow is blocked', () => {
  assert.equal(classifyPath('.github/workflows/live-vto-protected-paths.yml'), 'allowed:exception');
  assert.equal(classifyPath('.github/workflows/master-required-checks.yml'), 'blocked');
  assert.equal(classifyPath('.github/workflows/staging-controlled-deploy.yml'), 'blocked');
});

test('the exception list never contains a bare directory prefix', () => {
  // ALLOWED_EXCEPTIONS is matched by exact string equality
  // (isExplicitException uses Array.includes). A trailing-slash entry would
  // therefore silently never match, giving a false sense of a carve-out —
  // or, if the matcher were ever changed to prefix semantics, would widen
  // the carve-out to a whole tree. Neither should pass review unnoticed.
  for (const entry of config.ALLOWED_EXCEPTIONS) {
    assert.ok(!entry.endsWith('/'), `ALLOWED_EXCEPTIONS entry "${entry}" must be an exact file path, not a prefix`);
  }
});

test('protected prefixes still cover every tree the VTO authority surface lives in', () => {
  // Guards against an entry being dropped from PROTECTED during an unrelated
  // edit. Each of these must remain present for the assertions above to mean
  // anything.
  for (const required of ['components/', 'hooks/', 'services/', 'types/', 'supabase/', 'app/', '.github/', 'docs/']) {
    assert.ok(
      config.PROTECTED.includes(required),
      `PROTECTED must still contain "${required}"`,
    );
  }
});
