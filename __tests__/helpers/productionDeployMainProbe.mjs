// Run the actual deployer with external I/O replaced; never touches a live service.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const repo = process.argv[2];
const mode = process.argv[3];
const target = 'wyyuqfdxucjksghsmhry';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-deploy-main-proof-'));
const load = (file) => import(pathToFileURL(path.join(repo, file)).href);
try {
  const lib = await load('scripts/lib/function-bundle-capture.mjs');
  const recovery = await load('scripts/lib/production-recovery.mjs');
  const candidate = await load('scripts/lib/production-candidate-identity.mjs');
  const sourceRoot = path.join(root, 'supabase/functions');
  const oldFiles = path.join(root, 'prior/files');
  fs.mkdirSync(path.join(oldFiles, 'scan-identify'), { recursive: true });
  fs.writeFileSync(path.join(oldFiles, 'scan-identify/index.ts'), 'Deno.serve(() => new Response("ORIGINAL"));');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.cpSync(oldFiles, sourceRoot, { recursive: true });
  if (mode !== 'same-source') fs.writeFileSync(path.join(sourceRoot, 'scan-identify/index.ts'), 'Deno.serve(() => new Response("CANDIDATE"));');
  const prior = { slug: 'scan-identify', version: 172, verify_jwt: false, ezbr_sha256: 'b'.repeat(64), status: 'ACTIVE' };
  const promoted = mode === 'changed-success' ? { ...prior, version: 173, ezbr_sha256: 'c'.repeat(64) } : prior;
  const makeCapture = (dir, files, live) => {
    const tree = lib.digestTree(files);
    const capture = lib.buildCaptureManifest({ functionName: 'scan-identify', projectRef: target, liveVersion: live.version,
      verifyJwt: false, ezbrSha256: live.ezbr_sha256, status: 'ACTIVE', files: tree.files,
      treeDigest: tree.treeDigest, bundleLayout: 'functions-root' });
    const capturePath = path.join(dir, 'capture.json');
    fs.writeFileSync(capturePath, JSON.stringify(capture));
    return { capture_path: capturePath };
  };
  const original = makeCapture(path.join(root, 'prior'), oldFiles, prior);
  const afterFiles = path.join(root, 'after/files');
  fs.mkdirSync(path.dirname(afterFiles), { recursive: true });
  fs.cpSync(mode === 'changed-success' ? sourceRoot : oldFiles, afterFiles, { recursive: true });
  const after = makeCapture(path.join(root, 'after'), afterFiles, promoted);
  const records = []; const calls = []; let inventories = 0; let captures = 0;
  const processStub = { env: { SUPABASE_ACCESS_TOKEN: 'fake', SUPABASE_PRODUCTION_PROJECT_REF: target,
    SUPABASE_PRODUCTION_URL: `https://${target}.supabase.co`, SUPABASE_PRODUCTION_ANON_KEY: 'fake-publishable',
    DEPLOY_FUNCTIONS: 'scan-identify', FUNCTION_NAME: 'scan-identify', EXPECTED_VERIFY_JWT: 'false',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }, argv: [], execPath: process.execPath,
    cwd: () => root, exit: (code) => { throw new Error(`exit ${code}`); } };
  const context = vm.createContext({ process: processStub, Buffer, AbortController, setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {} }, fetch: async () => new Response('ok'), Response });
  const exports = {
    'node:fs': { default: fs }, 'node:path': { default: path }, 'node:os': { default: os }, 'node:url': { pathToFileURL },
    'node:child_process': { execFileSync: (bin, args) => { calls.push(args); return ''; } },
    './lib/staging-helpers.mjs': { parseDeployFunctionsAllowList: () => ['scan-identify'],
      sha256File: (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      ensureArtifactsDir: () => path.join(root, 'records'), writeJsonArtifact: (file, obj) => records.push({ file, obj }),
      gitHeadSha: () => 'a'.repeat(40), fail: (message) => { throw new Error(message); } },
    './lib/production-helpers.mjs': { assertProductionTarget: () => ({ projectRef: target }),
      missingRequiredProductionVars: () => [], runSupabaseProduction: (args) => {
        calls.push(args);
        return JSON.stringify([args[1] === 'list' && ++inventories >= 3 ? promoted : prior]);
      }, PRODUCTION_PROJECT_REF: target },
    './production-deploy-preflight.mjs': { assertGovernedCommit() {} },
    './lib/supabase-deploy-retry.mjs': { runWithTransientEdgeRuntimePullRetry: async (operation) => operation() },
    './lib/production-recovery.mjs': { packRecovery: () => Buffer.from('{}'), unpackRecovery() {},
      recoveryHash: () => 'd'.repeat(64), managedRecoveryStore: async () => ({ upload: async (bytes) => bytes }),
      recoverAfterFailure: recovery.recoverAfterFailure, RECOVERY_BUCKET: recovery.RECOVERY_BUCKET },
    './lib/production-contract-check.mjs': { checkProductionContract: async () => ({ ok: true }) },
    './lib/private-function-capture.mjs': { runPrivateCapture: () => ++captures === 1 ? original : after },
    './lib/production-candidate-identity.mjs': { verifyCandidateIdentity: candidate.verifyCandidateIdentity },
  };
  const source = fs.readFileSync(path.join(repo, 'scripts/deploy-production-function.mjs'), 'utf8') + '\nexport {main as probeMain};';
  const main = new vm.SourceTextModule(source, { context, identifier: 'actual-production-deployer' });
  await main.link(async (specifier) => {
    const values = exports[specifier];
    assert.ok(values, `Unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await main.evaluate();
  let error = null;
  try { await main.namespace.probeMain(); } catch (failure) { error = failure.message; }
  const rollbacks = calls.filter((args) => args.some((arg) => String(arg).includes('rollback-production-function'))).length;
  if (mode === 'stale-candidate') {
    assert.match(error || '', /original bundle restored/);
    assert.equal(rollbacks, 1);
    const failure = records.find(({ obj }) => obj.rollback_required)?.obj;
    assert.equal(failure.ok, false); assert.equal(failure.rollback_succeeded, true);
    assert.equal(records.some(({ obj }) => obj.identity_verified === true), false);
  } else {
    assert.equal(error, null); assert.equal(rollbacks, 0);
    const success = records.find(({ obj }) => obj.identity_verified)?.obj;
    assert.ok(success); assert.equal(success.candidate_identity.same_source_noop, mode === 'same-source');
  }
  process.stdout.write(JSON.stringify({ mode, rollbacks, passed: true }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
