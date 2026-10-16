// VTO entry-point taxonomy: one bounded `entry_point` identity across every
// funnel step, derived from the launch `origin` / awareness `surface` that
// already exist. See services/vto/vtoOrigins.ts for the mapping.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function load(rel, requireMap = {}) {
  const source = read(...rel.split('/'));
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  vm.runInNewContext(outputText, {
    module: mod,
    exports: mod.exports,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`unexpected import: ${id}`);
    },
    __DEV__: false,
  });
  return mod.exports;
}

const origins = load('services/vto/vtoOrigins.ts');
const telemetry = load('services/vto/vtoTelemetry.ts');
const { resolveVtoEntryPoint, VTO_ENTRY_POINTS } = origins;

function literalList(source, name) {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
  assert.ok(m, `${name} not found`);
  return [...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]);
}

function capture(fn) {
  const seen = [];
  telemetry.setVtoAnalyticsSink((event, payload) => seen.push({ event, payload }));
  try { fn(); } finally { telemetry.resetVtoAnalyticsSink(); }
  return seen;
}

test('the taxonomy is exactly the five owner-specified entry points; watch_notification is absent', () => {
  assert.deepEqual([...VTO_ENTRY_POINTS],
    ['home_studio', 'elise', 'visual_search', 'closet', 'product_card']);
  assert.ok(!VTO_ENTRY_POINTS.includes('watch_notification'),
    'no real authorized watch-notification entry point exists');
});

test('mapping table: every origin and surface resolves as documented', () => {
  const cases = [
    [{ origin: 'elise' }, 'elise'],
    [{ origin: 'closet_item' }, 'closet'],
    [{ origin: 'scan_result' }, 'visual_search'],
    [{ origin: 'commerce_product', surface: 'scan_result' }, 'visual_search'],
    [{ origin: 'commerce_product', surface: 'product' }, 'product_card'],
    [{ origin: 'commerce_product', surface: 'commerce' }, 'product_card'],
    [{ origin: 'commerce_product' }, 'product_card'],
    [{ surface: 'home' }, 'home_studio'],
    [{ surface: 'scan_result' }, 'visual_search'],
    [{ surface: 'product' }, 'product_card'],
    [{ surface: 'commerce' }, 'product_card'],
    // Not entry points: reported as absent, never forced into a bucket.
    [{ origin: 'dressing_room' }, null],
    [{ origin: 'dev_harness' }, null],
    [{ surface: 'coachmark' }, null],
    [{ surface: 'kplus_step6' }, null],
    [{}, null],
    [{ origin: 'something_new' }, null],
    [{ origin: 42, surface: {} }, null],
    [undefined, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveVtoEntryPoint(input), expected, JSON.stringify(input));
  }
});

test('an unknown origin is not rescued by a surface (no guessing)', () => {
  assert.equal(resolveVtoEntryPoint({ origin: 'dressing_room', surface: 'home' }), null);
});

test('every literal the mapping relies on is a real origin or surface, and the sink copy matches', () => {
  const mapping = read('services', 'vto', 'vtoOrigins.ts');
  const realOrigins = literalList(read('types', 'vto.ts'), 'VTO_ORIGINS');
  const realSurfaces = literalList(read('services', 'vto', 'vtoDiscovery.ts'), 'VTO_AWARENESS_SURFACES');
  for (const o of ['elise', 'closet_item', 'scan_result', 'commerce_product']) {
    assert.ok(realOrigins.includes(o), `origin ${o} must exist in VTO_ORIGINS`);
  }
  for (const s of ['home', 'scan_result', 'product', 'commerce']) {
    assert.ok(realSurfaces.includes(s), `surface ${s} must exist in VTO_AWARENESS_SURFACES`);
  }
  assert.deepEqual([...telemetry.VTO_BOUNDED_PROPERTY_VALUES.entry_point], [...VTO_ENTRY_POINTS]);
  assert.ok(telemetry.VTO_EVENT_PROPERTIES.includes('entry_point'));
  assert.deepEqual([...mapping.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]), [],
    'vtoOrigins.ts must stay import-free');
});

test('PARITY: the sink mirror agrees with the canonical mapping for every origin x surface', () => {
  const realOrigins = literalList(read('types', 'vto.ts'), 'VTO_ORIGINS');
  const realSurfaces = literalList(read('services', 'vto', 'vtoDiscovery.ts'), 'VTO_AWARENESS_SURFACES');
  const originsToTry = [undefined, ...realOrigins, 'unknown_origin'];
  const surfacesToTry = [undefined, ...realSurfaces, 'unknown_surface'];
  let compared = 0;
  for (const origin of originsToTry) {
    for (const surface of surfacesToTry) {
      const expected = resolveVtoEntryPoint({ origin, surface });
      const seen = capture(() => telemetry.emitVtoEvent('vto_entry_tap', { origin, surface }));
      // A value the sink's own bounded checks drop cannot influence derivation
      // differently, so compare on the derived label alone.
      assert.equal(seen[0].payload.entry_point ?? null, expected, JSON.stringify({ origin, surface }));
      compared += 1;
    }
  }
  assert.equal(compared, originsToTry.length * surfacesToTry.length, 'the full grid must actually be exercised');
});
test('the sink derives entry_point from origin/surface on every funnel step', () => {
  const funnel = capture(() => {
    telemetry.emitVtoEvent('vto_awareness_impression', { surface: 'scan_result', actor_kplus_state: 'active' });
    telemetry.emitVtoEvent('vto_entry_tap', { origin: 'scan_result' });
    telemetry.emitVtoEvent('vto_request_start', { origin: 'scan_result' });
    telemetry.emitVtoEvent('vto_request_success', { origin: 'scan_result' });
    telemetry.emitVtoEvent('vto_result_shop', { origin: 'scan_result' });
  });
  assert.equal(funnel.length, 5);
  for (const step of funnel) assert.equal(step.payload.entry_point, 'visual_search', step.event);
});

test('each entry point keeps its own identity across impression, tap, launch and success', () => {
  const byEntry = {
    elise: { origin: 'elise' },
    closet: { origin: 'closet_item' },
    visual_search: { origin: 'scan_result' },
    product_card: { origin: 'commerce_product' },
  };
  for (const [entry, props] of Object.entries(byEntry)) {
    const seen = capture(() => {
      for (const ev of ['vto_entry_impression', 'vto_entry_tap', 'vto_request_start', 'vto_request_success']) {
        telemetry.emitVtoEvent(ev, props);
      }
    });
    assert.deepEqual(seen.map((s) => s.payload.entry_point), [entry, entry, entry, entry]);
  }
  const home = capture(() => telemetry.emitVtoEvent('vto_awareness_tap', { surface: 'home' }));
  assert.equal(home[0].payload.entry_point, 'home_studio');
});

test('Elise offer events inherit the elise entry point', () => {
  const seen = capture(() => {
    telemetry.emitVtoEvent('elise_vto_offer_rendered', { origin: 'elise' });
    telemetry.emitVtoEvent('elise_vto_offer_launched', { origin: 'elise', reasonCode: 'not_available' });
  });
  assert.deepEqual(seen.map((s) => s.payload.entry_point), ['elise', 'elise']);
});

test('unattributable events carry no entry_point at all', () => {
  const seen = capture(() => {
    telemetry.emitVtoEvent('vto_request_start', { origin: 'dressing_room' });
    telemetry.emitVtoEvent('vto_awareness_impression', { surface: 'coachmark' });
    telemetry.emitVtoEvent('vto_exited', {});
  });
  for (const s of seen) assert.ok(!('entry_point' in s.payload), s.event);
});

test('a supplied bounded entry_point wins; an out-of-set value is dropped, never trusted', () => {
  const seen = capture(() => {
    telemetry.emitVtoEvent('vto_entry_tap', { origin: 'closet_item', entry_point: 'elise' });
    telemetry.emitVtoEvent('vto_entry_tap', { origin: 'closet_item', entry_point: 'watch_notification' });
    telemetry.emitVtoEvent('vto_entry_tap', { entry_point: 'bogus' });
  });
  assert.equal(seen[0].payload.entry_point, 'elise');
  assert.equal(seen[1].payload.entry_point, 'closet', 'an invalid value falls back to derivation');
  assert.ok(!('entry_point' in seen[2].payload));
});

test('PRIVACY: derivation adds only the bounded label; media, urls and ids stay out', () => {
  const seen = capture(() => telemetry.emitVtoEvent('vto_request_start', {
    origin: 'scan_result',
    imageUrl: 'https://example.com/p.jpg',
    productRef: 'sku-123',
    personDataUri: 'data:image/png;base64,AAAA',
    userId: 'u-1',
  }));
  assert.deepEqual(Object.keys(seen[0].payload).sort(), ['entry_point', 'origin']);
});

test('WIRING: the Visual Search panel launches as scan_result; other entries are unchanged', () => {
  const panel = read('components', 'scan-results', 'PurchaseOptionsPanel.tsx');
  assert.match(panel, /origin="scan_result"/);
  assert.doesNotMatch(panel, /origin="commerce_product"/,
    'regression: the scan panel would be indistinguishable from a product card in launch events');
  assert.match(panel, /surface="scan_result"/);
  assert.match(read('components', 'ProductShelf.tsx'), /origin="commerce_product"/);
  assert.match(read('app', 'closet', 'try-on.tsx'), /origin="closet_item"/);
  assert.match(read('components', 'style-chat', 'EliseVtoOffer.tsx'), /ORIGIN/);
});

test('NEGATIVE CONTROL: without the panel change, scan-result launches would be misattributed', () => {
  // This is what every post-tap event would have carried before the change.
  assert.equal(resolveVtoEntryPoint({ origin: 'commerce_product' }), 'product_card');
  assert.notEqual(resolveVtoEntryPoint({ origin: 'scan_result' }), 'product_card');
});
