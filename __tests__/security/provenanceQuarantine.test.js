#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  STAGING_DEPLOYMENT_ALLOWLIST,
  PROVENANCE_EXCEPTIONS_PATH,
  loadQuarantinedSlugs,
  filterToApproved,
} = require('../../security/scripts/staging-deployment-allowlist');

const exceptions = JSON.parse(fs.readFileSync(PROVENANCE_EXCEPTIONS_PATH, 'utf8'));
const QUARANTINED = ['privacy-controls', 'public-sale-share-opt-out', 'product-match'];

test('every unverified live Edge Function is quarantined', () => {
  assert.deepEqual(loadQuarantinedSlugs().sort(), [...QUARANTINED].sort());
});

test('a quarantined function is refused even when it is on the allowlist', () => {
  // Simulates the exact latent hazard this quarantine exists to close: someone
  // recovers the source, the changed-function detector sees a new directory, and
  // an allowlist entry would otherwise deploy an unverified bundle over a live,
  // privacy-relevant function.
  const allowlistIncludingQuarantined = [...STAGING_DEPLOYMENT_ALLOWLIST, 'privacy-controls'];
  const { approved, heldBack, quarantined } = filterToApproved(
    ['privacy-controls', 'stylechat-generate'],
    allowlistIncludingQuarantined,
  );
  assert.deepEqual(quarantined, ['privacy-controls']);
  assert.equal(approved.includes('privacy-controls'), false);
  assert.equal(heldBack.includes('privacy-controls'), false);
  assert.deepEqual(approved, ['stylechat-generate']);
});

test('quarantined functions are absent from the deployment allowlist', () => {
  for (const slug of QUARANTINED) {
    assert.equal(
      STAGING_DEPLOYMENT_ALLOWLIST.includes(slug),
      false,
      `${slug} has unproven provenance and must not be on the CI deployment allowlist`,
    );
  }
});

test('nothing is lost: approved + heldBack + quarantined reconstruct the manifest', () => {
  const manifest = ['privacy-controls', 'product-match', 'stylechat-generate', 'tryon-clothes-pro'];
  const { approved, heldBack, quarantined } = filterToApproved(manifest);
  assert.deepEqual([...approved, ...heldBack, ...quarantined].sort(), [...manifest].sort());
});

test('an unreadable quarantine file fails closed rather than deploying blind', () => {
  const missing = path.join(os.tmpdir(), 'kscan-no-such-quarantine.json');
  assert.throws(() => loadQuarantinedSlugs(missing), /refusing to deploy/);
});

test('quarantine records carry the evidence needed to act on them', () => {
  assert.equal(exceptions.staging_project_ref, 'yzqjvdfgefveprobvvyw');
  assert.notEqual(exceptions.staging_project_ref, exceptions.production_project_ref_blocked);
  assert.equal(exceptions.functions.length, 3);

  for (const fn of exceptions.functions) {
    assert.ok(fn.slug, 'slug required');
    assert.ok(fn.live_function_id, `${fn.slug} needs the live function id`);
    assert.equal(typeof fn.live_version, 'number');
    assert.equal(typeof fn.verify_jwt, 'boolean');
    assert.ok(fn.live_bundle_sha256, `${fn.slug} needs the live bundle hash`);
    assert.equal(fn.deployment_policy, 'DO_NOT_REDEPLOY');
    assert.equal(fn.modification_policy, 'SOURCE_RECOVERY_REQUIRED');
    assert.equal(fn.security_status, 'DEPLOYMENT_UNVERIFIED');
    assert.ok(fn.reason_not_closed && fn.reason_not_closed.length > 40, `${fn.slug} needs a substantive reason`);
  }
});

test('issue #46 functions are recorded against the issue and are not silently closed', () => {
  const issue46 = exceptions.functions.filter((fn) => fn.issue === 46).map((fn) => fn.slug).sort();
  assert.deepEqual(issue46, ['privacy-controls', 'public-sale-share-opt-out']);
  assert.ok(Array.isArray(exceptions.closure_criteria_for_issue_46));
  assert.ok(exceptions.closure_criteria_for_issue_46.length >= 2);
});

test('the publicly invocable quarantined functions are flagged as such', () => {
  const publicFns = exceptions.functions.filter((fn) => fn.verify_jwt === false);
  for (const fn of publicFns) {
    assert.equal(fn.publicly_invocable, true, `${fn.slug} has verify_jwt=false and must be flagged publicly_invocable`);
  }
  assert.deepEqual(publicFns.map((fn) => fn.slug).sort(), ['product-match', 'public-sale-share-opt-out']);
});

test('recovered source locations are recorded precisely enough to re-fetch', () => {
  const recovered = exceptions.functions.filter((fn) => fn.source_status.startsWith('RECOVERED'));
  assert.equal(recovered.length, 2);
  for (const fn of recovered) {
    assert.ok(fn.source_location.repository, `${fn.slug} needs a source repository`);
    assert.match(fn.source_location.git_blob, /^[0-9a-f]{40}$/, `${fn.slug} needs a git blob id`);
    assert.equal(typeof fn.source_location.committed_to_a_branch, 'boolean');
  }
});

test('a recovered-but-uncommitted source is not treated as durable', () => {
  const pc = exceptions.functions.find((fn) => fn.slug === 'privacy-controls');
  assert.equal(pc.source_status, 'RECOVERED_NOT_DURABLE');
  assert.equal(pc.source_location.committed_to_a_branch, false);
  // Recovery alone must never relax the deployment policy.
  assert.equal(pc.deployment_policy, 'DO_NOT_REDEPLOY');
});

test('quarantine and parity manifest agree on which functions lack repo source', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'security', 'staging', 'staging-state-manifest.json'),
    'utf8',
  ));
  const unsourced = manifest.edge_functions.filter((fn) => !fn.repo_source).map((fn) => fn.id).sort();
  assert.deepEqual(unsourced, [...QUARANTINED].sort(),
    'the parity manifest and the provenance quarantine must not disagree');
});
