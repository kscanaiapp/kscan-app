#!/usr/bin/env node
'use strict';

/**
 * Orthogonal change-applicability fields on classify-changed-surfaces.js.
 *
 * WHY THIS EXISTS. stagingImpact/releaseClass answer "is this release
 * content worth running staging validation for at all" and are deliberately
 * blunt on purpose (DEF-REL-005, covered in stagingCertification.test.js): a
 * mobile-only diff is correctly RUNTIME_RELEASE/stagingImpact=true. That same
 * bluntness previously meant security-staging-gate.yml's deploy-staging/
 * staging-health/synthetic-tests jobs ran the real Supabase link/snapshot/
 * deploy pipeline for a pure-mobile PR, even though the deploy scripts always
 * no-op once inside.
 *
 * backendDeploymentRequired/edgeDeploymentRequired/migrationValidationRequired/
 * mobileRuntimeImpact answer a narrower, orthogonal question -- does this
 * diff actually require backend/edge/migration deployment authority -- and
 * are computed to match exactly what deploy-changed-functions.js and
 * apply-candidate-migrations.js act on (supabase/functions/** and
 * supabase/migrations/** only). These tests pin that contract so a future
 * change to the classifier can't silently widen or narrow what authorizes a
 * real staging deployment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'security', 'scripts', 'classify-changed-surfaces.js');

function classify(changedFiles) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, CHANGED_FILES: changedFiles.join(',') },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('mobile-only diff: no backend/edge deployment authority, but mobile runtime impact is true', () => {
  const out = classify(['app/index.tsx', 'components/Foo.tsx', 'ios/Podfile', 'android/app/build.gradle']);
  assert.equal(out.backendDeploymentRequired, false);
  assert.equal(out.edgeDeploymentRequired, false);
  assert.equal(out.migrationValidationRequired, false);
  assert.equal(out.mobileRuntimeImpact, true);
  // Unchanged existing contract: still RUNTIME_RELEASE/stagingImpact=true.
  assert.equal(out.releaseClass, 'RUNTIME_RELEASE');
  assert.equal(out.stagingImpact, true);
});

test('edge-function diff: backend and edge deployment authority both true, no migration, no mobile', () => {
  const out = classify(['supabase/functions/stylist-speech/index.ts']);
  assert.equal(out.backendDeploymentRequired, true);
  assert.equal(out.edgeDeploymentRequired, true);
  assert.equal(out.migrationValidationRequired, false);
  assert.equal(out.mobileRuntimeImpact, false);
});

test('migration diff: backend deployment authority and migration validation both true, edge false', () => {
  const out = classify(['supabase/migrations/20260101000000_add_widget.sql']);
  assert.equal(out.backendDeploymentRequired, true);
  assert.equal(out.edgeDeploymentRequired, false);
  assert.equal(out.migrationValidationRequired, true);
  assert.equal(out.mobileRuntimeImpact, false);
});

test('docs-only diff: every deployment-applicability field is false', () => {
  const out = classify(['docs/some-note.md', 'README.md']);
  assert.equal(out.backendDeploymentRequired, false);
  assert.equal(out.edgeDeploymentRequired, false);
  assert.equal(out.migrationValidationRequired, false);
  assert.equal(out.mobileRuntimeImpact, false);
  // Unchanged existing contract: docs-only stays CONTROL_PLANE_CHANGE.
  assert.equal(out.releaseClass, 'CONTROL_PLANE_CHANGE');
  assert.equal(out.stagingImpact, false);
});

test('a mixed mobile+edge-function diff requires backend deployment authority as well as reporting mobile impact', () => {
  const out = classify(['app/index.tsx', 'supabase/functions/stylist-speech/index.ts']);
  assert.equal(out.backendDeploymentRequired, true);
  assert.equal(out.edgeDeploymentRequired, true);
  assert.equal(out.mobileRuntimeImpact, true);
});

test('backendDeploymentRequired is exactly the union of edgeDeploymentRequired and migrationValidationRequired', () => {
  for (const files of [
    ['app/index.tsx'],
    ['supabase/functions/foo/index.ts'],
    ['supabase/migrations/20260101000000_foo.sql'],
    ['supabase/functions/foo/index.ts', 'supabase/migrations/20260101000000_foo.sql'],
    ['docs/readme-note.md'],
    ['server.js'],
  ]) {
    const out = classify(files);
    assert.equal(
      out.backendDeploymentRequired,
      out.edgeDeploymentRequired || out.migrationValidationRequired,
      `mismatch for ${files.join(',')}`,
    );
  }
});

test('server.js/services/** (the separate Render backend) does not grant backend deployment authority', () => {
  // deploy-changed-functions.js and apply-candidate-migrations.js only ever
  // select from supabase/functions/** and supabase/migrations/** respectively
  // -- security-staging-gate.yml's deploy-staging job never touches the
  // Render backend, so backendDeploymentRequired must not be tripped by it.
  const out = classify(['server.js', 'services/someBackendThing.js']);
  assert.equal(out.backendDeploymentRequired, false);
  assert.equal(out.edgeDeploymentRequired, false);
  assert.equal(out.migrationValidationRequired, false);
});

// Note: an empty CHANGED_FILES list is deliberately not exercised here. The
// script treats an empty string as "unset" (`process.env.CHANGED_FILES ?
// ... : gitDiffFiles(...)`, and '' is falsy), so it would fall through to a
// live `git diff` against this repo's real history rather than testing an
// actually-empty file list -- a pre-existing quirk of the script's env-var
// contract, not something introduced or in scope for this change.
