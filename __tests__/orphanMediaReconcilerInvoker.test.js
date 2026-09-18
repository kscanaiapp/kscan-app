// B34-BE-STO-001 -- governed invoker for the staging orphan-owner media reconciler.
//
// The reconciler itself (reconcile-orphan-media, B33-STO-002) is pinned by
// orphanOwnerMediaReconciliation.test.js. What is pinned here is the CALLER: it
// can only target staging, can only authenticate with the sweep secret, can never
// express a live sweep, never prints the secret or an object path, and fails the
// run whenever the function reports anything other than a disarmed dry run.
//
// Offline: every request goes to an injected fetch. No network, no secrets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'invoke-orphan-media-reconciler.mjs');
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'staging-orphan-media-reconciler.yml'),
  'utf8',
);
const FUNCTION_SOURCE = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'reconcile-orphan-media', 'index.ts'),
  'utf8',
);

const SECRET = 'test-sweep-secret-0123456789abcdef';
const STAGING_URL = 'https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/reconcile-orphan-media';

const DRY_RUN_BODY = Object.freeze({
  mode: 'dry_run',
  bucket: 'style-library-images',
  killSwitchEnabled: false,
  dryRun: true,
  candidateCount: 30,
  distinctOwners: 6,
  totalBytes: 10662345,
  hasMore: false,
  note: 'No object was deleted. Candidates are unreferenced objects whose owner no longer resolves.',
});

let mod;
test.before(async () => {
  mod = await import(pathToFileURL(SCRIPT).href);
});

function fakeFetch({ status = 200, body = DRY_RUN_BODY, rawText = null, throws = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw throws;
    return {
      status,
      bodyRead: false,
      async json() {
        this.bodyRead = true;
        if (rawText !== null) return JSON.parse(rawText);
        return JSON.parse(JSON.stringify(body));
      },
    };
  };
  fn.calls = calls;
  return fn;
}

async function rejectsWith(promise, exitCode, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'InvokerError');
    assert.equal(error.exitCode, exitCode);
    if (pattern) assert.match(error.message, pattern);
    assert.ok(!error.message.includes(SECRET), 'an error message must never carry the secret');
    return true;
  });
}

// ── Target authority ────────────────────────────────────────────────────────

test('the production project is refused before any request, even with a valid secret', async () => {
  const fetchImpl = fakeFetch();
  await rejectsWith(
    mod.invokeReconciler({ secret: SECRET, ref: mod.PRODUCTION_REF, fetchImpl }),
    mod.EXIT.CONFIG,
    /production/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('any ref other than the staging literal is refused before any request', async () => {
  const fetchImpl = fakeFetch();
  await rejectsWith(
    mod.invokeReconciler({ secret: SECRET, ref: 'abcdefghijklmnopqrst', fetchImpl }),
    mod.EXIT.CONFIG,
    /Unrecognised/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('the default target is the literal staging function URL', () => {
  assert.equal(mod.targetUrl(), STAGING_URL);
  assert.notEqual(mod.STAGING_REF, mod.PRODUCTION_REF);
});

// ── Authentication ──────────────────────────────────────────────────────────

for (const [label, secret] of [['missing', undefined], ['empty', ''], ['whitespace', '   ']]) {
  test(`a ${label} secret fails closed without sending a request`, async () => {
    const fetchImpl = fakeFetch();
    await rejectsWith(mod.invokeReconciler({ secret, fetchImpl }), mod.EXIT.CONFIG, /not set/);
    assert.equal(fetchImpl.calls.length, 0);
  });
}

test('the request is a POST carrying only the sweep-secret header and an empty body', async () => {
  const fetchImpl = fakeFetch();
  await mod.invokeReconciler({ secret: `  ${SECRET}  `, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, STAGING_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-orphan-sweep-secret'], SECRET);
  const headerNames = Object.keys(init.headers).map((h) => h.toLowerCase()).sort();
  assert.deepEqual(headerNames, ['content-type', 'x-orphan-sweep-secret']);
  assert.equal(init.body, '{}', 'no field that could look like a mode selector is ever sent');
  assert.ok(init.signal, 'the request is time-bounded');
});

// ── The dry-run invariant ───────────────────────────────────────────────────

test('a disarmed dry run is projected to counts and flags only', async () => {
  const summary = await mod.invokeReconciler({ secret: SECRET, fetchImpl: fakeFetch() });
  assert.deepEqual(summary, {
    httpStatus: 200,
    mode: 'dry_run',
    dryRun: true,
    killSwitchEnabled: false,
    candidateCount: 30,
    distinctOwners: 6,
    totalBytes: 10662345,
    hasMore: false,
    objectsDeleted: 0,
  });
});

const ARMED_RESPONSES = [
  ['a live sweep that removed objects', { mode: 'live', bucket: 'style-library-images', removed: 3, distinctOwners: 1, totalBytes: 10, hasMore: false }],
  ['a live sweep that removed nothing', { mode: 'live', bucket: 'style-library-images', removed: 0, distinctOwners: 0, totalBytes: 0, hasMore: false }],
  ['a dry run with the kill switch armed', { ...DRY_RUN_BODY, killSwitchEnabled: true }],
  ['a dry-run label with dryRun=false', { ...DRY_RUN_BODY, dryRun: false }],
  ['a dry run that reports removals', { ...DRY_RUN_BODY, removed: 0 }],
  ['a response with no mode at all', { ...DRY_RUN_BODY, mode: undefined }],
  ['a kill switch reported as a string', { ...DRY_RUN_BODY, killSwitchEnabled: 'false' }],
];

for (const [label, body] of ARMED_RESPONSES) {
  test(`INVARIANT: ${label} fails the run with exit 3`, async () => {
    await rejectsWith(
      mod.invokeReconciler({ secret: SECRET, fetchImpl: fakeFetch({ body }) }),
      mod.EXIT.INVARIANT,
      /DRY-RUN INVARIANT VIOLATED/,
    );
  });
}

test('negative control: removing the invariant guard lets an armed response through', async (t) => {
  // Mutate a temp copy only -- never the deployable script. If the INVARIANT tests
  // above were passing for an unrelated reason, this unguarded copy would still
  // reject the armed response and this control would fail.
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const guard = /const armed =\n[\s\S]*?Object\.prototype\.hasOwnProperty\.call\(body, 'removed'\);/;
  assert.match(source, guard, 'guard text moved -- update this control');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-invoker-nc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const brokenPath = path.join(dir, 'unguarded.mjs');
  fs.writeFileSync(brokenPath, source.replace(guard, 'const armed = false;'));
  const broken = await import(pathToFileURL(brokenPath).href);

  const armedDryRunLabel = { ...DRY_RUN_BODY, killSwitchEnabled: true, removed: 0 };
  assert.throws(() => mod.projectDryRunResponse(armedDryRunLabel), /DRY-RUN INVARIANT VIOLATED/);
  assert.doesNotThrow(() => broken.projectDryRunResponse(armedDryRunLabel));
});

// ── Response handling ───────────────────────────────────────────────────────

for (const status of [401, 403, 500, 503]) {
  test(`HTTP ${status} fails the run without reading the response body`, async () => {
    const fetchImpl = async (url, init) => {
      fetchImpl.response = {
        status,
        bodyRead: false,
        async json() { this.bodyRead = true; return {}; },
        async text() { this.bodyRead = true; return 'internal detail'; },
      };
      return fetchImpl.response;
    };
    await rejectsWith(mod.invokeReconciler({ secret: SECRET, fetchImpl }), mod.EXIT.RESPONSE, new RegExp(`HTTP ${status}`));
    assert.equal(fetchImpl.response.bodyRead, false);
  });
}

test('an unparseable body fails the run', async () => {
  await rejectsWith(
    mod.invokeReconciler({ secret: SECRET, fetchImpl: fakeFetch({ rawText: '<html>' }) }),
    mod.EXIT.RESPONSE,
    /not valid JSON/,
  );
});

test('a transport failure fails the run without echoing the request', async () => {
  const error = new TypeError(`fetch failed for ${SECRET}`);
  await rejectsWith(
    mod.invokeReconciler({ secret: SECRET, fetchImpl: fakeFetch({ throws: error }) }),
    mod.EXIT.RESPONSE,
    /transport layer \(TypeError\)/,
  );
});

for (const [field, value] of [
  ['candidateCount', -1],
  ['candidateCount', '30'],
  ['distinctOwners', 1.5],
  ['totalBytes', null],
  ['hasMore', 'false'],
]) {
  test(`a malformed ${field}=${JSON.stringify(value)} fails the run`, async () => {
    await rejectsWith(
      mod.invokeReconciler({ secret: SECRET, fetchImpl: fakeFetch({ body: { ...DRY_RUN_BODY, [field]: value } }) }),
      mod.EXIT.RESPONSE,
      new RegExp(field),
    );
  });
}

test('the projection never carries a path, owner id, bucket, or free text', () => {
  const noisy = { ...DRY_RUN_BODY, objects: ['user/abc/scan.jpg'], owner_prefix: 'deadbeef' };
  const out = JSON.stringify(mod.projectDryRunResponse(noisy));
  for (const leak of ['user/abc', 'deadbeef', 'style-library-images', 'No object was deleted']) {
    assert.ok(!out.includes(leak), `projection leaked ${leak}`);
  }
});

// ── CLI entrypoint ──────────────────────────────────────────────────────────

test('main() with no secret exits 1 and prints nothing to stdout', async (t) => {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (line) => out.push(String(line)));
  t.mock.method(console, 'error', (line) => err.push(String(line)));
  const code = await mod.main([], {});
  assert.equal(code, mod.EXIT.CONFIG);
  assert.deepEqual(out, []);
  assert.match(err.join('\n'), /::error::ORPHAN_MEDIA_SWEEP_SECRET is not set/);
});

test('main() rejects unknown arguments -- no flag can widen the invoker', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const argv of [['--live'], ['--ref', 'wyyuqfdxucjksghsmhry'], ['--mode=live'], ['--url', 'https://example.invalid']]) {
    assert.equal(await mod.main(argv, { ORPHAN_MEDIA_SWEEP_SECRET: SECRET }), mod.EXIT.CONFIG, argv.join(' '));
  }
});

test('main() writes the sanitized summary file and never the secret', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-invoker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const summaryFile = path.join(dir, 'summary.json');
  const out = [];
  t.mock.method(console, 'log', (line) => out.push(String(line)));
  t.mock.method(globalThis, 'fetch', fakeFetch());
  const code = await mod.main(['--summary-file', summaryFile], { ORPHAN_MEDIA_SWEEP_SECRET: SECRET });
  assert.equal(code, mod.EXIT.OK);
  const written = fs.readFileSync(summaryFile, 'utf8');
  assert.equal(JSON.parse(written).objectsDeleted, 0);
  assert.ok(!written.includes(SECRET));
  assert.ok(!out.join('\n').includes(SECRET));
});

// ── The function's side of the contract this invoker relies on ─────────────

test('the reconciler still selects its mode server-side only', () => {
  assert.ok(!/req\.(json|text|formData|arrayBuffer)\(/.test(FUNCTION_SOURCE), 'the function must not read a request body');
  assert.ok(FUNCTION_SOURCE.includes("readAppConfigFlag('orphan_media_sweep_enabled')"));
  assert.ok(FUNCTION_SOURCE.includes("readAppConfigFlag('orphan_media_sweep_dry_run')"));
  assert.ok(FUNCTION_SOURCE.includes("Deno.env.get('ORPHAN_MEDIA_SWEEP_DRY_RUN')"));
  assert.ok(FUNCTION_SOURCE.includes('const dryRun = envDryRun || dryRunFlag || !enabled;'));
  assert.ok(FUNCTION_SOURCE.includes("req.headers.get('x-orphan-sweep-secret')"));
});

test('the dry-run response fields this invoker validates are the ones the function emits', () => {
  for (const field of ['killSwitchEnabled: enabled', 'dryRun: true', 'candidateCount: candidates.length', 'distinctOwners', 'totalBytes', 'hasMore']) {
    assert.ok(FUNCTION_SOURCE.includes(field), `function no longer emits ${field}`);
  }
  assert.ok(FUNCTION_SOURCE.includes("mode: 'live'"), 'live responses must stay distinguishable');
});

// ── Workflow contract ───────────────────────────────────────────────────────

function job(name) {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.ok(start !== -1, `job ${name} missing`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('workflow: the invoke job targets only the staging literal and denies production', () => {
  const invoke = job('invoke-reconciler');
  assert.match(invoke, /STAGING_REF: yzqjvdfgefveprobvvyw/);
  assert.match(invoke, /PRODUCTION_REF: wyyuqfdxucjksghsmhry/);
  assert.match(invoke, /FUNCTION_SLUG: reconcile-orphan-media/);
  assert.match(invoke, /environment: staging/);
  assert.match(invoke, /Target ref equals the production ref\. Refusing\./);
  assert.ok(invoke.indexOf('Assert staging authority') < invoke.indexOf('Invoke reconciler'));
});

test('workflow: the only secret is the sweep secret, and it never reaches a command line', () => {
  const secrets = [...WORKFLOW.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)], ['ORPHAN_MEDIA_SWEEP_SECRET']);
  const code = WORKFLOW.replace(/^\s*#.*$/gm, '');
  assert.ok(!/SERVICE_ROLE|PUBLISHABLE|ANON_KEY|ACCESS_TOKEN/.test(code));
  // Secrets are only ever bound in an `env:` mapping line, so a `run:` script sees
  // an environment variable and the value is never templated into shell text.
  const secretLines = WORKFLOW.split('\n').filter((line) => line.includes('secrets.'));
  assert.equal(secretLines.length, 1);
  assert.match(secretLines[0], /^ {10}ORPHAN_MEDIA_SWEEP_SECRET: \$\{\{ secrets\.ORPHAN_MEDIA_SWEEP_SECRET \}\}$/);
  assert.ok(!/(echo|printf|curl)[^\n]*ORPHAN_MEDIA_SWEEP_SECRET/.test(code), 'the secret variable is never echoed or put on a command line');
});

test('workflow: no input or step can express a live sweep', () => {
  const code = WORKFLOW.replace(/^\s*#.*$/gm, '');
  assert.ok(!/inputs\.(mode|confirm|live|dry_run)/.test(code));
  assert.ok(!/options:/.test(code), 'no mode dropdown');
  assert.ok(!/orphan_media_sweep_enabled|orphan_media_sweep_dry_run/.test(code), 'the workflow never touches the server switches');
  assert.match(code, /node scripts\/invoke-orphan-media-reconciler\.mjs --summary-file reconciler-summary\.json/);
});

test('workflow: pull requests run only the offline contract job', () => {
  const contract = job('contract');
  assert.match(contract, /if: github\.event_name == 'pull_request'/);
  assert.ok(!/secrets\.|environment:/.test(contract), 'the PR job has no secret and no environment');
  assert.match(job('invoke-reconciler'), /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
});

test('workflow: least privilege, serialised, bounded, and pinned actions', () => {
  assert.match(WORKFLOW, /\npermissions:\n {2}contents: read\n/);
  assert.match(WORKFLOW, /concurrency:\n {2}group: staging-orphan-media-reconciler\n {2}cancel-in-progress: false/);
  for (const name of ['contract', 'invoke-reconciler']) assert.match(job(name), /timeout-minutes: 10/);
  for (const m of WORKFLOW.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(m[1], /@[0-9a-f]{40}$/, `action not pinned to a commit: ${m[1]}`);
  }
  assert.match(WORKFLOW, /cron: '40 9 \* \* \*'/);
});
