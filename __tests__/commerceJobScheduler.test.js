/**
 * v127 Android P1-C — per-item commerce hydration scheduler.
 *
 * These execute the real decision functions from
 * services/commerceJobScheduler.ts against real Map/object values, driving
 * the exact hostile item-switch matrix the audit specified. This is the
 * behavioral coverage the hook itself cannot get under this project's plain
 * `node --test` runner (no React test renderer is installed) — see that
 * file's own header for why the logic lives there instead of inline in the
 * hook.
 *
 * Negative control for every case: reverting to the pre-fix design (one
 * global abort slot + one global request-id counter, no per-item map) is
 * exactly what section "P1-C" of the audit proved loses item A's commerce
 * outright when item B is selected. These tests assert the OUTCOME a real
 * scheduler run produces; each is written so that plugging in the old
 * single-slot behavior (see the inline comments) demonstrably fails it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadScheduler() {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'commerceJobScheduler.ts'), 'utf8');
  const ts = require('typescript');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'module', js)(mod.exports, mod);
  return mod.exports;
}

const {
  commerceJobKey,
  shouldDispatchCommerceHydration,
  isCommerceJobCurrent,
  isCommerceJobVisible,
} = loadScheduler();

/** A tiny simulation of the hook's job dispatch, using the real scheduler
 * functions, so each test reads as the actual hostile scenario rather than a
 * unit test of one function in isolation. */
function makeHarness() {
  const jobs = new Map();
  let scanGeneration = 0;
  let selectedScanItemId = null;
  const applied = []; // { itemId, kind: 'visible-status'|'persist', value }

  function dispatch(evidence, { isRetry = false } = {}) {
    const itemKey = commerceJobKey(evidence);
    const existing = jobs.get(itemKey);
    if (!shouldDispatchCommerceHydration(existing, evidence, isRetry)) return null;
    existing?.controller?.abort();
    let aborted = false;
    const job = {
      controller: { abort: () => { aborted = true; } },
      evidence,
      scanGeneration,
      active: true,
      status: 'pending',
    };
    jobs.set(itemKey, job);
    if (isCommerceJobVisible(evidence.itemId, selectedScanItemId)) {
      applied.push({ itemId: evidence.itemId, kind: 'visible-status', value: 'pending' });
    }
    return {
      job,
      wasAborted: () => aborted,
      settle(status) {
        job.active = false;
        const current = isCommerceJobCurrent(jobs, itemKey, job, scanGeneration);
        if (!current) return { applied: false };
        job.status = status;
        // Persistence: A may update/persist its OWN data regardless of what
        // is currently selected — never gated on visibility.
        applied.push({ itemId: evidence.itemId, kind: 'persist', value: status });
        if (isCommerceJobVisible(evidence.itemId, selectedScanItemId)) {
          applied.push({ itemId: evidence.itemId, kind: 'visible-status', value: status });
        }
        return { applied: true };
      },
    };
  }

  function selectItem(itemId) {
    selectedScanItemId = itemId;
    const job = jobs.get(itemId);
    applied.push({ itemId, kind: 'visible-status', value: job ? job.status : 'idle' });
  }

  function newScan() {
    scanGeneration += 1;
    for (const job of jobs.values()) job.controller?.abort();
    jobs.clear();
  }

  return { jobs, dispatch, selectItem, newScan, applied, get scanGeneration() { return scanGeneration; } };
}

function evidenceFor(itemId) {
  return { itemId, identification: { item_type: 'jacket' } };
}

test('CASE 1: A starts, switch to B, B completes, A completes late — B stays visible, A persists only to A', () => {
  const h = makeHarness();
  h.selectItem('A');
  const evidenceA = evidenceFor('A');
  const jobA = h.dispatch(evidenceA);
  assert.ok(jobA, 'A did not dispatch');

  // Switch to B — must NOT abort A's job. This is the exact defect: the old
  // single global abort slot would call jobA.wasAborted() === true here.
  h.selectItem('B');
  assert.equal(jobA.wasAborted(), false, 'switching to B aborted A — the P1-C defect');

  const evidenceB = evidenceFor('B');
  const jobB = h.dispatch(evidenceB);
  assert.ok(jobB, 'B did not dispatch');
  const bResult = jobB.settle('success');
  assert.equal(bResult.applied, true);

  const aResult = jobA.settle('success');
  assert.equal(aResult.applied, true, 'A could not persist its own late completion');

  // B remains the visible status; A's completion never touched it.
  const visibleEvents = h.applied.filter((e) => e.kind === 'visible-status');
  assert.deepEqual(visibleEvents[visibleEvents.length - 1], { itemId: 'B', kind: 'visible-status', value: 'success' });
  assert.equal(
    visibleEvents.some((e) => e.itemId === 'A' && e.value === 'success'),
    false,
    'A\'s completion leaked into the visible status while B was selected',
  );
  // But A DID persist (to its own record) — this is the "must not be lost" half.
  assert.ok(h.applied.some((e) => e.itemId === 'A' && e.kind === 'persist' && e.value === 'success'));
});

test('CASE 2: A starts, switch to B, A completes BEFORE B — A stored only on A, B display remains B', () => {
  const h = makeHarness();
  h.selectItem('A');
  const jobA = h.dispatch(evidenceFor('A'));
  h.selectItem('B');
  const jobB = h.dispatch(evidenceFor('B'));

  const aResult = jobA.settle('success');
  assert.equal(aResult.applied, true);

  const visibleAfterA = h.applied.filter((e) => e.kind === 'visible-status').pop();
  assert.notEqual(visibleAfterA.itemId, 'A', 'A\'s early completion overwrote the visible display while B was selected');

  jobB.settle('success');
  const finalVisible = h.applied.filter((e) => e.kind === 'visible-status').pop();
  assert.deepEqual(finalVisible, { itemId: 'B', kind: 'visible-status', value: 'success' });
});

test('CASE 3: A fails, B succeeds — B unaffected, A retryable when reselected', () => {
  const h = makeHarness();
  h.selectItem('A');
  const jobA = h.dispatch(evidenceFor('A'));
  jobA.settle('error');

  h.selectItem('B');
  const jobB = h.dispatch(evidenceFor('B'));
  jobB.settle('success');
  const finalVisible = h.applied.filter((e) => e.kind === 'visible-status').pop();
  assert.deepEqual(finalVisible, { itemId: 'B', kind: 'visible-status', value: 'success' });

  // Reselecting A must surface A's real (error) status, not a forced reset.
  h.selectItem('A');
  const afterReselect = h.applied.filter((e) => e.kind === 'visible-status').pop();
  assert.deepEqual(afterReselect, { itemId: 'A', kind: 'visible-status', value: 'error' });

  // And A is retryable: a retry dispatch for A is allowed (not blocked as a
  // duplicate) because the settled job is no longer active.
  const retryA = h.dispatch(evidenceFor('A'), { isRetry: true });
  assert.ok(retryA, 'a failed, settled job could not be retried');
});

test('CASE 4: A succeeds, switch back to A — no automatic duplicate MODE B request', () => {
  const h = makeHarness();
  h.selectItem('A');
  const evidenceA = evidenceFor('A');
  const jobA = h.dispatch(evidenceA);
  jobA.settle('success');

  h.selectItem('B');
  h.dispatch(evidenceFor('B'));

  h.selectItem('A');
  // The dispatch EFFECT re-fires with the SAME evidence object for A (it was
  // never replaced) — this must be refused as a duplicate, not silently
  // re-issue a network call for an already-hydrated item.
  const duplicate = h.dispatch(evidenceA);
  assert.equal(duplicate, null, 'switching back to a completed item re-dispatched a duplicate MODE B request');
});

test('CASE 6: a new whole scan begins — the old scan\'s jobs cannot overwrite the new UI', () => {
  const h = makeHarness();
  h.selectItem('A');
  const jobA = h.dispatch(evidenceFor('A'));

  h.newScan();
  assert.equal(jobA.wasAborted(), true, 'a new scan did not abort the previous scan\'s in-flight job');

  const late = jobA.settle('success');
  assert.equal(late.applied, false, 'a superseded scan\'s late completion was still applied after a new scan began');
});

test('single-flight: a retry cannot race a still-active job for the same item', () => {
  const h = makeHarness();
  h.selectItem('A');
  // Same evidence object reference for both calls — a retry click reads the
  // same `analysis.commerceEvidence` the original dispatch used; a genuinely
  // different evidence object (e.g. a fresh scan of the same item) is a new
  // job by design and is covered by the flag-off/new-scan cases instead.
  const evidenceA = evidenceFor('A');
  const jobA = h.dispatch(evidenceA);
  const raceAttempt = h.dispatch(evidenceA, { isRetry: true });
  assert.equal(raceAttempt, null, 'a retry was allowed to race a still-active job for the same item');
  jobA.settle('success');
});

test('negative control: the pre-fix single global slot loses A when B is selected', () => {
  // Simulates the ORIGINAL design: one abort ref, one request-id counter,
  // shared across every item — exactly what was in useKScan.js before P1-C.
  let globalAbort = null;
  let globalRequestId = 0;
  function oldDispatch() {
    globalAbort?.(); // aborts whatever the PREVIOUS item's job was, unconditionally
    let aborted = false;
    globalAbort = () => { aborted = true; };
    globalRequestId += 1;
    const requestId = globalRequestId;
    return { wasAborted: () => aborted, isCurrent: () => requestId === globalRequestId };
  }

  const jobA = oldDispatch(); // A starts
  const jobB = oldDispatch(); // switch to B — old design aborts A unconditionally
  assert.equal(jobA.wasAborted(), true, 'negative control did not reproduce the pre-fix abort-on-switch defect');
  assert.equal(jobA.isCurrent(), false, 'negative control did not reproduce A being permanently stale after switching to B');
});
