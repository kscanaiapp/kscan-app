/**
 * Edge Function source-parity gate tests (IMG-006).
 *
 * Phase 2A established that the deployed production bundles content-match the
 * Android function trees while the iOS branch carried a different, independently
 * deployable copy — and that nothing in the repository would notice. These tests
 * cover the gate that closes that hole:
 *
 *   scripts/edge-function-manifest-lib.js      bundle/tree resolution + hashing
 *   scripts/generate-edge-function-manifest.js manifest generation + staleness
 *   scripts/check-edge-function-parity.js      the drift gate itself
 *   scripts/deploy-edge-functions.js           the approved deployment path
 *   config/edge-function-manifest.json         the committed canonical manifest
 *
 * Drift is proven by mutating a THROWAWAY COPY of the function trees in the OS
 * temp directory and asserting the gate fails there. The repository working tree
 * is never modified, so a failing run cannot leave the checkout dirty.
 *
 * Pure Node (node:test). No network, no Supabase CLI, no deployment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  APPROVED_PROJECT_REF,
  GOVERNED_FUNCTIONS,
  buildParity,
  extractSpecifiers,
  resolveBundle,
} = require('../scripts/edge-function-manifest-lib.js');

const REPO_ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'config', 'edge-function-manifest.json');
const CHECKER = 'scripts/check-edge-function-parity.js';
const GENERATOR = 'scripts/generate-edge-function-manifest.js';
const DEPLOYER = 'scripts/deploy-edge-functions.js';

function runNode(repoRoot, scriptRelativePath, args = []) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, scriptRelativePath), ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

/**
 * Materializes a self-contained throwaway repository containing only what the
 * gate reads. Because the scripts resolve their repo root from their own
 * location, copying them in is what redirects the gate at the fixture — no
 * environment override exists, so there is no bypass for a real deploy.
 */
function makeFixtureRepo(t, { gitInit = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-edge-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const script of [
    'edge-function-manifest-lib.js',
    'generate-edge-function-manifest.js',
    'check-edge-function-parity.js',
    'deploy-edge-functions.js',
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', script), path.join(root, 'scripts', script));
  }

  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.copyFileSync(MANIFEST_PATH, path.join(root, 'config', 'edge-function-manifest.json'));
  // B34-DEF-001: the deploy wrapper's Step 1 refuses to run at all without a
  // committed backend-authority marker declaring this checkout authoritative.
  fs.writeFileSync(
    path.join(root, 'config', 'backend-authority.json'),
    JSON.stringify({ role: 'backend-deployment-authority', canonicalBranch: 'fixture' }, null, 2),
  );

  fs.mkdirSync(path.join(root, 'supabase', 'functions'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'supabase', 'config.toml'),
    path.join(root, 'supabase', 'config.toml'),
  );
  for (const dir of [...GOVERNED_FUNCTIONS, '_shared']) {
    fs.cpSync(
      path.join(REPO_ROOT, 'supabase', 'functions', dir),
      path.join(root, 'supabase', 'functions', dir),
      { recursive: true },
    );
  }

  if (gitInit) {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'gate@example.invalid');
    git('config', 'user.name', 'Parity Gate Fixture');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  }

  return root;
}

function fixturePath(root, ...segments) {
  return path.join(root, 'supabase', 'functions', ...segments);
}

// ── The committed manifest ───────────────────────────────────────────────────

test('committed manifest governs every governed function and the approved project', () => {
  assert.ok(fs.existsSync(MANIFEST_PATH), 'config/edge-function-manifest.json must be committed');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // Spelled out rather than derived from GOVERNED_FUNCTIONS: widening the gate
  // must fail this assertion first, so it stays a decision and not a side
  // effect. style-outfit-generate joined in Build 3 Phase 4. B34-DEF-001
  // widened this from 3 to every function this branch's tree carries (this
  // IS the canonical backend authority branch -- see
  // docs/staging-rebuild/backend-authority-manifest.md and
  // config/backend-authority.json).
  assert.deepEqual(manifest.parity.expectedFunctions, [
    'handle-user-deletion',
    'kickscrew-sneaker-description',
    'kplus-activate',
    'kplus-reconcile-revenuecat',
    'nike-shoe-details',
    'privacy-correction-request',
    'privacy-data-export',
    'process-account-deletions',
    'product-search-deals',
    'resend-restoration-email',
    'restore-account',
    'scan-identify',
    'search-vinted-secondhand',
    'shared-room-image-url',
    'staging-health',
    'style-outfit-generate',
    'stylechat-generate',
    'stylist-speech',
    'tryon-clothes-pro',
  ]);
  assert.equal(manifest.parity.approvedProjectRef, APPROVED_PROJECT_REF);

  for (const fn of manifest.parity.functions) {
    assert.ok(fn.bundleFileCount > 0, `${fn.name} must resolve a non-empty deployable bundle`);
    assert.match(fn.bundleHash, /^[0-9a-f]{64}$/);
    assert.match(fn.treeHash, /^[0-9a-f]{64}$/);
    // The tree is a superset of the bundle: tests and unreachable modules are
    // gated for drift but are not part of what actually deploys.
    assert.ok(fn.treeFileCount >= fn.bundleFileCount);
  }
});

test('provenance is excluded from parity so both platform branches converge', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const parityText = JSON.stringify(manifest.parity);
  assert.ok(manifest.provenance, 'provenance block must exist');
  assert.ok(manifest.provenance.generatedFromGitSha, 'provenance must record the source Git SHA');
  assert.ok(manifest.provenance.generatedAtUtc, 'provenance must record generation time');
  assert.ok(
    !parityText.includes(manifest.provenance.generatedFromGitSha),
    'branch-specific Git SHA must not leak into the gated parity section',
  );
  assert.ok(
    !parityText.includes(manifest.provenance.generatedAtUtc),
    'generation timestamp must not leak into the gated parity section',
  );
});

test('the deployable bundle pulls in the required shared modules', () => {
  const scanBundle = resolveBundle(REPO_ROOT, 'scan-identify').localFiles;
  assert.ok(
    scanBundle.includes('supabase/functions/_shared/llmModelRouting.ts'),
    'scan-identify must deploy the shared allowlist-bound model router',
  );
  assert.ok(
    scanBundle.includes('supabase/functions/_shared/deletion/assertAccountActiveIfAuthenticated.ts'),
    'scan-identify must deploy the shared account-state guard',
  );

  const chatBundle = resolveBundle(REPO_ROOT, 'stylechat-generate').localFiles;
  assert.ok(
    chatBundle.includes('supabase/functions/_shared/deletion/common.ts'),
    'stylechat-generate must deploy the shared account-active guard',
  );

  // Remote specifiers are described but never fetched: the gate must stay
  // deterministic and usable offline.
  for (const name of GOVERNED_FUNCTIONS) {
    for (const specifier of buildParity(REPO_ROOT, [name]).functions[0].remoteSpecifiers) {
      assert.ok(
        /^(npm:|jsr:|https:)/.test(specifier),
        `unexpected non-remote specifier recorded: ${specifier}`,
      );
    }
  }
});

// ── Specifier extraction does not misread prose or TypeScript type syntax ───

test('extractSpecifiers: a "from" token quoted as a TS index-access key is not a specifier', () => {
  const source = `
    bucket: ReturnType<ReturnType<typeof createAdmin>['storage']['from']>,
    import realSpec from 'npm:@supabase/supabase-js@2';
  `;
  assert.deepEqual(extractSpecifiers(source), ['npm:@supabase/supabase-js@2']);
});

test('extractSpecifiers: block-comment prose containing "from" + a quoted apostrophe is not a specifier', () => {
  const source = `
    /**
     * never distinguishable from "doesn't exist at all".
     */
    import realSpec from 'npm:@supabase/supabase-js@2';
  `;
  assert.deepEqual(extractSpecifiers(source), ['npm:@supabase/supabase-js@2']);
});

test('extractSpecifiers: a real https remote specifier survives (not truncated at its own //)', () => {
  const source = `import { z } from 'https://esm.sh/zod@3';`;
  assert.deepEqual(extractSpecifiers(source), ['https://esm.sh/zod@3']);
});

// ── The gate passes on a synchronized tree ───────────────────────────────────

test('parity gate passes against this checkout', () => {
  const result = runNode(REPO_ROOT, CHECKER);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /EDGE FUNCTION PARITY: PASS/);
});

test('manifest is current for this checkout', () => {
  const result = runNode(REPO_ROOT, GENERATOR, ['--check']);
  assert.equal(result.status, 0, result.output);
});

// ── The gate fails on every drift shape ──────────────────────────────────────

test('drift: a modified deployable file fails the gate', (t) => {
  const root = makeFixtureRepo(t);
  const target = fixturePath(root, 'scan-identify', 'index.ts');

  assert.equal(runNode(root, CHECKER).status, 0, 'fixture must start synchronized');

  const original = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, `${original}\n// intentional drift\n`);

  const drifted = runNode(root, CHECKER);
  assert.equal(drifted.status, 1);
  assert.match(drifted.output, /EDGE FUNCTION PARITY: FAIL/);
  assert.match(drifted.output, /content differs supabase\/functions\/scan-identify\/index\.ts/);
  assert.match(drifted.output, /deployable bundle hash differs/);

  // Removing the alteration restores parity — the gate is reversible, not sticky.
  fs.writeFileSync(target, original);
  assert.equal(runNode(root, CHECKER).status, 0);
});

test('drift: a modified non-deployed tree file still fails the gate', (t) => {
  const root = makeFixtureRepo(t);
  const target = fixturePath(root, 'scan-identify', 'qualityTune.test.ts');
  fs.appendFileSync(target, '\n// intentional drift\n');

  const drifted = runNode(root, CHECKER);
  assert.equal(drifted.status, 1);
  assert.match(drifted.output, /function tree hash differs/);
});

test('drift: a missing required shared module fails the gate', (t) => {
  const root = makeFixtureRepo(t);
  fs.rmSync(fixturePath(root, '_shared', 'llmModelRouting.ts'));

  const drifted = runNode(root, CHECKER);
  assert.equal(drifted.status, 1);
  assert.match(drifted.output, /Unresolved local module|missing file/);
});

test('drift: an extra file in a governed function directory fails the gate', (t) => {
  const root = makeFixtureRepo(t);
  fs.writeFileSync(fixturePath(root, 'stylechat-generate', 'unexpected.ts'), 'export const x = 1;\n');

  const drifted = runNode(root, CHECKER);
  assert.equal(drifted.status, 1);
  assert.match(drifted.output, /unexpected file not in manifest/);
});

test('drift: a non-approved project reference fails the gate', (t) => {
  const root = makeFixtureRepo(t);
  const configPath = path.join(root, 'supabase', 'config.toml');
  // A fixture-only, obviously-fake ref -- must differ from APPROVED_PROJECT_REF
  // regardless of which real project that constant currently approves.
  const wrongRef = 'xxxxxxxxxxxxxxxxxxxxx';
  assert.notEqual(wrongRef, APPROVED_PROJECT_REF);
  fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace(APPROVED_PROJECT_REF, wrongRef));

  const drifted = runNode(root, CHECKER);
  assert.equal(drifted.status, 1);
  assert.match(drifted.output, /Project reference mismatch/);
});

test('drift: a missing config.toml fails the gate instead of passing by default', (t) => {
  const root = makeFixtureRepo(t);
  fs.rmSync(path.join(root, 'supabase', 'config.toml'));

  const drifted = runNode(root, CHECKER);
  assert.equal(drifted.status, 1);
  assert.match(drifted.output, /cannot prove\s+which Supabase project/);
});

test('staleness: an out-of-date manifest is reported as stale', (t) => {
  const root = makeFixtureRepo(t);
  fs.appendFileSync(fixturePath(root, 'scan-identify', 'similarityMatcher.ts'), '\n// drift\n');

  const stale = runNode(root, GENERATOR, ['--check']);
  assert.equal(stale.status, 1);
  assert.match(stale.output, /manifest is stale/i);
});

// ── The approved deployment path ─────────────────────────────────────────────

test('deploy guard: a synchronized tree reaches a dry run and deploys nothing', (t) => {
  const root = makeFixtureRepo(t, { gitInit: true });

  const dryRun = runNode(root, DEPLOYER);
  assert.equal(dryRun.status, 0, dryRun.output);
  assert.match(dryRun.output, /DRY RUN — nothing was deployed/);
  assert.match(dryRun.output, /Git SHA\s+:/);
  assert.match(dryRun.output, /tree   hash [0-9a-f]{64}/);
  assert.match(dryRun.output, /bundle hash [0-9a-f]{64}/);
  // Verification alone must never invoke the CLI.
  assert.ok(!/Deploying scan-identify/.test(dryRun.output));
  assert.ok(!/Deployment complete/.test(dryRun.output));
});

test('deploy guard: drift aborts before any deployment step', (t) => {
  const root = makeFixtureRepo(t, { gitInit: true });
  fs.appendFileSync(fixturePath(root, 'stylechat-generate', 'index.ts'), '\n// intentional drift\n');

  const blocked = runNode(root, DEPLOYER, ['--function', 'stylechat-generate']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.output, /ABORTED/);
  assert.match(blocked.output, /Nothing was deployed/);
  assert.ok(!/Deploying stylechat-generate/.test(blocked.output));
});

test('deploy guard: uncommitted function source aborts the deploy', (t) => {
  const root = makeFixtureRepo(t, { gitInit: true });
  // Regenerate so the manifest matches, leaving only the "uncommitted" problem.
  fs.appendFileSync(fixturePath(root, 'scan-identify', 'index.ts'), '\n// local edit\n');
  assert.equal(runNode(root, GENERATOR).status, 0);

  const blocked = runNode(root, DEPLOYER, ['--function', 'scan-identify']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.output, /Uncommitted changes under supabase\/functions/);
  assert.match(blocked.output, /Nothing was deployed/);
});

test('deploy guard: refuses functions the manifest does not govern', (t) => {
  const root = makeFixtureRepo(t, { gitInit: true });

  // B34-DEF-001 widened GOVERNED_FUNCTIONS to every function this branch's
  // tree carries, so a genuinely ungoverned name has to be synthetic now --
  // there is no real function left in this tree to use as the example.
  const blocked = runNode(root, DEPLOYER, ['--function', 'totally-ungoverned-fixture-function']);
  assert.equal(blocked.status, 2);
  assert.match(blocked.output, /Not governed by the parity manifest/);
});

test('deploy guard: a wrong project reference aborts before deployment', (t) => {
  const root = makeFixtureRepo(t, { gitInit: true });
  const configPath = path.join(root, 'supabase', 'config.toml');
  // A fixture-only, obviously-fake ref -- must differ from APPROVED_PROJECT_REF
  // regardless of which real project that constant currently approves.
  const wrongRef = 'xxxxxxxxxxxxxxxxxxxxx';
  assert.notEqual(wrongRef, APPROVED_PROJECT_REF);
  fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace(APPROVED_PROJECT_REF, wrongRef));

  const blocked = runNode(root, DEPLOYER);
  assert.equal(blocked.status, 1);
  assert.match(blocked.output, /ABORTED|not the approved project reference|Project reference mismatch/);
  assert.ok(!/Deployment complete/.test(blocked.output));
});

test('deploy guard: refuses to run without a declared backend-authority marker', (t) => {
  const root = makeFixtureRepo(t, { gitInit: true });
  fs.rmSync(path.join(root, 'config', 'backend-authority.json'));

  const blocked = runNode(root, DEPLOYER);
  assert.equal(blocked.status, 1);
  assert.match(blocked.output, /config\/backend-authority\.json is missing/);
  assert.match(blocked.output, /ABORTED/);
  assert.ok(!/Deployment complete/.test(blocked.output));
});

test('deploy guard: refuses to run when the marker declares this checkout non-authoritative', (t) => {
  const root = makeFixtureRepo(t, { gitInit: true });
  fs.writeFileSync(
    path.join(root, 'config', 'backend-authority.json'),
    JSON.stringify({ role: 'mobile-integration-non-authoritative' }, null, 2),
  );

  const blocked = runNode(root, DEPLOYER);
  assert.equal(blocked.status, 1);
  assert.match(blocked.output, /explicitly marked non-authoritative/);
  assert.ok(!/Deployment complete/.test(blocked.output));
});
