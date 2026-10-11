const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);
const production = 'wyyuqfdxucjksghsmhry';
const staging = 'yzqjvdfgefveprobvvyw';
const commit = 'a'.repeat(40);

async function fixture(t, jwt = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-recovery-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'original-runner');
  const files = path.join(original, 'files');
  const sources = { 'scan-identify/index.ts': 'import {handler} from "./handler.ts"; import "../_shared/config.json"; Deno.serve(handler);',
    'scan-identify/handler.ts': 'export const handler = () => new Response("PRIVATE ORIGINAL SOURCE");',
    '_shared/config.json': '{"safe":true}', 'scan-identify/deno.jsonc': '{/* original runtime */}',
    'scan-identify/assets/template.html': '<p>Original asset</p>', '_shared/assets/engine.wasm': 'wasm fixture' };
  for (const [relative, bytes] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(files, relative)), { recursive: true });
    fs.writeFileSync(path.join(files, relative), bytes);
  }
  const lib = await load('scripts/lib/function-bundle-capture.mjs');
  const tree = lib.digestTree(files);
  const capture = lib.buildCaptureManifest({ functionName: 'scan-identify', projectRef: production,
    liveVersion: 172, verifyJwt: jwt, ezbrSha256: 'b'.repeat(64), status: 'ACTIVE',
    files: tree.files, treeDigest: tree.treeDigest, bundleLayout: 'functions-root' });
  const capturePath = path.join(original, 'capture.json');
  fs.writeFileSync(capturePath, JSON.stringify(capture));
  const manifest = { target: production, function_name: 'scan-identify', prior_version: 172,
    prior_bundle_hash: 'b'.repeat(64), new_source_commit: commit, verify_jwt: !jwt, capture_path: capturePath };
  const recovery = await load('scripts/lib/production-recovery.mjs');
  const bytes = recovery.packRecovery(manifest, capturePath);
  const reference = { bucket: recovery.RECOVERY_BUCKET, object: `controlled/123-1/${commit}.json`,
    sha256: recovery.recoveryHash(bytes), function_name: 'scan-identify', source_commit: commit, target: production };
  return { root, original, sources, capture, manifest, bytes, reference, recovery };
}

async function restoreOnlyTransferred(t, jwt = false) {
  const fixtureData = await fixture(t, jwt);
  const { root, original, bytes, reference, recovery, sources } = fixtureData;
  fs.rmSync(original, { recursive: true, force: true });
  const transferred = recovery.unpackRecovery(bytes, path.join(root, 'fresh-runner'), reference);
  const manifest = JSON.parse(fs.readFileSync(transferred.manifestPath, 'utf8'));
  const captureRoot = path.join(path.dirname(manifest.capture_path), 'files');
  const rollback = await load('scripts/rollback-production-function.mjs');
  let calls = 0;
  const result = rollback.restoreCapturedBundle({ functionName: 'scan-identify', captureRoot,
    files: transferred.plan.files, verifyJwt: transferred.plan.verifyJwt, bundleLayout: transferred.plan.bundleLayout,
    entrypoint: transferred.plan.entrypoint,
    run: (args, { cwd }) => {
      calls++;
      assert.deepEqual(args.slice(0, 3), ['functions', 'deploy', 'scan-identify']);
      assert.ok(args.includes(production));
      assert.equal(args.includes('--no-verify-jwt'), !jwt);
      const config = fs.readFileSync(path.join(cwd, 'supabase/config.toml'), 'utf8');
      assert.match(config, /entrypoint = "\.\/functions\/scan-identify\/index\.ts"/);
      assert.match(config, new RegExp(`verify_jwt = ${jwt}`));
      const staticFiles = JSON.parse(config.match(/^static_files = (.*)$/m)[1]);
      // Both CLI API StaticPatterns and Docker --static consume this list.
      // Emulate exact-pattern upload selection, including runtime-read assets.
      assert.deepEqual(staticFiles.sort(), Object.keys(sources).map((file) => `./functions/${file}`).sort());
      const selected = staticFiles.map((file) => fs.readFileSync(path.join(cwd, 'supabase', file), 'utf8'));
      assert.ok(selected.includes('<p>Original asset</p>'));
      assert.ok(selected.includes('wasm fixture'));
      for (const [relative, expected] of Object.entries(sources)) {
        assert.equal(fs.readFileSync(path.join(cwd, 'supabase/functions', relative), 'utf8'), expected);
      }
    } });
  assert.equal(calls, 1);
  return { ...fixtureData, transferred, result };
}

test('ROLLBACK-01 capture includes every required file and valid manifest', async (t) => {
  const f = await fixture(t);
  const transferred = f.recovery.unpackRecovery(f.bytes, path.join(f.root, 'fresh'), f.reference);
  assert.deepEqual(transferred.plan.files.sort(), Object.keys(f.sources).sort());
  assert.equal(transferred.plan.priorVersion, 172);
  assert.ok(transferred.plan.capturedAt);
});

test('ROLLBACK-02 restore runs with original runner deleted, only transferred bytes', async (t) => {
  const restored = await restoreOnlyTransferred(t);
  assert.equal(fs.existsSync(restored.original), false);
  assert.equal(restored.result.fileCount, 6);
});

test('ROLLBACK-03 corrupted package, modified and missing captured file fail closed', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.recovery.unpackRecovery(Buffer.from('tampered'), path.join(f.root, 'bad'), f.reference), /integrity/);
  for (const change of ['modified', 'missing']) {
    const pkg = JSON.parse(f.bytes);
    if (change === 'modified') pkg.files[0].bytes = Buffer.from('corrupted source').toString('base64');
    else pkg.files.pop();
    const bytes = Buffer.from(JSON.stringify(pkg));
    assert.throws(() => f.recovery.unpackRecovery(bytes, path.join(f.root, change),
      { ...f.reference, sha256: f.recovery.recoveryHash(bytes) }), /unusable|inventory/);
  }
});

test('ROLLBACK-04 original JWT is restored for both postures despite opposite failed-deploy value', async (t) => {
  await restoreOnlyTransferred(t, false);
  await restoreOnlyTransferred(t, true);
});

test('ROLLBACK-05 health and synthetic failures automatically restore and record failed deployment', async (t) => {
  for (const failure of ['health', 'synthetic', 'ambiguous CLI write']) {
    const f = await fixture(t);
    let restored = 0;
    let result;
    await assert.rejects(f.recovery.recoverAfterFailure({ attempted: () => true,
      operation: async () => { throw new Error(failure); },
      recover: async () => { await restoreOnlyTransferred(t); restored++; },
      record: (record) => { result = record; } }), /failed; original bundle restored/);
    assert.equal(restored, 1);
    assert.equal(result.ok, false);
    assert.equal(result.rollback_succeeded, true);
  }
});

test('ROLLBACK-06 Staging and foreign project restoration are rejected', async (t) => {
  const f = await fixture(t);
  for (const target of [staging, 'foreign-project']) {
    const pkg = JSON.parse(f.bytes); pkg.manifest.target = target;
    const bytes = Buffer.from(JSON.stringify(pkg));
    assert.throws(() => f.recovery.unpackRecovery(bytes, path.join(f.root, target),
      { ...f.reference, sha256: f.recovery.recoveryHash(bytes) }), /identity/);
  }
});

test('ROLLBACK-07 successful verification never rolls back', async (t) => {
  const f = await fixture(t); let recovered = 0; let recorded = 0;
  assert.equal(await f.recovery.recoverAfterFailure({ attempted: () => true, operation: async () => 'verified',
    recover: async () => { recovered++; }, record: () => { recorded++; } }), 'verified');
  assert.equal(recovered, 0); assert.equal(recorded, 0);
});

test('ROLLBACK-08 recovery failure records critical failure and instructions, never success', async (t) => {
  const f = await fixture(t); let result;
  await assert.rejects(f.recovery.recoverAfterFailure({ attempted: () => true,
    operation: async () => { throw new Error('validation'); },
    recover: async () => { throw new Error('restore failed'); }, record: (record) => { result = record; } }), /CRITICAL/);
  assert.equal(result.ok, false); assert.equal(result.rollback_succeeded, false);
  assert.equal(result.critical_recovery_failure, true); assert.match(result.next_action, /stop promotions/i);
});

function memoryStorage({ publicBucket = false, leak = false, failed = false } = {}) {
  const objects = new Map();
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname.replace('/storage/v1', '');
    const authorized = options.headers?.apikey === 'private-server-key';
    if (failed) return new Response('', { status: 503 });
    if (route.startsWith('/bucket/')) return Response.json({ id: 'production-function-recovery', public: publicBucket });
    if (!authorized) return new Response('', { status: leak ? 200 : 403 });
    if (options.method === 'POST') { objects.set(route.replace('/object/', ''), Buffer.from(options.body)); return new Response('{}'); }
    const key = route.replace('/object/authenticated/', '');
    return objects.has(key) ? new Response(objects.get(key)) : new Response('', { status: 404 });
  };
  return { objects, fetchImpl };
}

test('ROLLBACK-09 recovery source stays private; public bucket/access and unavailable storage refuse replacement', async (t) => {
  const f = await fixture(t);
  for (const options of [{ publicBucket: true }, { leak: true }, { failed: true }]) {
    const memory = memoryStorage(options);
    const store = f.recovery.privateRecoveryStore({ key: 'private-server-key', anonKey: 'publishable', fetchImpl: memory.fetchImpl });
    await assert.rejects(store.upload(f.bytes, f.reference), /private|confidentiality|unavailable/);
  }
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/production-controlled-deploy.yml'), 'utf8');
  for (const block of workflow.split(/- name: Upload/).slice(1)) {
    const upload = block.split(/\n {6}- name:|\n {2}[a-z]/)[0];
    assert.doesNotMatch(upload, /production-function-captures|capture\.json|\/files\/|production-private-recovery/);
  }
  assert.doesNotMatch(JSON.stringify(f.reference), /PRIVATE ORIGINAL SOURCE|private-server-key/);
});

test('ROLLBACK-10 interruption recovery works from private reference with no runner or artifact filesystem', async (t) => {
  const f = await fixture(t);
  const memory = memoryStorage();
  const store = f.recovery.privateRecoveryStore({ key: 'private-server-key', anonKey: 'publishable', fetchImpl: memory.fetchImpl });
  await store.upload(f.bytes, f.reference);
  fs.rmSync(f.original, { recursive: true, force: true });
  const reference = await store.readReference({ runId: '123', attempt: '1', sourceCommit: commit });
  const { recover } = await load('scripts/recover-production-function.mjs');
  let restored = false;
  const result = await recover(reference, { store, destination: path.join(f.root, 'interruption-runner'),
    rollback: async (manifestPath) => { assert.ok(fs.existsSync(JSON.parse(fs.readFileSync(manifestPath)).capture_path)); restored = true; } });
  assert.equal(restored, true); assert.equal(result.ok, true);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/production-function-recovery.yml'), 'utf8');
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /group: kscan-production-deployment/);
  assert.match(workflow, /RESTORE PRODUCTION CAPTURE/);
});

test('safe pre-write refusals do not restore an untouched function', async (t) => {
  const f = await fixture(t); let restored = 0;
  await assert.rejects(f.recovery.recoverAfterFailure({ attempted: () => false,
    operation: async () => { throw new Error('stale capture'); }, recover: async () => { restored++; }, record: () => {} }), /before replacement/);
  assert.equal(restored, 0);
});

test('no-cost contract probes reject boot/auth/contract/leak failures and never send provider inputs', async () => {
  const { checkProductionContract } = await load('scripts/lib/production-contract-check.mjs');
  const run = (bad) => checkProductionContract({ functionName: 'scan-identify', url: `https://${production}.supabase.co`,
    anonKey: 'publishable', verifyJwt: false, fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, undefined);
      assert.doesNotMatch(options.body || '', /imageBase64|textQuery|identification|searchQueries/);
      if (options.method === 'OPTIONS') return new Response(bad === 'boot' ? 'BOOT_ERROR' : 'ok');
      if (options.body === '{') return Response.json({ error: bad === 'leak' ? 'sb_secret_sensitive' : 'Invalid JSON' }, { status: 400 });
      if (options.body.includes('contractVersion')) return Response.json({ error: { code: bad === 'contract' ? 'WRONG' : 'UNSUPPORTED_CONTRACT_VERSION' } }, { status: 400 });
      return Response.json({ error: 'commerce_only_auth_required' }, { status: bad === 'auth' ? 200 : 401 });
    } });
  assert.equal((await run()).ok, true);
  for (const bad of ['boot', 'leak', 'contract', 'auth']) assert.equal((await run(bad)).ok, false, bad);
});

test('private recovery checks reviewed RLS and reuses protected credential without generation or logging', async () => {
  const { managedRecoveryStore, verifyRecoveryPolicies } = await load('scripts/lib/production-recovery.mjs');
  const policies = require('../fixtures/productionRecoveryReviewedPolicies.json').map((row) => ({ ...row, rls_enabled: true }));
  assert.doesNotThrow(() => verifyRecoveryPolicies(policies));
  for (const mutation of [[], policies.map((row) => ({ ...row, rls_enabled: false })),
    [...policies, { policyname: 'Everyone can read', qual: 'true', rls_enabled: true }],
    policies.map((row) => ({ ...row, qual: 'true' }))]) assert.throws(() => verifyRecoveryPolicies(mutation), /RLS|policies/);
  let creates = 0; let bucketExists = false;
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith(`https://api.supabase.com/v1/projects/${production}`) || url.startsWith(`https://${production}.supabase.co`));
    if (url.endsWith('/database/query')) {
      assert.match(JSON.parse(options.body).query, /^select /);
      return Response.json(policies);
    }
    if (url.endsWith('/api-keys?reveal=true')) {
      assert.equal(options.method, undefined);
      return Response.json([{ name: 'service_role', api_key: 'private-server-key' }]);
    }
    if (url.endsWith('/bucket') && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { id: 'production-function-recovery', name: 'production-function-recovery',
        public: false, file_size_limit: 20971520, allowed_mime_types: ['application/json'] });
      creates++; bucketExists = true; return Response.json({});
    }
    assert.ok(url.endsWith('/bucket/production-function-recovery'));
    assert.equal(options.headers.apikey, 'private-server-key');
    return bucketExists ? Response.json({ id: 'production-function-recovery', public: false }) : new Response('', { status: 404 });
  };
  await managedRecoveryStore({ token: 'protected-management-token', anonKey: 'publishable', prepare: true, fetchImpl });
  assert.equal(creates, 1);
  await managedRecoveryStore({ token: 'protected-management-token', anonKey: 'publishable', prepare: true, fetchImpl });
  assert.equal(creates, 1);
  await assert.rejects(managedRecoveryStore({ token: 'token', anonKey: 'publishable', fetchImpl: async () => new Response('sb_secret_sensitive', { status: 403 }) }),
    (error) => !error.message.includes('sb_secret_sensitive') && /denied/.test(error.message));
});

test('ROLLBACK-09 failed capture child stderr is never re-emitted by the parent', () => {
  const helper = pathToFileURL(path.join(ROOT, 'scripts/lib/private-function-capture.mjs')).href;
  const probe = `import {runPrivateCapture} from ${JSON.stringify(helper)}; import {execFileSync} from 'node:child_process';
    try { runPrivateCapture('scan-identify', {exec: (bin, args, options) => execFileSync(process.execPath,
      ['-e', 'process.stderr.write("PRIVATE_FAKE_SOURCE_AND_KEY");process.exit(1)'], options)}); }
    catch (error) {console.error(error.message);process.exitCode=1;}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI output withheld/);
  assert.doesNotMatch(result.stderr + result.stdout, /PRIVATE_FAKE_SOURCE_AND_KEY/);
});

test('unreadable, empty and malformed live inventories cannot become new-function deletion plans', async () => {
  const { parseFunctionInventory } = await load('scripts/deploy-production-function.mjs');
  for (const response of ['invalid JSON', '{}', '[]', '[null]', '[{}]', '{"functions":{}}']) {
    assert.throws(() => parseFunctionInventory(response));
  }
  const rows = [{ slug: 'scan-identify', version: 172, verify_jwt: false }];
  assert.deepEqual(parseFunctionInventory(JSON.stringify(rows)), rows);
  assert.deepEqual(parseFunctionInventory(JSON.stringify({ functions: rows })), rows);
  assert.throws(() => parseFunctionInventory(JSON.stringify([...rows, ...rows])), /Ambiguous/);
});

test('actual download accepts only known CLI cache and refuses source escapes', async (t) => {
  const { downloadLiveBundle } = await load('scripts/capture-production-function.mjs');
  for (const bookkeeping of [null, 'supabase/.temp/cli-latest', 'supabase/.temp/unexpected-source.ts', 'escaped.ts']) {
    let scratch;
    const run = (args, { cwd }) => {
      scratch = cwd;
      t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
      const entrypoint = path.join(cwd, 'supabase/functions/scan-identify/index.ts');
      fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
      fs.writeFileSync(entrypoint, 'Deno.serve(() => new Response("ok"));');
      if (bookkeeping) {
        const file = path.join(cwd, bookkeeping);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'v2.109.1');
      }
    };
    if (bookkeeping && bookkeeping !== 'supabase/.temp/cli-latest') {
      assert.throws(() => downloadLiveBundle('scan-identify', { run }), /outside the recoverable/);
    } else {
      const result = downloadLiveBundle('scan-identify', { run });
      assert.equal(result.downloaded, path.join(scratch, 'supabase/functions'));
    }
  }
});

test('candidate identity rejects stale source, wrong metadata and entrypoint; exact same-source no-op is explicit', async (t) => {
  const f = await fixture(t);
  const { verifyCandidateIdentity } = await load('scripts/lib/production-candidate-identity.mjs');
  const approved = path.join(f.root, 'approved-functions');
  fs.cpSync(path.join(f.original, 'files'), approved, { recursive: true });
  const captured = { capture_path: path.join(f.original, 'capture.json') };
  const deployed = { version: 172, ezbr_sha256: 'b'.repeat(64), status: 'ACTIVE', verify_jwt: false };
  const input = { captured, deployed, prior: deployed, priorCapture: f.capture,
    sourceRoot: approved, functionName: 'scan-identify', projectRef: production, verifyJwt: false };
  assert.equal(verifyCandidateIdentity(input).same_source_noop, true);
  fs.writeFileSync(path.join(approved, 'scan-identify/handler.ts'), 'NEW APPROVED CANDIDATE');
  assert.throws(() => verifyCandidateIdentity(input), /differs from approved candidate/);
  fs.writeFileSync(path.join(approved, 'scan-identify/handler.ts'), f.sources['scan-identify/handler.ts']);
  assert.throws(() => verifyCandidateIdentity({ ...input, priorCapture: { ...f.capture, tree_digest: 'wrong' } }), /Unchanged deployment/);
  assert.throws(() => verifyCandidateIdentity({ ...input, deployed: { ...deployed, version: 173 } }), /identity/);
  const invalid = { ...f.capture, entrypoint: 'scan-identify/handler.ts' };
  fs.writeFileSync(captured.capture_path, JSON.stringify(invalid));
  assert.throws(() => verifyCandidateIdentity(input), /identity/);
  const next = { ...f.capture, live_version: 173, ezbr_sha256: 'c'.repeat(64) };
  fs.writeFileSync(captured.capture_path, JSON.stringify(next));
  const nextInput = { ...input, deployed: { ...deployed, version: 173, ezbr_sha256: next.ezbr_sha256 } };
  assert.equal(verifyCandidateIdentity(nextInput).same_source_noop, false);
  fs.rmSync(path.join(f.original, 'files/_shared/config.json'));
  const { digestTree } = await load('scripts/lib/function-bundle-capture.mjs');
  const tree = digestTree(path.join(f.original, 'files'));
  fs.writeFileSync(captured.capture_path, JSON.stringify({ ...next,
    files: tree.files, file_count: tree.files.length, tree_digest: tree.treeDigest }));
  assert.throws(() => verifyCandidateIdentity(nextInput), /missing an approved local dependency/);
});

test('ZAP baseline retains complete passive scan and reports while avoiding failing automation framework', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/zap-baseline-staging.yml'), 'utf8');
  assert.match(workflow, /zap-baseline\.py\s*\\\s*--autooff/);
  for (const required of ['-t "${ZAP_STAGING_URL}"', '-c .zap/baseline-rules.tsv', '-m 3', '-T 10',
    '-J zap-out/zap-baseline-report.json', 'Operational failure: zap-baseline-report.json missing']) {
    assert.ok(workflow.includes(required), required);
  }
});

test('actual deployment rejects stale candidate and rolls back; exact same source and changed approved candidate succeed', () => {
  for (const mode of ['stale-candidate', 'same-source', 'changed-success']) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules',
      path.join(ROOT, '__tests__/helpers/productionDeployMainProbe.mjs'), ROOT, mode], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).passed, true);
  }
});
