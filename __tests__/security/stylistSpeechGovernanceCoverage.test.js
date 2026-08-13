'use strict';

/**
 * stylist-speech source/runtime governance coverage.
 *
 * THE DEFECT THIS PINS. stylist-speech was classified GOVERNED in
 * security/release/edge-function-governance.json, yet it appeared in neither
 * config/edge-function-manifest.json nor STAGING_DEPLOYMENT_ALLOWLIST. Those
 * two omissions compounded into a silent failure: PR #141 raised the spoken
 * text bound from 700 to 1000 characters, the changed-function detector saw
 * the edit, the deploy step refused it for want of an allowlist entry and
 * reported NO_CHANGED_FUNCTIONS, and verify:edge-parity stayed green because
 * the function had no hashes to compare. Staging served the old bound for a
 * day with every gate reporting success.
 *
 * Two independent properties close it, and this file asserts both:
 *   1. CONTENT COVERAGE - the function is content-hashed by the parity
 *      manifest, so source changes that are not regenerated fail the gate;
 *   2. DEPLOY REACHABILITY - the function is allow-listed, so a source change
 *      actually reaches staging instead of being silently skipped.
 *
 * Coverage without reachability still lets the runtime drift. Reachability
 * without coverage still lets an unhashed bundle ship. Neither alone is enough.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GOVERNED_FUNCTIONS } = require('../../scripts/edge-function-manifest-lib.js');
const { STAGING_DEPLOYMENT_ALLOWLIST } = require('../../security/scripts/staging-deployment-allowlist.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SLUG = 'stylist-speech';

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'edge-function-manifest.json'), 'utf8'));
}

function readGovernance() {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'security', 'release', 'edge-function-governance.json'), 'utf8'),
  );
}

test('governance: stylist-speech is classified GOVERNED', () => {
  const governance = readGovernance();
  assert.equal(governance.functions[SLUG].class, 'GOVERNED');
});

// ── 1. Content coverage ────────────────────────────────────────────────────

test('coverage: stylist-speech is in the governed manifest function list', () => {
  assert.ok(GOVERNED_FUNCTIONS.includes(SLUG), `${SLUG} must be governed by the parity manifest`);
});

test('coverage: the committed manifest carries a stylist-speech bundle entry', () => {
  const manifest = readManifest();
  assert.ok(manifest.parity.expectedFunctions.includes(SLUG));
  const entry = manifest.parity.functions.find((fn) => fn.name === SLUG);
  assert.ok(entry, 'the manifest must contain a stylist-speech entry');
  assert.equal(entry.entry, 'supabase/functions/stylist-speech/index.ts');
  assert.ok(entry.bundleHash && entry.bundleHash.length === 64, 'a real bundle hash is required');
  assert.ok(entry.treeHash && entry.treeHash.length === 64, 'a real tree hash is required');
  assert.ok(entry.bundleFileCount > 0);
});

test('coverage: the exact file that drifted is hashed in the bundle', () => {
  // speechText.ts carries MAX_SPEECH_CHARACTERS. It is the file whose change
  // merged and never deployed, so it is the one that must be hash-covered.
  const manifest = readManifest();
  const entry = manifest.parity.functions.find((fn) => fn.name === SLUG);
  const speechText = entry.files.find((f) => f.path === 'supabase/functions/stylist-speech/speechText.ts');
  assert.ok(speechText, 'speechText.ts must be in the manifest file list');
  assert.equal(speechText.bundle, true, 'speechText.ts must be part of the deployable bundle');
  assert.ok(speechText.sha256 && speechText.sha256.length === 64);
});

test('coverage: the manifest hash for speechText.ts matches the working tree', () => {
  const crypto = require('node:crypto');
  const manifest = readManifest();
  const entry = manifest.parity.functions.find((fn) => fn.name === SLUG);
  for (const file of entry.files) {
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(REPO_ROOT, file.path)))
      .digest('hex');
    assert.equal(actual, file.sha256, `${file.path} drifted from the manifest`);
  }
});

test('coverage: the source speech bound is the Build 29 value, and is hashed', () => {
  // A regression to 700 in source would change speechText.ts's sha256 and fail
  // the manifest gate above. This asserts the value itself so the intent is
  // legible rather than encoded only as a hash.
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'supabase', 'functions', 'stylist-speech', 'speechText.ts'),
    'utf8',
  );
  const bound = Number(/MAX_SPEECH_CHARACTERS\s*=\s*(\d+)/.exec(source)[1]);
  assert.equal(bound, 1000, 'the spoken bound must match the reply bound repaired in PR #141');
});

// ── 2. Deploy reachability ─────────────────────────────────────────────────

test('reachability: stylist-speech is approved for automatic staging deployment', () => {
  assert.ok(
    STAGING_DEPLOYMENT_ALLOWLIST.includes(SLUG),
    'stylist-speech must be allow-listed, or a source change is silently skipped by the deploy step',
  );
});

// Content-governed functions that are deliberately NOT auto-deployed. Each is
// an owner decision with a reason, not an oversight — and writing them down is
// the point: a function that is hash-governed but unreachable can have its
// source repaired, merged, and gated green while staging keeps running the old
// bundle. That is precisely how the stylist-speech 700/1000 drift survived.
const DEPLOY_REACHABILITY_EXCEPTIONS = {
  'scan-identify': 'Not a resumed first deployment; see the notes in staging-deployment-allowlist.js.',
  // Found by this test on 2026-08-13 while closing the stylist-speech gap.
  // Not silently added to the allowlist: allow-listing a function changes what
  // CI will deploy on its next source change, which is a deploy-authority
  // decision the owner makes deliberately, one reviewable line at a time.
  'style-outfit-generate':
    'KNOWN GAP, OWNER DECISION PENDING. Content-governed since Build 3 Phase 4 but never allow-listed, '
    + 'so a source change to it would merge and gate green without reaching staging — the same failure mode '
    + 'as stylist-speech. Add it to STAGING_DEPLOYMENT_ALLOWLIST to close, or record an explicit decision to '
    + 'keep it manually deployed.',
};

test('reachability: every manifest-governed function is deploy-reachable or a recorded exception', () => {
  // The compound property, stated once. A future function added to the parity
  // manifest but not the allowlist reproduces exactly this defect, and must
  // either be made reachable or be written down here as a decision.
  for (const slug of GOVERNED_FUNCTIONS) {
    if (DEPLOY_REACHABILITY_EXCEPTIONS[slug]) continue;
    assert.ok(
      STAGING_DEPLOYMENT_ALLOWLIST.includes(slug),
      `${slug} is content-governed but not deploy-reachable — source changes would not reach staging. `
        + 'Allow-list it, or record it in DEPLOY_REACHABILITY_EXCEPTIONS with a reason.',
    );
  }
});

test('reachability: the exception list never grows silently', () => {
  // Pinned so adding an exception is a visible, reviewed diff rather than a
  // quiet way to opt out of the reachability rule.
  assert.deepEqual(
    Object.keys(DEPLOY_REACHABILITY_EXCEPTIONS).sort(),
    ['scan-identify', 'style-outfit-generate'],
  );
  assert.ok(
    !Object.keys(DEPLOY_REACHABILITY_EXCEPTIONS).includes(SLUG),
    'stylist-speech must be genuinely reachable, never excepted',
  );
});

test('reachability: stylist-speech is not quarantined', () => {
  const { loadQuarantinedSlugs } = require('../../security/scripts/staging-deployment-allowlist.js');
  assert.ok(!loadQuarantinedSlugs().includes(SLUG), 'a quarantined slug can never be deployed');
});
