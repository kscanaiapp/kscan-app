// Launch-contract negatives N-02 / N-10: a garment the customer tapped never
// silently becomes a different garment while its try-on is open, whatever the
// parent re-renders next (a refreshed result list, a re-sorted shelf, a late
// async update). See docs/vto-discovery-integration-matrices.md section 2.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRenderer, runModule, findAll } = require('./helpers/componentRenderer');

const ROOT = path.resolve(__dirname, '..');

const garment = (productRef, extra = {}) => ({
  productRef,
  imageUrl: `https://cdn.example.test/${productRef}.jpg`,
  category: 'Dress',
  brand: null,
  commerceSource: 'RetailerA',
  ...extra,
});
const A = garment('prod-A');
const B = garment('prod-B');

function harness() {
  const r = createRenderer();
  const calls = { watchA: 0, watchB: 0, shopA: 0, shopB: 0, completed: 0, initiated: 0 };
  const host = runModule('components/vto/VtoLaunchHost.tsx', {
    ...r.runtimeModules,
    '../../hooks/useVtoAwareness': { useVtoAwarenessBlocker: () => {} },
    '../../hooks/useVtoSessionStatus': { useVtoSessionStatus: () => ({ status: 'idle' }) },
    '../../services/haptics': { selectionTick: () => {} },
    '../../services/vto/vtoAwareness': {
      markVtoCompleted: () => { calls.completed += 1; },
      markVtoInitiated: () => { calls.initiated += 1; },
    },
    '../../services/vto/vtoLiveCapability': {},
    '../../services/vto/vtoTelemetry': { emitVtoEvent: () => {} },
    './VirtualTryOnSheet': { VirtualTryOnSheet: 'VirtualTryOnSheet' },
    './VtoMinimizedPill': { VtoMinimizedPill: 'VtoMinimizedPill' },
  });
  let launch = null;
  let props = null;
  const Entry = () => {
    launch = host.useVtoLaunchHost({ origin: 'scan_result', onWatch: props.onWatch });
    return r.jsx(host.VtoLaunchHost, { launch, origin: 'scan_result', ...props });
  };
  const forGarment = (g, tag) => ({
    garment: g,
    garmentTitle: `Title ${tag}`,
    onShop: () => { calls[`shop${tag}`] += 1; },
    onWatch: () => { calls[`watch${tag}`] += 1; },
    sizeGuideUrl: `https://size.example.test/${tag}`,
  });
  const show = (next) => { props = next; return r.render(r.jsx(Entry, {})); };
  const sheet = (tree) => findAll(tree, (n) => n.type === 'VirtualTryOnSheet')[0] ?? null;
  const pill = (tree) => findAll(tree, (n) => n.type === 'VtoMinimizedPill')[0] ?? null;
  return { show, sheet, pill, forGarment, calls, get launch() { return launch; }, host };
}

test('N-02: a different garment passed while the sheet is open does not replace the tapped one', () => {
  const h = harness();
  h.show(h.forGarment(A, 'A'));
  h.launch.open();
  let sheet = h.sheet(h.show(h.forGarment(A, 'A')));
  assert.equal(sheet.props.garment.productRef, 'prod-A');

  sheet = h.sheet(h.show(h.forGarment(B, 'B')));
  assert.equal(sheet.props.garment.productRef, 'prod-A', 'the garment stays the one that was tapped');
  assert.equal(sheet.props.garmentTitle, 'Title A');
  assert.equal(sheet.props.sizeGuideUrl, 'https://size.example.test/A');
  sheet.props.onShop();
  assert.deepEqual([h.calls.shopA, h.calls.shopB], [1, 0], 'Shop goes to the tapped garment, never the replacement');
});

test('N-02: Watch while pinned reaches the tapped garment, not the replacement', () => {
  const h = harness();
  h.show(h.forGarment(A, 'A'));
  h.launch.open();
  h.show(h.forGarment(A, 'A'));
  const sheet = h.sheet(h.show(h.forGarment(B, 'B')));
  sheet.props.onWatch();
  assert.deepEqual([h.calls.watchA, h.calls.watchB], [1, 0]);
  assert.ok(h.pill(h.show(h.forGarment(B, 'B'))), 'the pill is shown so the customer can return');
});

test('an update that keeps the SAME identity still passes through (refreshed image URL)', () => {
  const h = harness();
  h.show(h.forGarment(A, 'A'));
  h.launch.open();
  h.show(h.forGarment(A, 'A'));
  const refreshed = { ...A, imageUrl: 'https://cdn.example.test/prod-A-refreshed.jpg' };
  const sheet = h.sheet(h.show(h.forGarment(refreshed, 'A')));
  assert.equal(sheet.props.garment.imageUrl, 'https://cdn.example.test/prod-A-refreshed.jpg');
  assert.equal(sheet.props.garment.productRef, 'prod-A');
});

test('identity includes the source: a different Closet item or supplied garment is a different try-on', () => {
  const closetX = garment('closet_item:X', { source: { type: 'closet_item', closetItemId: 'X' } });
  const closetY = garment('closet_item:X', { source: { type: 'closet_item', closetItemId: 'Y' } });
  const suppliedH1 = garment('elise-upload', { source: { type: 'user_supplied_garment', contentHash: 'h1', contentHashVersion: 'sha256-normalized-v1' } });
  const suppliedH2 = garment('elise-upload', { source: { type: 'user_supplied_garment', contentHash: 'h2', contentHashVersion: 'sha256-normalized-v1' } });
  for (const [first, second] of [[closetX, closetY], [suppliedH1, suppliedH2]]) {
    const h = harness();
    h.show(h.forGarment(first, 'A'));
    h.launch.open();
    h.show(h.forGarment(first, 'A'));
    const sheet = h.sheet(h.show(h.forGarment(second, 'B')));
    assert.deepEqual(sheet.props.garment.source, first.source, 'same product ref, different source: still pinned');
  }
  const ids = new Set([closetX, closetY, suppliedH1, suppliedH2, A, B].map((g) => harness().host.vtoGarmentLaunchIdentity(g)));
  assert.equal(ids.size, 6, 'six different garments, six different identities');
});

test('N-10: closing releases the pin, so the next opening shows the garment then in front of the customer', () => {
  const h = harness();
  h.show(h.forGarment(A, 'A'));
  h.launch.open();
  h.show(h.forGarment(A, 'A'));
  assert.equal(h.sheet(h.show(h.forGarment(B, 'B'))).props.garment.productRef, 'prod-A');
  h.launch.close();
  assert.equal(h.sheet(h.show(h.forGarment(B, 'B'))), null, 'closed: no sheet');
  h.launch.open();
  assert.equal(h.sheet(h.show(h.forGarment(B, 'B'))).props.garment.productRef, 'prod-B');
  assert.equal(h.sheet(h.show(h.forGarment(B, 'B'))).props.garmentTitle, 'Title B');
});

test('the pin survives minimizing: a swap while collapsed still returns to the tapped garment', () => {
  const h = harness();
  h.show(h.forGarment(A, 'A'));
  h.launch.open();
  h.show(h.forGarment(A, 'A'));
  h.launch.minimize();
  h.show(h.forGarment(B, 'B'));
  h.launch.restore();
  assert.equal(h.sheet(h.show(h.forGarment(B, 'B'))).props.garment.productRef, 'prod-A');
});

test('nothing is pinned or rendered before an explicit open', () => {
  const h = harness();
  assert.equal(h.sheet(h.show(h.forGarment(A, 'A'))), null);
  assert.equal(h.sheet(h.show(h.forGarment(B, 'B'))), null);
  h.launch.open();
  assert.equal(h.sheet(h.show(h.forGarment(B, 'B'))).props.garment.productRef, 'prod-B', 'opened for B, so B');
});

test('NEGATIVE CONTROL: without the pin the open sheet would follow the parent to another garment', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components/vto/VtoLaunchHost.tsx'), 'utf8');
  const mutant = source.replace(
    /const pinned = sheetVisible && openedFor\.current !== null && openedFor\.current\.identity !== identity\s*\?\s*openedFor\.current\s*:\s*null;/,
    'const pinned = null;',
  );
  assert.notEqual(mutant, source, 'mutation anchor must exist');
  const r = createRenderer();
  const host = runModule('components/vto/VtoLaunchHost.tsx', {
    ...r.runtimeModules,
    '../../hooks/useVtoAwareness': { useVtoAwarenessBlocker: () => {} },
    '../../hooks/useVtoSessionStatus': { useVtoSessionStatus: () => ({ status: 'idle' }) },
    '../../services/haptics': { selectionTick: () => {} },
    '../../services/vto/vtoAwareness': { markVtoCompleted: () => {}, markVtoInitiated: () => {} },
    '../../services/vto/vtoLiveCapability': {},
    '../../services/vto/vtoTelemetry': { emitVtoEvent: () => {} },
    './VirtualTryOnSheet': { VirtualTryOnSheet: 'VirtualTryOnSheet' },
    './VtoMinimizedPill': { VtoMinimizedPill: 'VtoMinimizedPill' },
  }, { mutate: () => mutant });
  let launch = null;
  let props = { garment: A, garmentTitle: 'Title A', origin: 'scan_result' };
  const Entry = () => {
    launch = host.useVtoLaunchHost({ origin: 'scan_result' });
    return r.jsx(host.VtoLaunchHost, { launch, ...props });
  };
  r.render(r.jsx(Entry, {}));
  launch.open();
  r.render(r.jsx(Entry, {}));
  props = { garment: B, garmentTitle: 'Title B', origin: 'scan_result' };
  const sheet = findAll(r.render(r.jsx(Entry, {})), (n) => n.type === 'VirtualTryOnSheet')[0];
  assert.equal(sheet.props.garment.productRef, 'prod-B', 'this is the silent swap the pin prevents');
});
