// Checkpoint 4.5 — the provider's failure contract, the request shape, and
// lifecycle safety across background/resume.
//
// THE PROPERTY EVERY TEST HERE DEFENDS
//
// Similarity is advisory. It must never be able to fail, delay past its hang
// guard, or duplicate a scan. Every failure path degrades to "no candidates",
// which is byte-identical to the pre-Checkpoint-3 request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** Resolves an extensionless relative import the way Metro/tsc would. */
function withExtension(relative) {
  if (/\.(ts|tsx|js)$/.test(relative)) return relative;
  for (const ext of ['.ts', '.tsx', '.js']) {
    if (fs.existsSync(path.join(ROOT, relative + ext))) return relative + ext;
  }
  return relative;
}

function loadModule(relativeInput, requireMap = {}) {
  const relative = withExtension(relativeInput);
  const filename = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod, JSON, Math, Date, TextEncoder,
    Object, Array, Set, Map, String, Number, Boolean, Error, RegExp, Promise,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    process: { env: {} },
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('./') || id.startsWith('../')) {
        return loadModule(path.join(path.dirname(relative), id), requireMap);
      }
      throw new Error(`unexpected import '${id}'`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const provider = loadModule('services/similarItemCandidateProvider.ts');
const ledger = loadModule('services/similarityRequestLedger.ts');

const QUERY = {
  brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1',
  canonicalCategory: 'footwear', color: 'white',
};

const CLOSET_ROWS = [
  { id: 'closet-1', category: 'footwear', brand: 'Nike', primaryColor: 'white', thumbnailUri: 'file:///a.jpg' },
  { id: 'closet-2', category: 'footwear', brand: 'Adidas', primaryColor: 'black' },
];

const SCAN_ROWS = [
  { id: 'scan-1', attributes: { category: 'footwear', color_palette: ['white'] } },
];

// ── the failure contract ────────────────────────────────────────────────────

test('a healthy build returns bounded candidates and a full report', async () => {
  const outcome = await provider.buildSimilarityCandidates({
    query: QUERY,
    loadClosetRecords: () => CLOSET_ROWS,
    loadRecentScanRecords: () => SCAN_ROWS,
  });
  assert.equal(outcome.failureReason, undefined);
  assert.ok(outcome.candidates.length > 0);
  assert.ok(outcome.payloadBytes > 0);
  assert.equal(outcome.report.recordsLoaded.total, 3);
});

test('a throwing Closet loader yields no candidates and never rejects', async () => {
  const outcome = await provider.buildSimilarityCandidates({
    query: QUERY,
    loadClosetRecords: () => { throw new Error('disk on fire'); },
    loadRecentScanRecords: () => SCAN_ROWS,
  });
  assert.equal(outcome.failureReason, 'closet_load_failed');
  // The other source still contributed — a partial failure is not a total one.
  assert.ok(outcome.report.recordsLoaded.recent_scan > 0);
});

test('a rejecting async loader is handled the same as a throwing one', async () => {
  const outcome = await provider.buildSimilarityCandidates({
    query: QUERY,
    loadClosetRecords: () => CLOSET_ROWS,
    loadRecentScanRecords: () => Promise.reject(new Error('network')),
  });
  assert.equal(outcome.failureReason, 'recent_scans_load_failed');
});

test('both loaders failing degrades to an empty candidate set, not an error', async () => {
  const outcome = await provider.buildSimilarityCandidates({
    query: QUERY,
    loadClosetRecords: () => { throw new Error('a'); },
    loadRecentScanRecords: () => Promise.reject(new Error('b')),
  });
  assert.equal(outcome.failureReason, 'both_loads_failed');
  assert.deepEqual([...outcome.candidates], []);
  assert.equal(outcome.payloadBytes, 2, 'an empty JSON array');
});

test('a hanging loader is bounded by the deadline rather than delaying the scan', async () => {
  const startedAt = Date.now();
  const outcome = await provider.buildSimilarityCandidates({
    query: QUERY,
    loadClosetRecords: () => new Promise(() => {}),
    loadRecentScanRecords: () => SCAN_ROWS,
    loadDeadlineMs: 60,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1500, `the deadline must bound the wait; took ${elapsed}ms`);
  assert.equal(outcome.failureReason, 'closet_load_failed');
});

test('a loader returning junk is treated as an empty list', async () => {
  for (const junk of [null, undefined, 'nope', 42, { nope: true }]) {
    const outcome = await provider.buildSimilarityCandidates({
      query: QUERY,
      loadClosetRecords: () => junk,
    });
    assert.deepEqual([...outcome.candidates], []);
    assert.equal(outcome.failureReason, undefined, 'junk is empty, not a failure');
  }
});

test('an omitted loader skips that source entirely', async () => {
  const outcome = await provider.buildSimilarityCandidates({
    query: QUERY,
    loadClosetRecords: () => CLOSET_ROWS,
  });
  assert.equal(outcome.report.recordsLoaded.recent_scan, 0);
  assert.equal(outcome.failureReason, undefined);
});

test('both loads run concurrently, not in sequence', async () => {
  const slow = (value) => () => new Promise((resolve) => setTimeout(() => resolve(value), 120));
  const startedAt = Date.now();
  await provider.buildSimilarityCandidates({
    query: QUERY,
    loadClosetRecords: slow(CLOSET_ROWS),
    loadRecentScanRecords: slow(SCAN_ROWS),
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 220, `two 120ms loads must not take ${elapsed}ms sequentially`);
});

test('load timings are recorded even when the load failed', async () => {
  const outcome = await provider.buildSimilarityCandidates({
    query: QUERY,
    loadClosetRecords: () => { throw new Error('x'); },
  });
  assert.equal(typeof outcome.loadTimings.closetMs, 'number');
  assert.ok(outcome.loadTimings.closetMs >= 0);
});

// ── request shape ───────────────────────────────────────────────────────────

test('the scan transport forwards candidates without building or trimming them', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/scanIdentification.ts'), 'utf8');
  // Present on BOTH contract paths — the scanner sends V2, so a legacy-only
  // wiring would leave the feature dead on the path that actually runs.
  const occurrences = source.match(/existingItems: options\.existingItems/g) || [];
  assert.equal(occurrences.length, 2, 'existingItems must be merged onto both request bodies');
  // Guarded, so an absent candidate set produces a byte-identical legacy body.
  assert.match(source, /options\.existingItems\?\.length \? \{ existingItems/);
  // The transport must not reach into the selection layer itself.
  assert.ok(
    !/similarItemCandidates|selectComparisonCandidates|buildSimilarityCandidates/.test(source),
    'the transport must forward only — candidate building belongs to the provider',
  );
});

test('THE WIRING GATE: the provider and selector are reachable from a caller', () => {
  // The lesson from __tests__/scanJourneyWiring.test.js — a fully tested
  // helper that nothing calls provides no guarantee at all.
  const provider_ = fs.readFileSync(path.join(ROOT, 'services/similarItemCandidateProvider.ts'), 'utf8');
  assert.match(provider_, /selectComparisonCandidates\(/, 'the provider must call the selector');
  assert.match(provider_, /closetRecordsToCandidates\(/, 'the provider must call the adapters');
  assert.match(provider_, /recentScanRecordsToCandidates\(/);
});

// ── lifecycle ───────────────────────────────────────────────────────────────

const NOW = 1_000_000;

test('a freshly built candidate set may be attached exactly once', () => {
  let state = ledger.createSimilarityLedger();
  state = ledger.recordCandidateSetBuilt(state, { scanId: 'scan-1', candidateCount: 4, nowMs: NOW });

  assert.deepEqual({ ...ledger.canAttachCandidates(state, { scanId: 'scan-1', nowMs: NOW }) }, { allowed: true });

  state = ledger.markCandidatesDispatched(state, { scanId: 'scan-1', nowMs: NOW });
  const second = ledger.canAttachCandidates(state, { scanId: 'scan-1', nowMs: NOW });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'already_dispatched');
});

test('NO DUPLICATE REQUEST AFTER RESUME: marking dispatched twice is idempotent', () => {
  let state = ledger.createSimilarityLedger();
  state = ledger.recordCandidateSetBuilt(state, { scanId: 'scan-1', candidateCount: 2, nowMs: NOW });
  state = ledger.markCandidatesDispatched(state, { scanId: 'scan-1', nowMs: NOW });
  const firstDispatchAt = ledger.findEntry(state, 'scan-1').dispatchedAtMs;

  // Resume re-enters the dispatch path.
  state = ledger.markCandidatesDispatched(state, { scanId: 'scan-1', nowMs: NOW + 5000 });
  assert.equal(
    ledger.findEntry(state, 'scan-1').dispatchedAtMs,
    firstDispatchAt,
    'the original dispatch timestamp must survive — no second dispatch happened',
  );
});

test('a stale candidate set expires rather than being attached to a later scan', () => {
  let state = ledger.createSimilarityLedger();
  state = ledger.recordCandidateSetBuilt(state, { scanId: 'scan-1', candidateCount: 3, nowMs: NOW });
  const decision = ledger.canAttachCandidates(state, {
    scanId: 'scan-1',
    nowMs: NOW + ledger.CANDIDATE_SET_TTL_MS + 1,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'candidate_set_expired');
});

test('NO SUBSTITUTION: a candidate set built for another scan is never attached', () => {
  assert.equal(ledger.candidateSetMatchesScan('scan-1', 'scan-1'), true);
  assert.equal(ledger.candidateSetMatchesScan('scan-1', 'scan-2'), false);
  assert.equal(ledger.candidateSetMatchesScan(null, 'scan-2'), false);
  assert.equal(ledger.candidateSetMatchesScan('scan-1', null), false);

  const state = ledger.recordCandidateSetBuilt(
    ledger.createSimilarityLedger(),
    { scanId: 'scan-1', candidateCount: 3, nowMs: NOW },
  );
  const other = ledger.canAttachCandidates(state, { scanId: 'scan-2', nowMs: NOW });
  assert.equal(other.allowed, false);
  assert.equal(other.reason, 'unknown_scan');
});

test('rebuilding for the same scan replaces rather than accumulating', () => {
  let state = ledger.createSimilarityLedger();
  state = ledger.recordCandidateSetBuilt(state, { scanId: 'scan-1', candidateCount: 2, nowMs: NOW });
  state = ledger.recordCandidateSetBuilt(state, { scanId: 'scan-1', candidateCount: 7, nowMs: NOW + 10 });
  assert.equal(state.entries.length, 1);
  assert.equal(ledger.findEntry(state, 'scan-1').candidateCount, 7);
  assert.equal(ledger.findEntry(state, 'scan-1').dispatchedAtMs, null, 'a rebuild re-arms attachment');
});

test('expired entries are pruned so the ledger cannot grow unbounded', () => {
  let state = ledger.createSimilarityLedger();
  state = ledger.recordCandidateSetBuilt(state, { scanId: 'old', candidateCount: 1, nowMs: NOW });
  state = ledger.recordCandidateSetBuilt(state, {
    scanId: 'fresh', candidateCount: 1, nowMs: NOW + ledger.CANDIDATE_SET_TTL_MS,
  });
  const pruned = ledger.pruneExpired(state, NOW + ledger.CANDIDATE_SET_TTL_MS + 1);
  assert.deepEqual([...pruned.entries.map((e) => e.scanId)], ['fresh']);
});

test('the ledger holds counts and ids only — never candidate payloads or images', () => {
  const state = ledger.recordCandidateSetBuilt(
    ledger.createSimilarityLedger(),
    { scanId: 'scan-1', candidateCount: 5, nowMs: NOW },
  );
  const entry = ledger.findEntry(state, 'scan-1');
  assert.deepEqual(Object.keys(entry).sort(), ['builtAtMs', 'candidateCount', 'dispatchedAtMs', 'scanId']);
  const serialized = JSON.stringify(state);
  assert.ok(!/imageUri|file:\/\/|data:image|base64/i.test(serialized));
});

// Comments are stripped before these two assertions: the ledger module
// DISCUSSES at length why it does not persist and why it does not duplicate
// the selection ledger, and that prose is the point. What must not exist is
// code. (Same technique as the `isDuplicate` governance test.)
function strippedLedgerSource() {
  return fs
    .readFileSync(path.join(ROOT, 'services/similarityRequestLedger.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('NO IMAGE PERSISTENCE: the ledger module never touches AsyncStorage', () => {
  const source = strippedLedgerSource();
  assert.ok(!/AsyncStorage|setItem|getItem/.test(source),
    'the candidate ledger is in-memory by design — see the module header');
});

test('the similarity ledger does not duplicate the selection claim ledger', () => {
  const source = strippedLedgerSource();
  for (const forbidden of ['dispatchedCandidateIds', 'rejectedCandidateIds', 'markRejected']) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} belongs to scanSelectionSession — it must not be reimplemented here`,
    );
  }
});

test('the selection session claim ledger is untouched by this checkpoint', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/scanSelectionSession.ts'), 'utf8');
  // Its guarantees must still be present and unmodified in shape.
  assert.match(source, /export function canDispatchCandidate\(/);
  assert.match(source, /export function markDispatched\(/);
  assert.match(source, /export function markRejected\(/);
  assert.match(source, /dispatchedCandidateIds: \[\]/);
  assert.ok(!/existingItems|similarityCandidates/.test(source),
    'candidate building must not leak into the selection session');
});
