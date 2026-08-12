#!/usr/bin/env node
'use strict';

/**
 * Phase 2B.3.1 execution integrity (DEF-REL-014 … DEF-REL-018).
 *
 * The previous suite proved the LIBRARIES by injecting adapters. It could not
 * catch the defects that mattered, because those lived in the wiring: the CLI
 * supplied no adapters, the workflow published with its own algorithm, the
 * deploy core was never actually shared, and the binding hash could never equal
 * the deploy hash. These tests target the REAL entry points.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { STAGING_REF, PRODUCTION_REF } = require('../../security/scripts/lib/environment-authority');
const { generateReleaseManifest, freezeManifest, verifyFreeze } = require('../../security/release/generate-release-manifest');
const { bindCandidate } = require('../../security/release/candidate-binding');

const load = (rel) => import(`file://${path.join(REPO_ROOT, rel).split(path.sep).join('/')}`);
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'staging-release-bootstrap.yml');
const workflowText = () => fs.readFileSync(WORKFLOW, 'utf8');
/** Workflow text with comment-only lines stripped, so prose is never counted as configuration. */
const workflowConfig = () => workflowText().split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

// ── DEF-REL-017: the hash contract ───────────────────────────────────────────

test('DEF-REL-017: binding source hash EQUALS actual deploy input hash', async () => {
  const dc = await load('security/release/staging-deploy-core.mjs');
  const sha = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifest = generateReleaseManifest({
    repoRoot: REPO_ROOT, releaseId: 'r', sourceSha: sha, sourceTreeSha: 't',
    candidateEnvironment: 'staging', candidateProjectRef: STAGING_REF, env: {},
  });
  const frozen = freezeManifest(manifest);
  // A normal function AND staging-health, as the brief requires.
  const functions = ['scan-identify', 'staging-health'];
  const binding = bindCandidate({
    repoRoot: REPO_ROOT, candidateRef: sha, frozen, manifest,
    expectedEnvironment: 'staging', projectRef: STAGING_REF,
    functions, migrations: [], verifyFreeze,
  });
  assert.equal(binding.ok, true, JSON.stringify(binding.violations));

  const materialized = dc.materializeCandidate({ repoRoot: REPO_ROOT, candidateSha: sha });
  try {
    for (const fn of functions) {
      const deployHash = dc.hashDirectory(path.join(materialized.root, 'supabase', 'functions', fn));
      assert.equal(binding.binding.candidateSourceHashes[fn], deployHash,
        `${fn}: binding hash must equal the hash of what actually deploys`);
    }
  } finally {
    materialized.cleanup();
  }
});

test('DEF-REL-017: one canonical hasher, and it is byte- not utf8-based', async () => {
  const canonical = require('../../security/release/function-source-hash');
  const dc = await load('security/release/staging-deploy-core.mjs');
  const dir = path.join(REPO_ROOT, 'supabase', 'functions', 'staging-health');
  assert.equal(dc.hashDirectory(dir), canonical.hashFunctionSource(dir), 'deploy core must delegate to the canonical hasher');

  // Byte-based: a lone CR must change the digest, which a utf8 round-trip
  // through a text-mode read could mask.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-hashbytes-'));
  fs.writeFileSync(path.join(root, 'a.ts'), Buffer.from('x\n', 'utf8'));
  const lf = canonical.hashFunctionSource(root);
  fs.writeFileSync(path.join(root, 'a.ts'), Buffer.from('x\r\n', 'utf8'));
  const crlf = canonical.hashFunctionSource(root);
  fs.rmSync(root, { recursive: true, force: true });
  assert.notEqual(lf, crlf, 'byte-level differences must be visible to the digest');
});

test('DEF-REL-017: a mutated deploy input blocks even though binding was valid', async () => {
  const dc = await load('security/release/staging-deploy-core.mjs');
  const sha = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifest = generateReleaseManifest({
    repoRoot: REPO_ROOT, releaseId: 'r', sourceSha: sha, sourceTreeSha: 't',
    candidateEnvironment: 'staging', candidateProjectRef: STAGING_REF, env: {},
  });
  const frozen = freezeManifest(manifest);
  const binding = bindCandidate({
    repoRoot: REPO_ROOT, candidateRef: sha, frozen, manifest,
    expectedEnvironment: 'staging', projectRef: STAGING_REF,
    functions: ['staging-health'], migrations: [], verifyFreeze,
  });
  const materialized = dc.materializeCandidate({ repoRoot: REPO_ROOT, candidateSha: sha });
  try {
    fs.appendFileSync(path.join(materialized.root, 'supabase', 'functions', 'staging-health', 'index.ts'), '\n// tampered\n');
    const result = dc.validateDeployInput({
      functionName: 'staging-health', manifest, candidateRoot: materialized.root,
      expectedSourceHash: binding.binding.candidateSourceHashes['staging-health'], projectRef: STAGING_REF,
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'SOURCE_HASH_MISMATCH'));
  } finally {
    materialized.cleanup();
  }
});

// ── DEF-REL-016: shared core + verify_jwt ────────────────────────────────────

test('DEF-REL-016: the existing controlled deployer uses the shared core', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'deploy-staging-function.mjs'), 'utf8');
  assert.match(src, /staging-deploy-core\.mjs/, 'existing deployer must import the shared core');
  assert.match(src, /buildDeployArgs\(/, 'existing deployer must build its command via the shared primitive');
  // The old hand-rolled flag push must be gone, or the two paths can drift.
  assert.ok(!/deployArgs\.push\('--no-verify-jwt'\)/.test(src), 'verify_jwt handling must live only in the shared core');
});

test('DEF-REL-016: bootstrap and the controlled path share one command builder', async () => {
  const dc = await load('security/release/staging-deploy-core.mjs');
  const orchestrator = fs.readFileSync(path.join(REPO_ROOT, 'security', 'release', 'run-bootstrap-activation.mjs'), 'utf8');
  assert.match(orchestrator, /staging-deploy-core\.mjs/);
  assert.equal(typeof dc.buildDeployArgs, 'function');
});

test('DEF-REL-016: verify_jwt=false emits --no-verify-jwt, true does not', async () => {
  const dc = await load('security/release/staging-deploy-core.mjs');
  const off = dc.buildDeployArgs({ functionName: 'f', projectRef: STAGING_REF, verifyJwt: false });
  const on = dc.buildDeployArgs({ functionName: 'f', projectRef: STAGING_REF, verifyJwt: true });
  assert.ok(off.includes('--no-verify-jwt'));
  assert.ok(!on.includes('--no-verify-jwt'));
  assert.ok(off.includes('--project-ref') && off.includes(STAGING_REF));
});

test('DEF-REL-016: staging-health deploys with its governed verify_jwt=false posture', async () => {
  const dc = await load('security/release/staging-deploy-core.mjs');
  // The root config.toml does not declare staging-health, so the manifest entry
  // is null; the governed value lives in the function's own config.toml.
  const resolved = dc.resolveVerifyJwt({
    manifestEntry: { verifyJwt: null }, candidateRoot: REPO_ROOT, functionName: 'staging-health',
  });
  assert.equal(resolved.verifyJwt, false);
  assert.equal(resolved.source, 'function-config.toml');
  const args = dc.buildDeployArgs({ functionName: 'staging-health', projectRef: STAGING_REF, verifyJwt: resolved.verifyJwt });
  assert.ok(args.includes('--no-verify-jwt'), 'the public health probe must not be deployed behind JWT verification');
});

test('DEF-REL-016: an undeclared verify_jwt posture is refused, never defaulted', async () => {
  const dc = await load('security/release/staging-deploy-core.mjs');
  assert.throws(
    () => dc.resolveVerifyJwt({ manifestEntry: { verifyJwt: null }, candidateRoot: REPO_ROOT, functionName: 'no-such-function' }),
    (e) => e.code === 'VERIFY_JWT_UNRESOLVED',
  );
  assert.throws(
    () => dc.buildDeployArgs({ functionName: 'f', projectRef: STAGING_REF, verifyJwt: undefined }),
    (e) => e.code === 'VERIFY_JWT_UNRESOLVED',
  );
});

// ── DEF-REL-014: real adapters, actually wired by the CLI ────────────────────

test('DEF-REL-014: the CLI wires real health, certification and github adapters', async () => {
  const mod = await load('security/release/run-bootstrap-activation.mjs');
  const deps = mod.buildCliDeps({ repoRoot: REPO_ROOT, env: { SUPABASE_STAGING_URL: 'https://example.invalid' } });
  assert.equal(typeof deps.probeHealth, 'function', 'CLI must wire a real health probe');
  assert.equal(typeof deps.loadCertification, 'function', 'CLI must wire a real certification loader');
  assert.ok(deps.githubRead && typeof deps.githubRead.listTags === 'function', 'CLI must wire a github read adapter');

  // And the CLI source must actually pass them through — a builder nobody calls
  // is exactly the class of defect this test exists for.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'security', 'release', 'run-bootstrap-activation.mjs'), 'utf8');
  assert.match(src, /buildCliDeps\(/);
  assert.match(src, /probeHealth: cli\.probeHealth/);
  assert.match(src, /certification: certResult\.certification/);
  assert.match(src, /loadPriorVerifiedRelease\(/);
});

test('DEF-REL-014: the health probe never turns a failure into PASS', async () => {
  const { createHealthProbe } = await load('security/release/activation-runtime-adapters.mjs');

  const scenarios = [
    { label: 'timeout', impl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } },
    { label: 'dns/network', impl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } },
    { label: 'malformed json', impl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) },
    { label: 'non-2xx', impl: async () => ({ ok: false, status: 503, text: async () => '{"status":"not_ready"}' }) },
  ];
  for (const { label, impl } of scenarios) {
    const probe = createHealthProbe({ stagingUrl: 'https://staging.invalid', fetchImpl: impl });
    const result = await probe();
    assert.equal(result.live.status, 'OPERATIONAL_FAILURE', `${label} must not PASS`);
    assert.equal(result.ready.status, 'OPERATIONAL_FAILURE', `${label} must not PASS`);
  }
});

test('DEF-REL-014: a NOT_VERIFIABLE /version fails and the raw body reaches the verifier', async () => {
  const { createHealthProbe } = await load('security/release/activation-runtime-adapters.mjs');
  const body = { environment: 'staging', releaseIdentityState: 'NOT_VERIFIABLE', releaseId: null };
  const probe = createHealthProbe({
    stagingUrl: 'https://staging.invalid',
    fetchImpl: async (url) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(url.endsWith('/version') ? body
        : { status: url.endsWith('/live') ? 'alive' : 'ready', environment: 'staging' }),
    }),
  });
  const result = await probe();
  assert.equal(result.live.status, 'PASS');
  assert.equal(result.version.status, 'OPERATIONAL_FAILURE');
  assert.deepEqual(result.versionBody, body, 'the verifier must receive the real body, not a substitute');
});

test('DEF-REL-014: a healthy staging reports PASS across the contract', async () => {
  const { createHealthProbe } = await load('security/release/activation-runtime-adapters.mjs');
  const probe = createHealthProbe({
    stagingUrl: 'https://staging.invalid',
    fetchImpl: async (url) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(
        url.endsWith('/version')
          ? { environment: 'staging', releaseIdentityState: 'VERIFIABLE', releaseId: 'rel-x' }
          : { status: url.endsWith('/live') ? 'alive' : 'ready', environment: 'staging' },
      ),
    }),
  });
  const result = await probe();
  assert.equal(result.live.status, 'PASS');
  assert.equal(result.ready.status, 'PASS');
  assert.equal(result.version.status, 'PASS');
});

test('DEF-REL-014: certification is consumed, and missing/malformed blocks', async () => {
  const { createCertificationLoader } = await load('security/release/activation-runtime-adapters.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-cert-'));

  const missing = createCertificationLoader({ reportPath: path.join(dir, 'nope.json') })();
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /no staging certification report/);

  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, '{not json');
  assert.equal(createCertificationLoader({ reportPath: badPath })().ok, false);

  const shapePath = path.join(dir, 'shape.json');
  fs.writeFileSync(shapePath, JSON.stringify({ final_verdict: 'BLOCKED' }));
  const shape = createCertificationLoader({ reportPath: shapePath })();
  assert.equal(shape.ok, false);
  assert.match(shape.detail, /missing/);

  // The canonical shape, including the unchanged leaked-password finding.
  const goodPath = path.join(dir, 'good.json');
  fs.writeFileSync(goodPath, JSON.stringify({
    final_verdict: 'BLOCKED',
    blocking_findings: ['leaked_password_protection'],
    operational_failures: [],
    report_only_findings: [],
  }));
  const good = createCertificationLoader({ reportPath: goodPath })();
  assert.equal(good.ok, true);
  assert.deepEqual(good.certification.blocking_findings, ['leaked_password_protection']);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── DEF-REL-015: artifacts + one persistence authority ───────────────────────

test('DEF-REL-015: PLAN_ONLY writes the plan artifacts to --output-dir', async () => {
  const { runBootstrapActivation, MODE } = await load('security/release/run-bootstrap-activation.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-out-'));
  const manifest = generateReleaseManifest({
    repoRoot: REPO_ROOT, releaseId: 'r', sourceSha: 'a'.repeat(40), sourceTreeSha: 'b'.repeat(40),
    candidateEnvironment: 'staging', candidateProjectRef: STAGING_REF, env: {},
  });
  await runBootstrapActivation({
    repoRoot: REPO_ROOT, mode: MODE.PLAN_ONLY,
    liveFunctionNames: manifest.edgeFunctions.map((f) => f.name),
    liveMigrationNames: manifest.migrations.map((m) => m.name),
    outputDir: out,
    deps: { setMetadata: () => ({ plan: { keys: [] } }) },
  });
  assert.ok(fs.existsSync(path.join(out, 'frozen-manifest.json')));
  assert.ok(fs.existsSync(path.join(out, 'bootstrap-plan.json')));
  // A plan is not a verified release: no baseline may exist.
  assert.equal(fs.existsSync(path.join(out, 'verified-baseline.json')), false);
  fs.rmSync(out, { recursive: true, force: true });
});

test('DEF-REL-015: persistence refuses when the verified baseline is absent', async () => {
  const { persistVerifiedRelease } = await load('security/release/persist-verified-release-package.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-persist-'));
  const result = await persistVerifiedRelease({ inputDir: dir, github: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERIFIED_BASELINE_PERSISTENCE_GAP');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DEF-REL-015: persistence refuses a package whose evidence was not staging-verified', async () => {
  const { persistVerifiedRelease } = await load('security/release/persist-verified-release-package.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-persist2-'));
  fs.writeFileSync(path.join(dir, 'verified-baseline.json'), JSON.stringify({ sourceSha: 'a'.repeat(40), releaseId: 'r' }));
  fs.writeFileSync(path.join(dir, 'release-evidence.json'), JSON.stringify({ stagingVerifiedEligible: false, releaseCandidateVerdict: 'BLOCKED' }));
  fs.writeFileSync(path.join(dir, 'deployment-receipt.json'), '{}');
  fs.writeFileSync(path.join(dir, 'frozen-manifest.json'), '{}');
  const result = await persistVerifiedRelease({ inputDir: dir, github: {} });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === 'RELEASE_NOT_STAGING_VERIFIED'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DEF-REL-015: the persistence entry point uploads, reads back and verifies digests', async () => {
  const { persistVerifiedRelease } = await load('security/release/persist-verified-release-package.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-persist3-'));
  const candidateSha = 'd'.repeat(40);
  fs.writeFileSync(path.join(dir, 'verified-baseline.json'), JSON.stringify({ sourceSha: candidateSha, releaseId: 'rel-x' }));
  fs.writeFileSync(path.join(dir, 'release-evidence.json'), JSON.stringify({ stagingVerifiedEligible: true, releaseCandidateVerdict: 'PASS' }));
  fs.writeFileSync(path.join(dir, 'deployment-receipt.json'), JSON.stringify({ status: 'PASS' }));
  fs.writeFileSync(path.join(dir, 'frozen-manifest.json'), JSON.stringify({ manifest: { identityDigest: 'x' } }));

  const store = new Map();
  const calls = [];
  const gh = {
    createTag: async (a) => { calls.push(['createTag', a.tag, a.sha]); },
    createRelease: async (a) => { calls.push(['createRelease', a.tag, a.prerelease]); },
    uploadAsset: async ({ tag, name, body }) => { store.set(`${tag}/${name}`, body); calls.push(['upload', name]); },
    getAsset: async ({ tag, name }) => store.get(`${tag}/${name}`),
  };

  const ok = await persistVerifiedRelease({ inputDir: dir, github: gh });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.tag.startsWith('staging-verified-'));
  assert.equal(calls.filter((c) => c[0] === 'upload').length, 4, 'four assets uploaded');
  assert.ok(calls.some((c) => c[0] === 'createRelease' && c[2] === true), 'published as a prerelease');
  assert.ok(calls.some((c) => c[0] === 'createTag' && c[2] === candidateSha), 'tag targets the exact candidate');

  // Corrupt what read-back SEES (a re-publish would overwrite the store).
  const tamperingGh = {
    ...gh,
    getAsset: async ({ tag, name }) => (name === 'verified-baseline.json' ? '{"tampered":true}' : store.get(`${tag}/${name}`)),
  };
  const bad = await persistVerifiedRelease({ inputDir: dir, github: tamperingGh });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'VERIFIED_BASELINE_PERSISTENCE_GAP');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── DEF-REL-018: inventory fail-closed ───────────────────────────────────────

test('DEF-REL-018: inventory failures never become an empty list', async () => {
  const inv = await load('security/release/build-activation-inventory.mjs');

  assert.throws(() => inv.extractFunctions([]), (e) => e.code === 'ACTIVATION_INVENTORY_OPERATIONAL_FAILURE');
  assert.throws(() => inv.extractFunctions('not an array'), (e) => e.code === 'ACTIVATION_INVENTORY_OPERATIONAL_FAILURE');
  assert.throws(() => inv.extractFunctions([{ nope: 1 }]), (e) => e.code === 'ACTIVATION_INVENTORY_OPERATIONAL_FAILURE');
  // A bare array is the OLD (never-real) assumed shape; the real CLI wraps
  // migrations in an object, so a bare array must fail closed too.
  assert.throws(() => inv.extractMigrations([{ local: '1', remote: '1', time: '1' }]), (e) => e.code === 'ACTIVATION_INVENTORY_OPERATIONAL_FAILURE');
  assert.throws(() => inv.extractMigrations({}), (e) => e.code === 'ACTIVATION_INVENTORY_OPERATIONAL_FAILURE');
  assert.throws(() => inv.extractMigrations({ migrations: [{ local: '1' }] }), (e) => e.code === 'ACTIVATION_INVENTORY_OPERATIONAL_FAILURE', 'a row with no remote field must fail closed, not be treated as unapplied');

  // Valid shapes, including the real 103-migration case.
  assert.deepEqual(inv.extractFunctions([{ slug: 'b' }, { name: 'a' }]), ['a', 'b']);
  const many = Array.from({ length: 103 }, (_, i) => ({ local: `m${i}`, remote: `m${i}`, time: `m${i}` }));
  assert.equal(inv.extractMigrations({ migrations: many }).length, 103);
  // An empty migration list is structurally possible and therefore allowed.
  assert.deepEqual(inv.extractMigrations({ migrations: [] }), []);
  // A row present locally but not yet applied remotely is correctly excluded
  // from the LIVE inventory, not an error.
  assert.deepEqual(
    inv.extractMigrations({ migrations: [{ local: 'x', remote: '', time: 'x' }, { local: 'y', remote: 'y', time: 'y' }] }),
    ['y'],
  );
});

test('DEF-REL-018: the workflow has no migration-list empty fallback', () => {
  const yaml = workflowConfig();
  assert.ok(!/\|\|\s*echo\s*'\[\]'/.test(yaml), 'a CLI failure must never be coerced into an empty inventory');
  assert.match(yaml, /build-activation-inventory\.mjs/, 'inventory must be built by the fail-closed builder');
});

// ── DEF-REL-019: migration list needs --linked, not --project-ref ───────────

test('DEF-REL-019: migration list never receives --project-ref (the pinned CLI rejects it)', () => {
  const yaml = workflowConfig();
  assert.ok(
    !/supabase migration list[^\n]*--project-ref/.test(yaml),
    'migration list must never be called with --project-ref on CLI 2.109.1',
  );
});

test('DEF-REL-019: the runner links to the exact already-validated staging ref before listing migrations', () => {
  const yaml = workflowConfig();
  const linkLines = yaml.split('\n').filter((l) => /^\s+supabase link\b/.test(l));
  assert.equal(linkLines.length, 2, 'preflight and the pre-EXECUTE revalidation must each link once');
  for (const line of linkLines) {
    assert.match(line, /--project-ref "\$SUPABASE_STAGING_PROJECT_REF"/, 'link must target the validated staging var, never a literal or caller-supplied ref');
  }
  // Every migration list call must be preceded by a link call in the same step.
  const migrationLines = yaml.split('\n').filter((l) => /^\s+supabase migration list\b/.test(l));
  assert.equal(migrationLines.length, 2);
  for (const line of migrationLines) {
    assert.match(line, /--linked\b/, 'migration list must read from the linked project');
    assert.match(line, /--output-format json/, 'migration list must request the structured JSON format explicitly');
    assert.ok(!/\s-o\s+json/.test(line), '-o json is the wrong flag for migration list on this CLI (it renders a table, not JSON)');
  }
});

test('DEF-REL-019: migration inventory collection stays read-only — no push/repair/up/down', () => {
  const yaml = workflowConfig();
  assert.ok(!/supabase migration (push|repair|up|down|new)\b/.test(yaml), 'inventory collection must never mutate migration state');
  assert.ok(!/supabase db (push|reset)\b/.test(yaml), 'inventory collection must never mutate the database');
});

test('DEF-REL-018: the pinned Supabase CLI is set up before any supabase command', () => {
  const lines = workflowConfig().split('\n');
  const setupAt = [];
  const commandAt = [];
  lines.forEach((line, i) => {
    if (/supabase\/setup-cli/.test(line)) setupAt.push(i);
    if (/^\s+supabase\s+(functions|migration|link|secrets)\b/.test(line)) commandAt.push(i);
  });
  assert.ok(setupAt.length >= 2, 'every job invoking supabase must set up the CLI');
  assert.ok(commandAt.length > 0, 'the workflow does invoke supabase');
  for (const cmd of commandAt) {
    assert.ok(setupAt.some((s) => s < cmd), `supabase command at line ${cmd + 1} precedes any CLI setup`);
  }
  assert.match(workflowConfig(), /SUPABASE_CLI_VERSION:\s*2\.109\.1/, 'CLI version must be pinned to the repo standard');
});

test('DEF-REL-018: EXECUTE revalidates staging HEAD and live inventory before mutation', () => {
  const yaml = workflowConfig();
  assert.match(yaml, /STALE_BOOTSTRAP_CANDIDATE/, 'a stale candidate must block before deployment');
  assert.match(yaml, /Revalidate staging HEAD immediately before mutation/);
  assert.match(yaml, /Revalidate live inventory immediately before mutation/);
  assert.match(yaml, /--compare activation\/inventory\.json/, 'the recheck must compare against the plan-stage inventory');

  // Ordering: both revalidations must precede the activation run.
  const lines = yaml.split('\n');
  const headAt = lines.findIndex((l) => /Revalidate staging HEAD/.test(l));
  const invAt = lines.findIndex((l) => /Revalidate live inventory/.test(l));
  const runAt = lines.findIndex((l) => /Run bootstrap activation/.test(l));
  assert.ok(headAt > -1 && invAt > -1 && runAt > -1);
  assert.ok(headAt < runAt && invAt < runAt, 'revalidation must come before the first mutation');
});

test('DEF-REL-018: one releaseId flows from preflight through plan, execute and persistence', () => {
  const yaml = workflowConfig();
  assert.match(yaml, /RELEASE_ID="staging-bootstrap-/, 'the run mints exactly one releaseId');
  assert.match(yaml, /release_id=\$RELEASE_ID/, 'that single id becomes the job output');
  const uses = (yaml.match(/needs\.preflight\.outputs\.release_id/g) || []).length;
  assert.ok(uses >= 2, `plan and execute must both consume the preflight releaseId (found ${uses})`);
});

test('DEF-REL-018: deployment attempt is bound to the real run attempt', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'security', 'release', 'run-bootstrap-activation.mjs'), 'utf8');
  assert.match(src, /GITHUB_RUN_ATTEMPT/, 'a re-run must be distinguishable from the original attempt');
  assert.ok(!/deploymentAttempt: 1,\s*startedAt/.test(src), 'attempt must not be hardcoded');
});

// ── workflow structure / security ────────────────────────────────────────────

test('workflow: publication logic lives in code, not YAML', () => {
  const yaml = workflowConfig();
  assert.match(yaml, /persist-verified-release-package\.mjs/, 'persistence must call the single authority');
  assert.ok(!/gh release create/.test(yaml), 'the workflow must not reimplement publication');
});

test('workflow: permissions stay minimal and production is unreachable', () => {
  const yaml = workflowConfig();
  assert.match(yaml, /^permissions:\n\s+contents:\s+read/m);
  assert.equal((yaml.match(/contents:\s+write/g) || []).length, 1, 'only the persistence job may write');
  assert.ok(!/pull-requests:\s+write|packages:\s+write|actions:\s+write|issues:\s+write/.test(yaml));
  assert.ok(!/wyyuqfdxucjksghsmhry/.test(yaml), 'no production ref anywhere in the workflow');
  assert.ok(!/workflow_run:|schedule:|push:/.test(yaml), 'activation must never trigger automatically');
  // The project ref must not be a caller-supplied input.
  const inputsBlock = yaml.slice(yaml.indexOf('inputs:'), yaml.indexOf('permissions:'));
  assert.ok(!/project/i.test(inputsBlock), 'project ref must not be an input');
});

test('workflow: EXECUTE requires the typed confirmation', () => {
  const yaml = workflowConfig();
  assert.match(yaml, /ACTIVATE-STAGING-BOOTSTRAP/);
  assert.match(yaml, /confirm_execute/);
});

// ── real CLI entry point ─────────────────────────────────────────────────────

test('CLI: refuses a missing or malformed inventory rather than defaulting', () => {
  const script = path.join(REPO_ROOT, 'security', 'release', 'run-bootstrap-activation.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-cli-'));

  const noInv = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000 });
  assert.notEqual(noInv.status, 0);
  assert.match(`${noInv.stdout}${noInv.stderr}`, /ACTIVATION_INVENTORY_OPERATIONAL_FAILURE/);

  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ functions: [], migrations: [] }));
  const emptyRun = spawnSync(process.execPath, [script, '--inventory', empty], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000 });
  assert.notEqual(emptyRun.status, 0);
  assert.match(`${emptyRun.stdout}${emptyRun.stderr}`, /ACTIVATION_INVENTORY_OPERATIONAL_FAILURE/);

  const malformed = path.join(dir, 'bad.json');
  fs.writeFileSync(malformed, JSON.stringify({ functions: 'nope' }));
  const badRun = spawnSync(process.execPath, [script, '--inventory', malformed], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000 });
  assert.notEqual(badRun.status, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: EXECUTE from outside governed CI fails closed', () => {
  const script = path.join(REPO_ROOT, 'security', 'release', 'run-bootstrap-activation.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-cli2-'));
  const inv = path.join(dir, 'inv.json');
  fs.writeFileSync(inv, JSON.stringify({ functions: ['staging-health'], migrations: [] }));

  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.KSCAN_ACTIVATION_ENVIRONMENT;

  const run = spawnSync(process.execPath, [script, '--execute', '--inventory', inv], {
    cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 180000,
  });
  assert.notEqual(run.status, 0, 'EXECUTE must not succeed outside governed CI');
  const output = `${run.stdout}${run.stderr}`;
  // Either the certification gate or the authority gate stops it; both are
  // fail-closed and neither may deploy.
  assert.ok(/EXECUTE_NOT_AUTHORIZED|CERTIFICATION_OPERATIONAL_FAILURE/.test(output), output.slice(0, 400));
});
