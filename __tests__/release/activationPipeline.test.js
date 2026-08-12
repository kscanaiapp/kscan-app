#!/usr/bin/env node
'use strict';

/**
 * Phase 2B.3 activation pipeline (DEF-REL-012).
 *
 * Covers the executable control path that Phase 2B lacked: release-metadata
 * writing, the shared immutable deploy core, deployment ordering, the
 * orchestrator's PLAN_ONLY/EXECUTE modes, config-fingerprint identity
 * semantics, and durable baseline persistence + retrieval.
 *
 * No network, no Supabase, no GitHub API: every adapter is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { STAGING_REF, PRODUCTION_REF } = require('../../security/scripts/lib/environment-authority');
const { generateReleaseManifest, freezeManifest } = require('../../security/release/generate-release-manifest');
const { ENV_NAME_ALLOWLIST } = require('../../security/release/config-fingerprint');

const load = (rel) => import(`file://${path.join(REPO_ROOT, rel).split(path.sep).join('/')}`);

const BASE = Object.freeze({
  repoRoot: REPO_ROOT,
  releaseId: 'rel-activation-test',
  sourceSha: 'a'.repeat(40),
  sourceTreeSha: 'b'.repeat(40),
  candidateEnvironment: 'staging',
  candidateProjectRef: STAGING_REF,
  createdAt: '2026-08-12T00:00:00.000Z',
  env: {},
});
const manifest = (o = {}) => generateReleaseManifest({ ...BASE, ...o });

const VALID_FIELDS = Object.freeze({
  releaseId: 'staging-bootstrap-d73ac42-20260812T021103Z',
  sourceSha: 'd'.repeat(40),
  sourceTreeSha: 'e'.repeat(40),
  manifestDigest: 'f'.repeat(64),
  healthContractVersion: 'health-contract-v1',
  deployedAt: '2026-08-12T02:11:03Z',
  environment: 'staging',
});

// ── release metadata writer ──────────────────────────────────────────────────

test('metadata: the allowlist is exactly the seven release-identity keys', async () => {
  const { ALLOWED_METADATA_KEYS, buildMetadataMap } = await load('security/release/set-staging-release-metadata.mjs');
  assert.deepEqual([...ALLOWED_METADATA_KEYS].sort(), [
    'KSCAN_DEPLOYED_AT', 'KSCAN_ENVIRONMENT', 'KSCAN_HEALTH_CONTRACT_VERSION', 'KSCAN_MANIFEST_DIGEST',
    'KSCAN_RELEASE_ID', 'KSCAN_SOURCE_SHA', 'KSCAN_SOURCE_TREE_SHA',
  ]);
  assert.deepEqual(Object.keys(buildMetadataMap(VALID_FIELDS)).sort(), [...ALLOWED_METADATA_KEYS].sort());
});

test('metadata: an unknown eighth key is rejected', async () => {
  const { buildMetadataMap } = await load('security/release/set-staging-release-metadata.mjs');
  assert.throws(
    () => buildMetadataMap({ ...VALID_FIELDS, serviceRoleKey: 'nope' }),
    (e) => e.code === 'UNKNOWN_KEY_REJECTED',
  );
});

test('metadata: the production project is an explicit deny', async () => {
  const { assertStagingTarget, setStagingReleaseMetadata } = await load('security/release/set-staging-release-metadata.mjs');
  assert.throws(() => assertStagingTarget(PRODUCTION_REF), (e) => e.code === 'PRODUCTION_TARGET_REJECTED');
  assert.throws(
    () => setStagingReleaseMetadata({ fields: VALID_FIELDS, projectRef: PRODUCTION_REF, exec: () => { throw new Error('must not run'); } }),
    (e) => e.code === 'PRODUCTION_TARGET_REJECTED',
  );
});

test('metadata: unknown and malformed identity are rejected', async () => {
  const { assertStagingTarget, buildMetadataMap } = await load('security/release/set-staging-release-metadata.mjs');
  assert.throws(() => assertStagingTarget('a'.repeat(20)), (e) => e.code === 'NON_STAGING_TARGET_REJECTED');
  for (const bad of [
    { ...VALID_FIELDS, sourceSha: 'short' },
    { ...VALID_FIELDS, manifestDigest: 'not-a-digest' },
    { ...VALID_FIELDS, releaseId: '' },
    { ...VALID_FIELDS, healthContractVersion: 'made-up' },
    { ...VALID_FIELDS, deployedAt: 'yesterday' },
    { ...VALID_FIELDS, environment: 'production' },
  ]) {
    assert.throws(() => buildMetadataMap(bad), (e) => e.code === 'MALFORMED_METADATA');
  }
});

test('metadata: the access token never appears in argv or output', async () => {
  const mod = await load('security/release/set-staging-release-metadata.mjs');
  let capturedArgs = null;
  let capturedEnvKeys = null;
  mod.setStagingReleaseMetadata({
    fields: VALID_FIELDS,
    env: { SUPABASE_ACCESS_TOKEN: 'sbp_TESTSENTINELNOTAREALTOKEN000000', RUNNER_TEMP: os.tmpdir() },
    exec: (cmd, args, opts) => { capturedArgs = args; capturedEnvKeys = Object.keys(opts.env); return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.ok(!capturedArgs.some((a) => String(a).includes('sbp_')), 'token must never be an argv element');
  assert.ok(capturedEnvKeys.includes('SUPABASE_ACCESS_TOKEN'), 'token reaches the CLI via env only');
  assert.equal(mod.sanitize('leaked sbp_TESTSENTINELNOTAREALTOKEN000000 here'), 'leaked [REDACTED_TOKEN] here');
});

test('metadata: the temp env file is removed after the write', async () => {
  const { setStagingReleaseMetadata } = await load('security/release/set-staging-release-metadata.mjs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-meta-'));
  let seenPath = null;
  setStagingReleaseMetadata({
    fields: VALID_FIELDS,
    env: { SUPABASE_ACCESS_TOKEN: 'sbp_TESTSENTINELNOTAREALTOKEN000000', RUNNER_TEMP: tempRoot },
    exec: (cmd, args) => { seenPath = args[args.indexOf('--env-file') + 1]; return { status: 0 }; },
  });
  assert.ok(seenPath, 'an env file path was passed');
  assert.equal(fs.existsSync(seenPath), false, 'temp env file must be deleted');
  assert.deepEqual(fs.readdirSync(tempRoot), []);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('metadata: planOnly writes nothing', async () => {
  const { setStagingReleaseMetadata } = await load('security/release/set-staging-release-metadata.mjs');
  const result = setStagingReleaseMetadata({
    fields: VALID_FIELDS, planOnly: true,
    exec: () => { throw new Error('planOnly must not execute'); },
  });
  assert.equal(result.written, false);
  assert.deepEqual(result.plan.keys.length, 7);
});

// ── deploy core: immutable source ────────────────────────────────────────────

test('deploy core: the production project is rejected', async () => {
  const { validateDeployInput } = await load('security/release/staging-deploy-core.mjs');
  assert.throws(
    () => validateDeployInput({ functionName: 'scan-identify', manifest: manifest(), candidateRoot: REPO_ROOT, projectRef: PRODUCTION_REF }),
    (e) => e.code === 'PRODUCTION_TARGET_REJECTED',
  );
});

test('deploy core: a source-hash mismatch blocks deployment', async () => {
  const { validateDeployInput } = await load('security/release/staging-deploy-core.mjs');
  const result = validateDeployInput({
    functionName: 'scan-identify', manifest: manifest(), candidateRoot: REPO_ROOT,
    expectedSourceHash: 'f'.repeat(64), projectRef: STAGING_REF,
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.code === 'SOURCE_HASH_MISMATCH'));
});

test('deploy core: a quarantined or ungoverned function cannot deploy', async () => {
  const { validateDeployInput } = await load('security/release/staging-deploy-core.mjs');
  const m = manifest({ liveFunctionNames: ['product-match'] });
  const result = validateDeployInput({ functionName: 'product-match', manifest: m, candidateRoot: REPO_ROOT, projectRef: STAGING_REF });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.code === 'NOT_GOVERNED'));
});

test('deploy core: worktree mutation cannot change the deployed bytes (TOCTOU)', async (t) => {
  const { materializeCandidate, hashDirectory } = await load('security/release/staging-deploy-core.mjs');
  // A throwaway repo so the real worktree is never touched.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-toctou-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'user.name', 'Gate');
  const fnDir = path.join(root, 'supabase', 'functions', 'demo');
  fs.mkdirSync(fnDir, { recursive: true });
  fs.writeFileSync(path.join(fnDir, 'index.ts'), 'export const original = true;\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'candidate');
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const before = materializeCandidate({ repoRoot: root, candidateSha: sha });
  const hashBefore = hashDirectory(path.join(before.root, 'supabase', 'functions', 'demo'));
  before.cleanup();

  // Mutate the worktree AFTER binding — the classic TOCTOU window.
  fs.writeFileSync(path.join(fnDir, 'index.ts'), 'export const tampered = true;\n');

  const after = materializeCandidate({ repoRoot: root, candidateSha: sha });
  const materializedSource = fs.readFileSync(path.join(after.root, 'supabase', 'functions', 'demo', 'index.ts'), 'utf8');
  const hashAfter = hashDirectory(path.join(after.root, 'supabase', 'functions', 'demo'));
  after.cleanup();

  assert.equal(hashAfter, hashBefore, 'materialized candidate must be unaffected by worktree edits');
  assert.match(materializedSource, /original/);
  assert.ok(!/tampered/.test(materializedSource), 'worktree bytes must never reach the deploy input');
});

// ── deployment ordering ──────────────────────────────────────────────────────

test('order: staging-health is always last and the count is not hardcoded', async () => {
  const { partitionBootstrapPlan, HEALTH_FUNCTION } = await load('security/release/run-bootstrap-activation.mjs');
  const p = partitionBootstrapPlan(['scan-identify', HEALTH_FUNCTION, 'stylechat-generate']);
  assert.equal(p.health, HEALTH_FUNCTION);
  assert.ok(!p.nonHealth.includes(HEALTH_FUNCTION));
  assert.equal(p.nonHealth.length, 2);

  const bigger = partitionBootstrapPlan(['a', 'b', 'c', 'd', HEALTH_FUNCTION]);
  assert.equal(bigger.nonHealth.length, 4, 'partition adapts to plan size');
});

test('order: a plan without staging-health blocks', async () => {
  const { partitionBootstrapPlan } = await load('security/release/run-bootstrap-activation.mjs');
  assert.throws(() => partitionBootstrapPlan(['scan-identify']), (e) => e.code === 'HEALTH_FUNCTION_MISSING_FROM_PLAN');
});

test('order: more than one health identity function blocks pending review', async () => {
  const { partitionBootstrapPlan, HEALTH_FUNCTION } = await load('security/release/run-bootstrap-activation.mjs');
  assert.throws(
    () => partitionBootstrapPlan([HEALTH_FUNCTION, HEALTH_FUNCTION]),
    (e) => e.code === 'MULTIPLE_HEALTH_IDENTITY_FUNCTIONS',
  );
});

// ── orchestrator authority + modes ───────────────────────────────────────────

test('orchestrator: EXECUTE is refused outside the governed CI path', async () => {
  const { assertExecuteAuthority } = await load('security/release/run-bootstrap-activation.mjs');
  assert.throws(() => assertExecuteAuthority({}), (e) => e.code === 'EXECUTE_NOT_AUTHORIZED');
  assert.throws(() => assertExecuteAuthority({ GITHUB_ACTIONS: 'true' }), (e) => e.code === 'EXECUTE_NOT_AUTHORIZED');
  assert.throws(() => assertExecuteAuthority({ KSCAN_ACTIVATION_ENVIRONMENT: 'staging' }), (e) => e.code === 'EXECUTE_NOT_AUTHORIZED');
  assert.doesNotThrow(() => assertExecuteAuthority({ GITHUB_ACTIONS: 'true', KSCAN_ACTIVATION_ENVIRONMENT: 'staging' }));
});

test('orchestrator: the production project is rejected before any work', async () => {
  const { runBootstrapActivation } = await load('security/release/run-bootstrap-activation.mjs');
  await assert.rejects(
    () => runBootstrapActivation({ repoRoot: REPO_ROOT, projectRef: PRODUCTION_REF, liveFunctionNames: [], liveMigrationNames: [] }),
    (e) => e.code === 'PRODUCTION_TARGET_REJECTED',
  );
});

test('orchestrator: PLAN_ONLY performs zero writes', async () => {
  const { runBootstrapActivation, MODE } = await load('security/release/run-bootstrap-activation.mjs');
  const m = manifest();
  const live = m.edgeFunctions.map((f) => f.name);

  const result = await runBootstrapActivation({
    repoRoot: REPO_ROOT,
    mode: MODE.PLAN_ONLY,
    liveFunctionNames: live,
    liveMigrationNames: m.migrations.map((x) => x.name),
    deps: {
      deployFn: () => { throw new Error('PLAN_ONLY must not deploy'); },
      setMetadata: (o) => { assert.equal(o.planOnly, true, 'PLAN_ONLY must only plan metadata'); return { plan: { keys: [] } }; },
      github: { createTag: () => { throw new Error('PLAN_ONLY must not tag'); } },
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.equal(result.mutated, false);
  assert.ok(result.plan.deploymentPlan.order.at(-1).includes('staging-health'));
  assert.deepEqual(result.plan.deploymentPlan.migrations, []);
});

test('orchestrator: a prior baseline prevents bootstrap', async () => {
  const { runBootstrapActivation } = await load('security/release/run-bootstrap-activation.mjs');
  const m = manifest();
  const result = await runBootstrapActivation({
    repoRoot: REPO_ROOT,
    liveFunctionNames: m.edgeFunctions.map((f) => f.name),
    liveMigrationNames: m.migrations.map((x) => x.name),
    priorVerifiedRelease: { baseline: {}, evidence: {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BOOTSTRAP_BASELINE_ALREADY_EXISTS');
});

test('orchestrator: a missing governed live function prevents bootstrap', async () => {
  const { runBootstrapActivation } = await load('security/release/run-bootstrap-activation.mjs');
  const m = manifest();
  const live = m.edgeFunctions.map((f) => f.name).filter((n) => n !== 'staging-health');
  const result = await runBootstrapActivation({
    repoRoot: REPO_ROOT, liveFunctionNames: live, liveMigrationNames: m.migrations.map((x) => x.name),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BOOTSTRAP_LIVE_INVENTORY_RECONCILIATION_REQUIRED');
});

test('orchestrator: unsatisfied migration state blocks before deployment', async () => {
  const { runBootstrapActivation } = await load('security/release/run-bootstrap-activation.mjs');
  const m = manifest();
  const result = await runBootstrapActivation({
    repoRoot: REPO_ROOT,
    liveFunctionNames: m.edgeFunctions.map((f) => f.name),
    liveMigrationNames: [], // nothing applied
    deps: { deployFn: () => { throw new Error('must not deploy'); } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MIGRATION_STATE_UNSATISFIED');
});

// ── config fingerprint identity semantics (Part 7) ───────────────────────────

test('fingerprint: the seven KSCAN release-identity keys are NOT identity material', () => {
  const seven = ['KSCAN_RELEASE_ID', 'KSCAN_SOURCE_SHA', 'KSCAN_SOURCE_TREE_SHA',
    'KSCAN_MANIFEST_DIGEST', 'KSCAN_HEALTH_CONTRACT_VERSION', 'KSCAN_DEPLOYED_AT', 'KSCAN_ENVIRONMENT'];
  for (const key of seven) {
    assert.ok(!ENV_NAME_ALLOWLIST.includes(key),
      `${key} must not be in the fingerprint allowlist, or setting metadata would shift identity between plan and execute`);
  }
  // Presence of all seven in the generator env must not move the digest.
  const withoutMeta = manifest({ env: {} });
  const withMeta = manifest({ env: Object.fromEntries(seven.map((k) => [k, 'value'])) });
  assert.equal(withMeta.identityDigest, withoutMeta.identityDigest);
});

test('fingerprint: release metadata VALUES and releaseId are never hashed', () => {
  const a = manifest({ releaseId: 'rel-one' });
  const b = manifest({ releaseId: 'rel-two-totally-different' });
  assert.equal(a.identityDigest, b.identityDigest, 'releaseId is observational');
  assert.equal(a.configFingerprint, b.configFingerprint);
});

test('fingerprint: governed config structure IS still identity material', () => {
  // KSCAN_DEPLOY_VERSION is allowlisted (legacy). Its presence must move the
  // digest — which is exactly why the orchestrator must not introduce it into
  // the generator environment between PLAN_ONLY and EXECUTE.
  assert.ok(ENV_NAME_ALLOWLIST.includes('KSCAN_DEPLOY_VERSION'));
  const without = manifest({ env: {} });
  const with_ = manifest({ env: { KSCAN_DEPLOY_VERSION: 'x' } });
  assert.notEqual(with_.identityDigest, without.identityDigest);
});

// ── persistence + retrieval ──────────────────────────────────────────────────

function fakeGithub() {
  const state = { tags: new Map(), releases: new Map(), assets: new Map() };
  return {
    state,
    createTag: async ({ tag, sha }) => { state.tags.set(tag, sha); },
    createRelease: async ({ tag }) => { state.releases.set(tag, true); },
    uploadAsset: async ({ tag, name, body }) => { state.assets.set(`${tag}/${name}`, body); },
    getAsset: async ({ tag, name }) => {
      const key = `${tag}/${name}`;
      if (!state.assets.has(key)) throw new Error(`no asset ${key}`);
      return state.assets.get(key);
    },
    resolveTagCommit: async ({ tag }) => state.tags.get(tag),
    listTags: async () => [...state.tags.keys()].map((t) => ({ tag: t })),
  };
}

test('persistence: the staging tag is distinctive and anchored to the candidate', async () => {
  const { buildStagingTag, isStagingVerifiedTag, STAGING_TAG_PREFIX } = await load('security/release/verified-release-package.mjs');
  const tag = buildStagingTag({ candidateSha: 'd'.repeat(40), releaseId: 'staging-bootstrap-x' });
  assert.ok(tag.startsWith(STAGING_TAG_PREFIX));
  assert.ok(isStagingVerifiedTag(tag));
  // Must not collide with mobile/app version tags.
  for (const appTag of ['v1.0.1', 'android-v27', 'ios-readiness-baseline', 'tester-baseline-2026-07-10']) {
    assert.equal(isStagingVerifiedTag(appTag), false);
  }
});

test('persistence: planOnly publishes nothing', async () => {
  const { buildPackage, publishPackage } = await load('security/release/verified-release-package.mjs');
  const pkg = buildPackage({
    baseline: { sourceSha: 'd'.repeat(40) }, evidence: {}, receipt: {}, manifest: {},
    candidateSha: 'd'.repeat(40), releaseId: 'rel-x',
  });
  const result = await publishPackage({ pkg, github: null, planOnly: true });
  assert.equal(result.persisted, false);
  assert.equal(result.plan.prerelease, true);
});

test('persistence: a read-back digest mismatch reports the persistence gap', async () => {
  const { buildPackage, publishPackage, ASSET_NAMES } = await load('security/release/verified-release-package.mjs');
  const pkg = buildPackage({
    baseline: { sourceSha: 'd'.repeat(40) }, evidence: {}, receipt: {}, manifest: {},
    candidateSha: 'd'.repeat(40), releaseId: 'rel-x',
  });
  const gh = fakeGithub();
  const tampering = {
    ...gh,
    getAsset: async ({ tag, name }) => (name === ASSET_NAMES.baseline ? '{"tampered":true}' : gh.getAsset({ tag, name })),
  };
  const result = await publishPackage({ pkg, github: tampering });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERIFIED_BASELINE_PERSISTENCE_GAP');
  assert.ok(result.failures.some((f) => f.code === 'READBACK_DIGEST_MISMATCH'));
});

test('retrieval: baseline alone, evidence alone and a wrong commit are all rejected', async () => {
  const { loadPriorVerifiedRelease, ASSET_NAMES, buildStagingTag } = await load('security/release/verified-release-package.mjs');
  const tag = buildStagingTag({ candidateSha: 'd'.repeat(40), releaseId: 'rel-x' });

  // Baseline only.
  const gh1 = fakeGithub();
  gh1.state.tags.set(tag, 'd'.repeat(40));
  gh1.state.assets.set(`${tag}/${ASSET_NAMES.baseline}`, JSON.stringify({ sourceSha: 'd'.repeat(40) }));
  const r1 = await loadPriorVerifiedRelease({ github: gh1, tag });
  assert.equal(r1.ok, false);

  // Evidence only.
  const gh2 = fakeGithub();
  gh2.state.tags.set(tag, 'd'.repeat(40));
  gh2.state.assets.set(`${tag}/${ASSET_NAMES.evidence}`, JSON.stringify({ evidenceDigest: 'x' }));
  const r2 = await loadPriorVerifiedRelease({ github: gh2, tag });
  assert.equal(r2.ok, false);

  // Tag pointing at the wrong commit.
  const gh3 = fakeGithub();
  gh3.state.tags.set(tag, 'f'.repeat(40));
  gh3.state.assets.set(`${tag}/${ASSET_NAMES.baseline}`, JSON.stringify({ sourceSha: 'd'.repeat(40) }));
  gh3.state.assets.set(`${tag}/${ASSET_NAMES.evidence}`, JSON.stringify({ evidenceDigest: 'x' }));
  const r3 = await loadPriorVerifiedRelease({ github: gh3, tag });
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => /points at/.test(e)));
});

test('retrieval: a non-staging tag is refused outright', async () => {
  const { loadPriorVerifiedRelease } = await load('security/release/verified-release-package.mjs');
  const result = await loadPriorVerifiedRelease({ github: fakeGithub(), tag: 'v1.0.1' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not a staging verified tag/.test(e)));
});

test('security: the plan can never contain quarantined or heritage components', async () => {
  const { runBootstrapActivation, MODE } = await load('security/release/run-bootstrap-activation.mjs');
  const m = manifest({ liveFunctionNames: ['product-match', 'privacy-controls', 'public-sale-share-opt-out'] });
  const live = m.edgeFunctions.map((f) => f.name);
  const result = await runBootstrapActivation({
    repoRoot: REPO_ROOT, mode: MODE.PLAN_ONLY,
    liveFunctionNames: live,
    liveMigrationNames: m.migrations.map((x) => x.name),
    deps: { setMetadata: () => ({ plan: { keys: [] } }) },
  });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  for (const forbidden of ['product-match', 'privacy-controls', 'public-sale-share-opt-out']) {
    assert.ok(!result.plan.functions.includes(forbidden), `${forbidden} must never be planned`);
  }
});

test('security: the workflow keeps contents:write to the persistence job only', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'staging-release-bootstrap.yml'), 'utf8');
  // Strip comment-only lines: prose describing the permission model must not
  // be mistaken for a grant.
  const yamlText = raw.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');

  assert.match(yamlText, /^permissions:\n\s+contents:\s+read/m, 'workflow default must be contents: read');
  const writeCount = (yamlText.match(/contents:\s+write/g) || []).length;
  assert.equal(writeCount, 1, 'exactly one job may hold contents: write');
  assert.ok(!/pull-requests:\s+write|packages:\s+write|actions:\s+write|issues:\s+write/.test(yamlText));
  assert.ok(!/workflow_run:|schedule:/.test(yamlText), 'activation must never trigger automatically');
  assert.ok(!/wyyuqfdxucjksghsmhry/.test(yamlText), 'no production ref in the activation workflow');
});
