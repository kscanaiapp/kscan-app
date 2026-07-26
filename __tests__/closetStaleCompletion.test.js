/**
 * Deterministic Library detail-view stale-completion coverage.
 *
 * A tiny hook/JSX harness executes the real LibraryScreen component and gives
 * each isScanPromoted lookup a manually controlled completion order. No Closet
 * production behavior is extracted or duplicated into the test.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function sameDeps(left, right) {
  return Boolean(
    left &&
      right &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index])),
  );
}

function createHooks() {
  const slots = [];
  let cursor = 0;
  let queuedEffects = [];

  function useState(initialValue) {
    const index = cursor++;
    if (!slots[index]) {
      const slot = {
        kind: 'state',
        value: typeof initialValue === 'function' ? initialValue() : initialValue,
      };
      slot.set = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      };
      slots[index] = slot;
    }
    return [slots[index].value, slots[index].set];
  }

  function useRef(initialValue) {
    const index = cursor++;
    if (!slots[index]) slots[index] = { kind: 'ref', value: { current: initialValue } };
    return slots[index].value;
  }

  function useCallback(callback, deps) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !sameDeps(previous.deps, deps)) {
      slots[index] = { kind: 'callback', value: callback, deps };
    }
    return slots[index].value;
  }

  function useEffect(effect, deps) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !sameDeps(previous.deps, deps)) {
      queuedEffects.push({ index, effect, deps, cleanup: previous?.cleanup });
    }
  }

  function beginRender() {
    cursor = 0;
    queuedEffects = [];
  }

  function flushEffects() {
    for (const pending of queuedEffects) {
      if (typeof pending.cleanup === 'function') pending.cleanup();
      const cleanup = pending.effect();
      slots[pending.index] = {
        kind: 'effect',
        deps: pending.deps,
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
      };
    }
    queuedEffects = [];
  }

  return {
    beginRender,
    flushEffects,
    stateValues: () => slots.filter((slot) => slot?.kind === 'state').map((slot) => slot.value),
    useCallback,
    useEffect,
    useRef,
    useState,
  };
}

function jsx(type, props, key) {
  return { type, props: props ?? {}, key: key ?? null };
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(value, 'type')) visit(value);
  walk(value.props?.children, visit);
}

function findAll(tree, predicate) {
  const matches = [];
  walk(tree, (node) => {
    if (predicate(node)) matches.push(node);
  });
  return matches;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeScan(id, category) {
  return {
    id,
    createdAt: '2026-07-26T12:00:00.000Z',
    imageUri: `file:///scans/${id}.jpg`,
    thumbnailUri: `file:///scans/${id}-thumb.jpg`,
    attributes: {
      category,
      silhouette: 'Structured',
      color_palette: 'Black',
      material_estimate: null,
      style_tags: [],
      confidence_score: 0.9,
    },
    result: `${category} analysis`,
    products: [],
    source: 'camera',
  };
}

function createLibraryHarness() {
  const hooks = createHooks();
  const auth = { isAuthenticated: true, user: { id: 'actor-a' } };
  const scans = [makeScan('scan-a', 'Coat'), makeScan('scan-b', 'Dress')];
  const promotionLookups = [];
  const router = { push: () => {}, replace: () => {} };
  const componentTokens = {
    AnalysisCard: 'AnalysisCard',
    SavedLookCard: 'SavedLookCard',
  };

  const react = {
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
  const runtime = { Fragment: 'Fragment', jsx, jsxs: jsx };
  const requireMap = {
    react,
    'react/jsx-runtime': runtime,
    'react-native': {
      ActivityIndicator: 'ActivityIndicator',
      Alert: { alert: () => {} },
      Dimensions: { get: () => ({ width: 400 }) },
      Linking: { openURL: async () => {} },
      ScrollView: 'ScrollView',
      StyleSheet: {
        absoluteFillObject: {},
        create: (styles) => styles,
        hairlineWidth: 1,
      },
      Text: 'Text',
      TouchableOpacity: 'TouchableOpacity',
      View: 'View',
    },
    'expo-router': {
      useLocalSearchParams: () => ({}),
      useRouter: () => router,
    },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'expo-image-picker': { requestMediaLibraryPermissionsAsync: async () => ({ status: 'denied' }) },
    '../components/AnalysisCard': { AnalysisCard: componentTokens.AnalysisCard },
    '../components/AddScanToDressingRoomModal': { AddScanToDressingRoomModal: 'AddScanToDressingRoomModal' },
    '../components/AddInspirationToDressingRoomModal': { AddInspirationToDressingRoomModal: 'AddInspirationToDressingRoomModal' },
    '../components/InspirationUploadModal': { InspirationUploadModal: 'InspirationUploadModal' },
    '../hooks/useLibrary': { useLibrary: () => ({ scans, loading: false, remove: async () => true }) },
    '../hooks/useFeatureFreeze': {
      useFeatureFreeze: () => ({ isFeatureEnabled: () => false, isLoading: false }),
    },
    '../contexts/AuthSessionContext': { useAuthSession: () => auth },
    '../services/styleObjects': {
      deleteInspirationItem: async () => {},
      listInspirationItems: () => new Promise(() => {}),
    },
    '../services/dressingRoomItemContract': {
      describeMissingImageReason: () => 'Unavailable',
      hasUsableDressingRoomImageSource: () => true,
    },
    '../components/luxury': {
      EmptyStateCard: 'EmptyStateCard',
      InlineNotice: 'InlineNotice',
      KScanHeader: 'KScanHeader',
      LuxuryScreen: 'LuxuryScreen',
      PrivacyFooter: 'PrivacyFooter',
      SavedLookCard: componentTokens.SavedLookCard,
      SecondaryButton: 'SecondaryButton',
      SectionHeader: 'SectionHeader',
    },
    '../constants/theme': {
      LUXURY: {
        colors: {
          border: '#222',
          graphite: '#111',
          ivory: '#fff',
          pearl: '#eee',
          plum: '#606',
        },
        typography: { caption: {} },
      },
      SPACING: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 },
    },
    '../constants/elise': { ELISE_IDENTITY: { styleWithEliseLabel: 'Style with Elise' } },
    '../constants/freeTierUtilityFlags': { FREE_TIER_UTILITY_ENABLED: false },
    '../constants/featureFlags': {
      AI_STYLIST_UI_ENABLED: false,
      CLOSET_DIRECT_INTAKE_ACTIVE: false,
      CLOSET_SEPARATION_V1: true,
      STYLECHAT_ATTACHMENTS_ENABLED: false,
    },
    '../components/free-tier/FreeTierUtilitySection': { FreeTierUtilitySection: 'FreeTierUtilitySection' },
    '../services/ownedClosetItems': { normalizeLocalSavedScan: (scan) => scan },
    '../services/style-chat/styleChatAttachmentStore': { setAttachmentHandoff: () => {} },
    '../hooks/useCloset': {
      useCloset: () => ({
        addFromScan: async () => ({ ok: true }),
        addFromUri: async () => ({ ok: true }),
        busy: false,
        items: [],
        loading: false,
        remove: async () => true,
      }),
    },
    '../components/closet/ClosetIntakeModal': { ClosetIntakeModal: 'ClosetIntakeModal' },
    '../services/closetPromotion': {
      isScanPromoted: (scan, ownerId) => {
        const completion = deferred();
        promotionLookups.push({ scanId: scan.id, ownerId, ...completion });
        return completion.promise;
      },
    },
  };

  const filename = path.join(ROOT, 'app/library.tsx');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Date,
    exports: mod.exports,
    Math,
    module: mod,
    Promise,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected LibraryScreen import: ${specifier}`);
    },
    setTimeout,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  const LibraryScreen = mod.exports.default;

  function render() {
    hooks.beginRender();
    const tree = LibraryScreen();
    hooks.flushEffects();
    return tree;
  }

  function renderSettled() {
    render();
    return render();
  }

  function scanCard(tree, title) {
    return findAll(
      tree,
      (node) => node.type === componentTokens.SavedLookCard && node.props.title === title,
    )[0];
  }

  function analysisCard(tree) {
    return findAll(tree, (node) => node.type === componentTokens.AnalysisCard)[0] ?? null;
  }

  return {
    analysisCard,
    auth,
    hooks,
    promotionLookups,
    render,
    renderSettled,
    scanCard,
  };
}

async function settlePromiseCallbacks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('STALE COMPLETION AFTER SCAN CHANGE: scan A cannot mark scan B saved', async () => {
  const harness = createLibraryHarness();
  let tree = harness.renderSettled();
  harness.scanCard(tree, 'Coat').props.onPress();
  tree = harness.render();
  assert.equal(harness.analysisCard(tree).props.scanSourceId, 'scan-a');

  harness.scanCard(tree, 'Dress').props.onPress();
  tree = harness.render();
  assert.equal(harness.analysisCard(tree).props.scanSourceId, 'scan-b');
  assert.equal(harness.promotionLookups.length, 2);

  harness.promotionLookups[0].resolve(true);
  await settlePromiseCallbacks();
  tree = harness.render();
  assert.equal(harness.analysisCard(tree).props.scanSourceId, 'scan-b');
  assert.equal(harness.analysisCard(tree).props.closetState, 'idle');
  harness.promotionLookups[1].resolve(false);
});

test('STALE COMPLETION AFTER MODAL CLOSE: scan A cannot write closed detail state', async () => {
  const harness = createLibraryHarness();
  let tree = harness.renderSettled();
  harness.scanCard(tree, 'Coat').props.onPress();
  tree = harness.render();
  harness.analysisCard(tree).props.onDismiss();
  tree = harness.render();
  assert.equal(harness.analysisCard(tree), null);

  harness.promotionLookups[0].resolve(true);
  await settlePromiseCallbacks();
  tree = harness.render();
  assert.equal(harness.analysisCard(tree), null);
  assert.equal(harness.hooks.stateValues().includes('saved'), false);
});

test('STALE COMPLETION AFTER ACTOR TRANSITION: scan A cannot write actor B UI state', async () => {
  const harness = createLibraryHarness();
  let tree = harness.renderSettled();
  harness.scanCard(tree, 'Coat').props.onPress();
  tree = harness.render();
  assert.equal(harness.analysisCard(tree).props.scanSourceId, 'scan-a');

  harness.auth.user = { id: 'actor-b' };
  tree = harness.renderSettled();
  assert.equal(harness.analysisCard(tree), null);

  harness.promotionLookups[0].resolve(true);
  await settlePromiseCallbacks();
  tree = harness.render();
  assert.equal(harness.analysisCard(tree), null);
  assert.equal(harness.hooks.stateValues().includes('saved'), false);
});
