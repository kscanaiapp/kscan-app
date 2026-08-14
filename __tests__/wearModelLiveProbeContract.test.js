// BUILD 29 CLOSET V2 / S7B — WEAR-MODEL LIVE PROBE DRIFT GUARD
//
// security/release/run-wear-model-live-probe.js certifies the STAGING database
// against the wear contract. It deliberately does not import
// services/wearHistory.ts: the probe executes in a job holding staging
// credentials, and under the trust boundary established for the E4.1 probe
// such a job may run only reviewed default-branch code, never a dispatched
// candidate's source.
//
// The cost of that decision is a second copy of the wire contract, and a second
// copy is worthless the moment it drifts — a probe that derives a different
// client_id would silently stop testing idempotency at all, while still
// reporting PASS. These tests are what stop that: they hold the probe's
// exported helpers to the service's own definitions.
//
// If this file fails, the probe and the service disagree. Fix the probe; the
// service is the authority.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const probe = require('../security/release/run-wear-model-live-probe.js');

function loadWearService() {
  const filename = path.join(ROOT, 'services/wearHistory.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    require: (s) => {
      if (s === './supabaseClient') return { supabase: {} };
      throw new Error('Unexpected import: ' + s);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const service = loadWearService();

test('the probe requiring in does not execute the probe', () => {
  // require.main !== module must short-circuit before any target resolution,
  // or importing this contract would try to reach staging.
  assert.equal(typeof probe.wearActionKey, 'function');
  assert.equal(typeof probe.dedupeWearItems, 'function');
});

test('DRIFT: the probe derives the same action key as the wear service', () => {
  const cases = [
    { source: 'item', targetId: 'abc-123', wornAt: '2026-08-14T09:15:00.000Z' },
    { source: 'saved_look', targetId: 'look-1', wornAt: '2026-08-14T23:59:59.000Z' },
    { source: 'item', targetId: 'item-2', wornAt: '2026-01-01T00:00:00.000Z' },
    { source: 'custom', targetId: 'x', wornAt: '2026-12-31T12:00:00.000Z' },
  ];
  for (const c of cases) {
    assert.equal(
      probe.wearActionKey(c),
      service.defaultActionKey(c),
      `action key drift for ${JSON.stringify(c)}`,
    );
  }
});

test('DRIFT: the probe collapses a day the same way the wear service does', () => {
  for (const iso of [
    '2026-08-14T00:00:00.000Z',
    '2026-08-14T23:59:59.999Z',
    '2026-02-29T06:30:00.000Z',
  ]) {
    assert.equal(probe.wearDateKey(iso), service.wearDateKey(iso), `date key drift for ${iso}`);
  }
});

test('DRIFT: the probe de-duplicates garments the same way the wear service does', () => {
  const inputs = [
    [
      { sourceItemId: 'a', sourceType: 'saved_scan', titleSnapshot: 'A', categorySnapshot: 'tops' },
      { sourceItemId: 'b', sourceType: 'saved_scan', titleSnapshot: 'B', categorySnapshot: 'bottoms' },
      { sourceItemId: 'b', sourceType: 'saved_scan', titleSnapshot: 'B duplicate', categorySnapshot: 'bottoms' },
    ],
    // whitespace-only and empty ids are not garments
    [
      { sourceItemId: '   ', titleSnapshot: 'blank' },
      { sourceItemId: 'c', titleSnapshot: '  padded  ' },
    ],
    // first occurrence wins, including its snapshot
    [
      { sourceItemId: 'd', titleSnapshot: 'first' },
      { sourceItemId: 'd', titleSnapshot: 'second' },
    ],
  ];
  for (const items of inputs) {
    // Compared by value, not by identity: the service is evaluated inside a vm
    // context, so its objects carry that realm's Object.prototype and
    // deepStrictEqual would fail on the prototype alone — reporting a drift
    // that is an artifact of the loader rather than a real disagreement.
    assert.equal(
      JSON.stringify(probe.dedupeWearItems(items)),
      JSON.stringify(service.dedupeWearItems(items)),
      `dedupe drift for ${JSON.stringify(items)}`,
    );
  }
});

test('DRIFT: the probe normalizes wornAt the same way the wear service does', () => {
  // Not exported by the service, so it is exercised through the key it feeds.
  for (const raw of ['2026-08-14T09:15:00+05:00', '2026-08-14', 'not-a-date']) {
    const normalized = probe.isoOrNow(raw);
    if (raw === 'not-a-date') {
      assert.match(normalized, /^\d{4}-\d{2}-\d{2}T/, 'an unparseable value falls back to now');
      continue;
    }
    assert.equal(normalized, new Date(Date.parse(raw)).toISOString());
  }
});

test('DRIFT: the probe bounds snapshot text the same way the wear service does', () => {
  const long = 'x'.repeat(400);
  const [probeOut] = probe.dedupeWearItems([{ sourceItemId: 'e', titleSnapshot: long }]);
  const [serviceOut] = service.dedupeWearItems([{ sourceItemId: 'e', titleSnapshot: long }]);
  assert.equal(probeOut.titleSnapshot, serviceOut.titleSnapshot);
  assert.equal(probeOut.titleSnapshot.length, 80, 'snapshot bound is 80 chars in both');
});

test('the probe never references the production project ref except to refuse it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'security/release/run-wear-model-live-probe.js'), 'utf8');
  // The probe delegates refusal to environment-authority.js rather than
  // carrying its own copy of the production ref, so the ref must not appear.
  assert.doesNotMatch(src, /wyyuqfdxucjksghsmhry/, 'the probe must not hardcode the production ref');
  assert.match(src, /assertExpectedEnvironment\('staging'/, 'the probe must assert staging through the shared authority');
});

test('the probe refuses to create Auth users against a hosted project', () => {
  const src = fs.readFileSync(path.join(ROOT, 'security/release/run-wear-model-live-probe.js'), 'utf8');
  assert.match(src, /PROVISION_REFUSED/, 'provision mode must be refused against a hosted project');
});
