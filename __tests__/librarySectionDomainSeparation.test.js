// app/library.tsx — section identity and data-domain separation.
//
// Two levels of proof, because a title-only change is not a separation:
//
//   PART A renders the REAL app/library.tsx element tree per section, with
//          DISTINCT fixtures behind useLibrary and useCloset, and asserts both
//          the visible identity and which projection actually reached the grid.
//   PART B stores fixtures through the REAL services/library.js and
//          services/closetLibrary.js against an in-memory filesystem, and
//          asserts neither store can see the other's record. No serializer is
//          duplicated here and no domain logic is re-implemented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

// ══ PART A — rendered section identity and projection ════════════════════════

function makeReact() {
  const React = {
    __esModule: true,
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) };
      if (children.length > 0) {
        merged.children = children.length === 1 ? children[0] : children;
      }
      return { __element: true, type, props: merged };
    },
    Fragment: 'Fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init === undefined ? null : init }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
  React.default = React;
  return React;
}

function deepStub(label) {
  return new Proxy(function stub() {}, {
    get(_t, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'toString') return () => label;
      if (typeof prop === 'symbol') return undefined;
      return deepStub(`${label}.${String(prop)}`);
    },
    apply() {
      return deepStub(`${label}()`);
    },
  });
}

function named(name) {
  const fn = function marker() {};
  Object.defineProperty(fn, 'name', { value: name });
  fn.displayName = name;
  return fn;
}

const LUXURY_NAMES = [
  'LuxuryScreen', 'KScanHeader', 'SectionHeader', 'SavedLookCard',
  'EmptyStateCard', 'InlineNotice', 'SecondaryButton', 'PrivacyFooter',
];

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object' || node.__element !== true) return;
  visit(node);
  if (node.props && 'children' in node.props) walk(node.props.children, visit);
}

function collect(tree, predicate) {
  const out = [];
  walk(tree, (n) => { if (predicate(n)) out.push(n); });
  return out;
}

function byTestID(tree, testID) {
  return collect(tree, (n) => n.props && n.props.testID === testID);
}

/** Every string that appears anywhere in the tree (text nodes and props). */
function allText(tree) {
  const parts = [];
  walk(tree, (n) => {
    for (const [key, value] of Object.entries(n.props || {})) {
      if (key === 'children') continue;
      if (typeof value === 'string') parts.push(value);
      else if (value && typeof value === 'object' && typeof value.label === 'string') {
        parts.push(value.label);
      }
    }
    const kids = n.props && n.props.children;
    const list = Array.isArray(kids) ? kids : [kids];
    for (const kid of list) if (typeof kid === 'string') parts.push(kid);
  });
  return parts.join('\n');
}

const RECENT_FIXTURE = {
  id: 'scan-recent-1',
  createdAt: '2026-07-01T10:00:00.000Z',
  imageUri: '/doc/scan.jpg',
  thumbnailUri: '/doc/scan-thumb.jpg',
  attributes: {
    category: 'RECENT_SCAN_CATEGORY',
    silhouette: 'Longline',
    color_palette: 'Navy',
    material_estimate: 'Wool',
    style_tags: ['tailored'],
    confidence_score: 0.9,
  },
  result: 'RECENT_SCAN_RESULT',
  products: [{ id: 'p1', title: 'Coat', url: 'https://retailer.example/p1' }],
  purchaseOptions: [{ id: 'po1', retailer: 'R', url: 'https://retailer.example/buy' }],
  source: 'camera',
};

const CLOSET_FIXTURE = {
  id: 'closet-owned-1',
  createdAt: '2026-07-02T10:00:00.000Z',
  imageUri: '/doc/closet.jpg',
  thumbnailUri: '/doc/closet-thumb.jpg',
  title: 'CLOSET_OWNED_TITLE',
  category: 'CLOSET_OWNED_CATEGORY',
};

function renderLibrary({ section, scans = [], closetItems = [], separation = true } = {}) {
  const React = makeReact();
  const pushes = [];
  const setParamsCalls = [];
  const router = {
    push: (a) => pushes.push(a),
    replace: (a) => pushes.push(a),
    back: () => {},
    setParams: (p) => setParamsCalls.push(p),
  };

  const luxury = { __esModule: true };
  for (const n of LUXURY_NAMES) luxury[n] = named(n);

  const modules = {
    react: React,
    'react-native': {
      __esModule: true,
      View: 'View',
      Text: 'Text',
      TouchableOpacity: 'TouchableOpacity',
      ScrollView: 'ScrollView',
      ActivityIndicator: 'ActivityIndicator',
      Alert: { alert: () => {} },
      Linking: { openURL: () => {}, openSettings: () => {} },
      StyleSheet: { create: (s) => s, flatten: (s) => s, hairlineWidth: 1 },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
      Platform: { OS: 'android', select: (o) => o.android ?? o.default },
    },
    'expo-router': {
      __esModule: true,
      router,
      useRouter: () => router,
      useFocusEffect: () => {},
      // The route is the ONLY source of the section under test.
      useLocalSearchParams: () => (section === undefined ? {} : { section }),
    },
    'expo-status-bar': { __esModule: true, StatusBar: 'StatusBar' },
    '../hooks/useLibrary': {
      __esModule: true,
      useLibrary: () => ({
        scans,
        loading: false,
        remove: async () => {},
        actorKey: 'device-local',
      }),
    },
    '../hooks/useCloset': {
      __esModule: true,
      useCloset: () => ({
        items: closetItems,
        loading: false,
        error: null,
        remove: async () => true,
        addFromScan: async () => ({ ok: true }),
        addFromUri: async () => ({ ok: true }),
        refresh: async () => {},
      }),
    },
    '../hooks/useClosetCandidates': {
      __esModule: true,
      useClosetCandidates: () => ({
        candidates: [],
        loading: false,
        stage: async () => ({ ok: true }),
        refresh: async () => {},
      }),
    },
    '../hooks/useFeatureFreeze': {
      __esModule: true,
      useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }),
    },
    '../contexts/AuthSessionContext': {
      __esModule: true,
      useAuthSession: () => ({
        isAuthenticated: true,
        user: { id: 'actor-1' },
        loading: false,
      }),
    },
    '../components/luxury': luxury,
    '../constants/featureFlags': {
      __esModule: true,
      AI_STYLIST_UI_ENABLED: true,
      STYLECHAT_ATTACHMENTS_ENABLED: true,
      CLOSET_SEPARATION_V1: separation,
      CLOSET_DIRECT_INTAKE_ACTIVE: separation,
      CLOSET_CANDIDATE_STAGING_ACTIVE: false,
      CLOSET_BATCH_REVIEW_V2_ACTIVE: false,
      PRIVATE_DRESSING_ROOM_V1: true,
    },
  };

  function requireShim(spec) {
    if (Object.prototype.hasOwnProperty.call(modules, spec)) return modules[spec];
    return deepStub(spec);
  }

  const mod = { exports: {} };
  vm.runInThisContext(
    `(function (exports, module, require, React) {\n${transpile('app/library.tsx')}\n})`,
    { filename: 'library.tsx' },
  )(mod.exports, mod, requireShim, React);

  const Screen = mod.exports.default;
  assert.equal(typeof Screen, 'function', 'app/library.tsx must export a screen');
  const tree = Screen();
  const header = collect(tree, (n) => n.type === luxury.KScanHeader)[0];
  const empties = collect(tree, (n) => n.type === luxury.EmptyStateCard);
  const sectionHeaders = collect(tree, (n) => n.type === luxury.SectionHeader);
  return { tree, header, empties, sectionHeaders, pushes, setParamsCalls, luxury };
}

// ── Section identity ─────────────────────────────────────────────────────────

test('section=recent presents Recent Scans identity, not ownership', () => {
  const { header } = renderLibrary({ section: 'recent' });
  assert.equal(header.props.title, 'Recent Scans');
  assert.equal(header.props.subtitle, 'SCAN HISTORY & DISCOVERY');
  assert.notEqual(header.props.title, 'Your Closet');
});

test('section=closet presents owned-inventory identity', () => {
  const { header } = renderLibrary({ section: 'closet' });
  assert.equal(header.props.title, 'Your Closet');
  assert.equal(header.props.subtitle, 'YOUR OWNED WARDROBE');
});

test('switching sections changes the visible identity', () => {
  const recent = renderLibrary({ section: 'recent' }).header.props;
  const closet = renderLibrary({ section: 'closet' }).header.props;
  assert.notEqual(recent.title, closet.title);
  assert.notEqual(recent.subtitle, closet.subtitle);
});

// ── Data projection ──────────────────────────────────────────────────────────

test('section=recent renders scan history and no committed Closet items', () => {
  const { tree } = renderLibrary({
    section: 'recent',
    scans: [RECENT_FIXTURE],
    closetItems: [CLOSET_FIXTURE],
  });
  assert.equal(byTestID(tree, 'scan-card').length, 1, 'the Recent Scan must render');
  assert.equal(byTestID(tree, 'closet-card').length, 0, 'no Closet item may render here');

  const text = allText(tree);
  assert.match(text, /RECENT_SCAN_RESULT/);
  assert.doesNotMatch(
    text,
    /CLOSET_OWNED_TITLE/,
    'a committed Closet garment must never appear as scan history',
  );
});

test('section=closet renders the committed projection and no scan history', () => {
  const { tree } = renderLibrary({
    section: 'closet',
    scans: [RECENT_FIXTURE],
    closetItems: [CLOSET_FIXTURE],
  });
  assert.equal(byTestID(tree, 'closet-card').length, 1, 'the Closet item must render');
  assert.equal(byTestID(tree, 'scan-card').length, 0, 'no Recent Scan may render here');

  const text = allText(tree);
  assert.match(text, /CLOSET_OWNED_TITLE/);
  assert.doesNotMatch(
    text,
    /RECENT_SCAN_RESULT/,
    'a Recent Scan must never appear as an owned garment',
  );
});

test('the two sections do not merely differ by title — the projection differs', () => {
  const recent = renderLibrary({ section: 'recent', scans: [RECENT_FIXTURE], closetItems: [CLOSET_FIXTURE] });
  const closet = renderLibrary({ section: 'closet', scans: [RECENT_FIXTURE], closetItems: [CLOSET_FIXTURE] });
  assert.notEqual(
    byTestID(recent.tree, 'scan-card').length,
    byTestID(closet.tree, 'scan-card').length,
  );
  assert.notEqual(
    byTestID(recent.tree, 'closet-card').length,
    byTestID(closet.tree, 'closet-card').length,
  );
});

test('record actions belong to their own domain', () => {
  const recent = renderLibrary({ section: 'recent', scans: [RECENT_FIXTURE] });
  const scanCard = byTestID(recent.tree, 'scan-card')[0];
  // Reopening the scan is the Recent record's primary action.
  assert.equal(typeof scanCard.props.onPress, 'function');
  assert.equal(scanCard.props.status, 'Scan');

  const closet = renderLibrary({ section: 'closet', closetItems: [CLOSET_FIXTURE] });
  const closetCard = byTestID(closet.tree, 'closet-card')[0];
  assert.equal(closetCard.props.status, 'Closet');
  // Closet records expose ownership actions, never scan reopening.
  assert.equal(typeof closetCard.props.onDelete, 'function');
  assert.notEqual(closetCard.props.status, 'Scan');
});

test('record accessibility labels use the active domain instead of saved-look language', () => {
  const recent = renderLibrary({ section: 'recent', scans: [RECENT_FIXTURE] });
  const scanCard = byTestID(recent.tree, 'scan-card')[0];
  assert.equal(scanCard.props.accessibilityLabel, 'RECENT_SCAN_CATEGORY Recent Scan');
  assert.doesNotMatch(scanCard.props.accessibilityLabel, /closet|saved look/i);

  const closet = renderLibrary({ section: 'closet', closetItems: [CLOSET_FIXTURE] });
  const closetCard = byTestID(closet.tree, 'closet-card')[0];
  assert.equal(closetCard.props.accessibilityLabel, 'CLOSET_OWNED_TITLE Closet item');
  assert.doesNotMatch(closetCard.props.accessibilityLabel, /recent scan|saved look/i);
});

// ── Empty states ─────────────────────────────────────────────────────────────

test('recent empty state uses scan language and offers scanning, not Closet intake', () => {
  const { empties } = renderLibrary({ section: 'recent', scans: [], closetItems: [] });
  const empty = empties[0];
  assert.equal(empty.props.title, 'No Recent Scans Yet');
  assert.doesNotMatch(empty.props.title, /Start Your Closet/);
  assert.doesNotMatch(empty.props.subtitle, /you own/i);
  assert.equal(empty.props.action.testID, 'recent-empty-scan-button');

  const { pushes } = renderLibrary({ section: 'recent' });
  const fresh = renderLibrary({ section: 'recent' });
  fresh.empties[0].props.action.onPress();
  assert.deepEqual(fresh.pushes, ['/scan'], 'recent empty CTA must open the Scanner');
  assert.equal(pushes.length, 0);
});

test('closet empty state uses ownership language and opens Closet intake', () => {
  const { empties, pushes } = renderLibrary({ section: 'closet', closetItems: [] });
  const empty = empties[0];
  assert.equal(empty.props.title, 'Your Closet is empty');
  assert.doesNotMatch(empty.props.subtitle, /where to buy|purchase option|scan history/i);
  assert.equal(empty.props.action.testID, 'closet-empty-add-item-button');
  empty.props.action.onPress();
  assert.equal(pushes.length, 0, 'Closet intake must not navigate to the Scanner');
});

// ── Route authority ──────────────────────────────────────────────────────────

test('an invalid or missing section fails closed to Recent Scans', () => {
  for (const section of [undefined, '', 'invalid', 'CLOSET', 'closet ', ['closet']]) {
    const { header, tree } = renderLibrary({
      section,
      scans: [RECENT_FIXTURE],
      closetItems: [CLOSET_FIXTURE],
    });
    assert.equal(
      header.props.title,
      'Recent Scans',
      `section ${JSON.stringify(section)} must normalize to recent`,
    );
    assert.equal(
      byTestID(tree, 'closet-card').length,
      0,
      `section ${JSON.stringify(section)} must not render Closet records`,
    );
  }
});

test('the explicit route section is authoritative over screen defaults', () => {
  // The screen's own useState default is 'recent'; an explicit closet route
  // must win on the very first render, not after a later effect.
  const { header, tree } = renderLibrary({ section: 'closet', closetItems: [CLOSET_FIXTURE] });
  assert.equal(header.props.title, 'Your Closet');
  assert.equal(byTestID(tree, 'closet-card').length, 1);
});

test('the route section is re-synced on every param change, not just first mount', () => {
  // The rendering harness above proves first-mount authority. Re-render and
  // hydration authority lives in an effect, which a non-rendering harness
  // cannot execute — so the sync itself is asserted structurally here. Without
  // it a section switch would stick to whatever the screen first mounted with.
  const source = fs.readFileSync(path.join(ROOT, 'app', 'library.tsx'), 'utf8');
  assert.match(
    source,
    /const requestedSection = params\?\.section === 'closet' \? 'closet' : 'recent';/,
    'the route param must be normalized explicitly',
  );
  assert.match(
    source,
    /useState<'recent' \| 'closet'>\(requestedSection\)/,
    'first mount must honour the route, not a hardcoded default',
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setSection\(requestedSection\);\s*\}, \[requestedSection\]\);/,
    'a later param change must re-sync the section',
  );
});

test('in-screen section switching replaces params instead of pushing a route', () => {
  const { tree, setParamsCalls, pushes } = renderLibrary({ section: 'recent' });
  const closetTab = byTestID(tree, 'library-section-closet')[0];
  assert.ok(closetTab, 'the section tablist must render');
  closetTab.props.onPress();
  assert.deepEqual(setParamsCalls, [{ section: 'closet' }]);
  assert.equal(pushes.length, 0, 'switching sections must not stack a duplicate /library entry');
});

// ── MY CLOSET disposition ────────────────────────────────────────────────────

test('no MY CLOSET control is selected while Recent Scan records render', () => {
  const { tree } = renderLibrary({ section: 'recent', scans: [RECENT_FIXTURE] });
  // The offending control was a bare View with no accessibilityLabel — its only
  // identity was the text it rendered — so both the label AND the subtree text
  // are inspected here.
  const selectedClosetControls = collect(tree, (n) => {
    const p = n.props || {};
    const state = p.accessibilityState;
    if (!state || state.selected !== true) return false;
    const label = typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : '';
    return /my closet/i.test(label) || /MY CLOSET/.test(allText(n));
  });
  assert.equal(
    selectedClosetControls.length,
    0,
    'a selected "MY CLOSET" control must not sit above scan history',
  );

  // And the authoritative Recent tab IS the selected one.
  const recentTab = byTestID(tree, 'library-section-recent')[0];
  assert.equal(recentTab.props.accessibilityState.selected, true);
});

test('the retained MY CLOSET tab really opens the committed Closet', () => {
  const { tree, setParamsCalls } = renderLibrary({ section: 'recent' });
  // Count every element that presents itself as MY CLOSET, by label or by the
  // text it renders — two competing controls is exactly the ambiguity that let
  // a decorative tab pose as the committed Closet.
  const closetTabs = collect(tree, (n) => {
    const label = n.props && n.props.accessibilityLabel;
    if (typeof label === 'string' && /^my closet$/i.test(label)) return true;
    return n.props && n.props.accessibilityRole === 'tab' && /MY CLOSET/.test(allText(n));
  });
  assert.equal(closetTabs.length, 1, 'exactly one MY CLOSET control may exist');
  assert.equal(typeof closetTabs[0].props.onPress, 'function', 'it must be a real control');
  assert.match(String(closetTabs[0].props.accessibilityHint), /items you own/i);
  closetTabs[0].props.onPress();
  assert.deepEqual(setParamsCalls, [{ section: 'closet' }]);
});

test('Saved Looks and Inspiration stay separately labelled', () => {
  const { sectionHeaders } = renderLibrary({ section: 'recent', scans: [RECENT_FIXTURE] });
  const titles = sectionHeaders.map((n) => n.props.title);
  assert.ok(titles.includes('Recent Scans'), 'the recent grid is labelled Recent Scans');
  assert.ok(titles.includes('Inspiration'), 'Inspiration keeps its own heading');
  assert.ok(
    !titles.includes('My Closet'),
    'the Closet heading must not appear over scan history',
  );
});

// ══ PART B — real service-boundary domain proof ══════════════════════════════

function memfs() {
  const files = new Map();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) { return { exists: files.has(p) }; },
      async readAsStringAsync(p) {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      async writeAsStringAsync(p, c) { files.set(p, c); },
      async moveAsync({ from, to }) {
        files.set(to, files.get(from) ?? `bytes(${from})`);
        files.delete(from);
      },
      async deleteAsync(p) { files.delete(p); },
    },
  };
}

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function loadServices() {
  const m = memfs();
  const actorContext = runModule('services/actorContext.js', () => ({}));
  let seq = 0;
  const imageManipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async (uri) => {
      seq += 1;
      const cacheUri = `/cache/derived_${seq}.jpg`;
      m.files.set(cacheUri, `derived-from:${uri}`);
      return { uri: cacheUri };
    },
  };

  const library = runModule('services/library.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === './savedScansCloud') {
      return {
        saveScanToCloud: async () => ({ ok: true }),
        softDeleteCloudSavedScan: async () => ({ ok: true }),
      };
    }
    if (spec === './identificationSnapshot') {
      return {
        hydrateScanHistory: (raw, hydrateOne) => {
          if (!Array.isArray(raw)) return { records: [], corruptedCount: 0 };
          const records = [];
          let corruptedCount = 0;
          for (const r of raw) {
            try {
              const h = hydrateOne(r);
              if (h) records.push(h);
              else corruptedCount += 1;
            } catch { corruptedCount += 1; }
          }
          return { records, corruptedCount };
        },
      };
    }
    if (spec === './purchaseOptions' || spec === './dressingRoomCommerce') {
      return {
        isPurchaseOptionsSnapshot: (v) => Array.isArray(v),
        normalizePurchaseOptions: (v) => (Array.isArray(v) ? v.slice() : []),
      };
    }
    if (spec === './actorContext') return actorContext;
    return {};
  });

  const closetLibrary = runModule('services/closetLibrary.js', (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return imageManipulator;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    if (spec === './library') return library;
    return {};
  });

  return { library, closetLibrary, actorContext, m };
}

const ANALYSIS = () => ({
  result: 'Navy wool overcoat',
  metadata: { category: 'Outerwear', color: 'Navy', silhouette: 'Longline' },
  products: [{ id: 'p1', title: 'Coat', url: 'https://retailer.example/p1', price: '$420' }],
  purchaseOptions: [
    { id: 'po1', retailer: 'Retailer', url: 'https://retailer.example/buy', price: '$420' },
  ],
});

test('a real Recent Scan never becomes a committed Closet record', async () => {
  const { library, closetLibrary, actorContext } = loadServices();
  actorContext.advanceActorEpoch('A');

  const scan = await library.saveScan({
    photoUri: '/tmp/capture.jpg',
    analysis: ANALYSIS(),
    source: 'camera',
    actorRequest: actorContext.createActorRequest(),
  });
  assert.ok(scan && scan.id, 'precondition: the scan was stored through the real service');

  const scanList = await library.loadLibrary('A');
  assert.ok(
    scanList.some((s) => s.id === scan.id),
    'the scan must be visible in Recent Scan history',
  );

  const closetList = await closetLibrary.loadCloset('A');
  assert.equal(
    closetList.length,
    0,
    'saving a scan must not create an owned Closet item',
  );
  assert.ok(
    !closetList.some((i) => i.id === scan.id),
    'the scan id must never surface in the committed Closet projection',
  );
});

test('a real committed Closet item never appears in Recent Scan history', async () => {
  const { library, closetLibrary, actorContext } = loadServices();
  actorContext.advanceActorEpoch('A');

  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/owned.jpg',
    draft: { title: 'Owned Overcoat', category: 'Outerwear' },
    actorRequest: actorContext.createActorRequest(),
    ownerId: 'A',
  });
  assert.equal(created.ok, true, `precondition: Closet intake failed — ${created.reason}`);
  const item = created.item;
  assert.ok(item && item.id, 'precondition: the Closet item was stored through the real service');

  const closetList = await closetLibrary.loadCloset('A');
  assert.ok(
    closetList.some((i) => i.id === item.id),
    'the owned item must be visible in the committed Closet',
  );

  const scanList = await library.loadLibrary('A');
  assert.equal(scanList.length, 0, 'Closet intake must not create a Recent Scan');
  assert.ok(
    !scanList.some((s) => s.id === item.id),
    'the Closet item id must never surface in scan history',
  );
});

test('the two domains persist to separate stores on disk', async () => {
  const { library, closetLibrary, actorContext, m } = loadServices();
  actorContext.advanceActorEpoch('A');

  await library.saveScan({
    photoUri: '/tmp/capture.jpg',
    analysis: ANALYSIS(),
    source: 'camera',
    actorRequest: actorContext.createActorRequest(),
  });
  const created = await closetLibrary.createClosetItem({
    sourceUri: '/tmp/owned.jpg',
    draft: { title: 'Owned Overcoat', category: 'Outerwear' },
    actorRequest: actorContext.createActorRequest(),
    ownerId: 'A',
  });
  assert.equal(created.ok, true, `precondition: Closet intake failed — ${created.reason}`);

  const paths = [...m.files.keys()].filter((p) => p.endsWith('.json'));
  const closetPaths = paths.filter((p) => /closet/i.test(p));
  const scanPaths = paths.filter((p) => !/closet/i.test(p));
  assert.ok(closetPaths.length > 0, 'the Closet store must exist');
  assert.ok(scanPaths.length > 0, 'the Recent Scan store must exist');
  for (const c of closetPaths) {
    assert.ok(
      !scanPaths.includes(c),
      'the Closet and Recent Scan stores must not share a file',
    );
  }
});
