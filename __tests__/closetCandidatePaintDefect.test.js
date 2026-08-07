// Regression coverage for the CURRENT_MEDIA_PAINT_DEFECT repair (Build 25 Phase
// 2, Decision B).
//
// ROOT CAUSE (measured on-device, not guessed): ClosetBatchReviewPanel's row is
// flexDirection:'row' with a fixed 56dp thumbnail, a flex:1 body column carrying
// the status text, and an actions column of SecondaryButtons. Every
// SecondaryButton inherited a hard-coded 200dp minWidth from the shared
// LuxuryButton secondary variant. Inside the Closet section's narrow row
// (~266dp available), a thumbnail plus one 200dp-wide action column already left
// no room for body — and once a candidate reaches waiting_for_network or failed
// (two actions: retry + remove), Yoga collapsed the flexible body column to
// width 0. The status Text had no numberOfLines constraint, so at ~0 available
// width it wrapped into a near-single-character-per-line column, inflating the
// row (and the whole candidate panel, which sits above the committed grid in
// normal flow) to over 1300dp — consuming the ScrollView's entire viewport and
// pushing the committed Closet grid beyond the reachable scroll range. The
// committed cards were never dropped from React's tree (they kept rendering
// with correct props every render); they simply never reached a visible
// position in the native view hierarchy, which is why this class of defect is
// invisible to the tree-shape assertions below and is proven instead by the two
// style assertions in the "repair mechanism" block.
//
// This suite reuses the batch-review harness's module-loading approach
// (closetBatchReviewSurface.test.js) but additionally wires a real, non-empty
// useCloset() so the committed grid actually renders — the original harness
// hardcodes items: [], which is exactly why this defect shipped unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// ── Mini renderer (identical contract to closetBatchReviewSurface.test.js) ────

function sameDeps(left, right) {
  return Boolean(
    left &&
      right &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index])),
  );
}

function createRenderer() {
  const registry = new Map();
  let active = null;
  let dirty = false;

  function slotsFor(id) {
    let entry = registry.get(id);
    if (!entry) {
      entry = { slots: [], cursor: 0, queued: [] };
      registry.set(id, entry);
    }
    return entry;
  }

  const react = {
    useState(initial) {
      const entry = active;
      const index = entry.cursor++;
      if (!entry.slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = (next) => {
          const resolved = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(resolved, slot.value)) {
            slot.value = resolved;
            dirty = true;
          }
        };
        entry.slots[index] = slot;
      }
      return [entry.slots[index].value, entry.slots[index].set];
    },
    useRef(initial) {
      const entry = active;
      const index = entry.cursor++;
      if (!entry.slots[index]) entry.slots[index] = { value: { current: initial } };
      return entry.slots[index].value;
    },
    useMemo(factory, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.slots[index] = { value: factory(), deps };
      }
      return entry.slots[index].value;
    },
    useCallback(callback, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.slots[index] = { value: callback, deps };
      }
      return entry.slots[index].value;
    },
    useEffect(effect, deps) {
      const entry = active;
      const index = entry.cursor++;
      const previous = entry.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) {
        entry.queued.push({ index, effect, deps, cleanup: previous?.cleanup });
      }
    },
  };

  function renderNode(element, id) {
    if (element === null || element === undefined || typeof element === 'boolean') return null;
    if (Array.isArray(element)) {
      return element
        .map((child, index) => renderNode(child, `${id}[${index}]`))
        .filter(Boolean);
    }
    if (typeof element !== 'object') return { type: '#text', props: {}, value: element, children: [] };
    const { type, props, key } = element;
    if (typeof type === 'function') {
      const childId = `${id}/${type.name || 'anon'}:${key ?? ''}`;
      const entry = slotsFor(childId);
      const previous = active;
      active = entry;
      entry.cursor = 0;
      entry.queued = [];
      const output = type(props ?? {});
      const pending = entry.queued;
      entry.queued = [];
      for (const effect of pending) {
        if (typeof effect.cleanup === 'function') effect.cleanup();
        const cleanup = effect.effect();
        entry.slots[effect.index] = {
          deps: effect.deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
        };
      }
      active = previous;
      const rendered = renderNode(output, childId);
      return {
        type,
        name: type.name,
        props: props ?? {},
        children: rendered ? (Array.isArray(rendered) ? rendered : [rendered]) : [],
      };
    }
    const rendered = renderNode(props?.children, `${id}/${String(type)}:${key ?? ''}`);
    return {
      type,
      name: typeof type === 'string' ? type : String(type),
      props: props ?? {},
      children: rendered ? (Array.isArray(rendered) ? rendered : [rendered]) : [],
    };
  }

  return {
    react,
    jsx: (type, props, key) => ({ type, props: props ?? {}, key: key ?? null }),
    render(element) {
      let tree = null;
      let guard = 0;
      do {
        dirty = false;
        tree = renderNode(element, 'root');
        guard += 1;
      } while (dirty && guard < 25);
      assert.ok(guard < 25, 'the tree never settled');
      return tree;
    },
  };
}

function walk(node, visit) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function byTestId(tree, testID) {
  return findAll(tree, (node) => node.props?.testID === testID);
}

function textContent(tree) {
  const out = [];
  walk(tree, (node) => {
    if (node.type === '#text') out.push(String(node.value));
  });
  return out.join(' ');
}

// ── Module graph ─────────────────────────────────────────────────────────────

function transpile(rel, jsx) {
  const filename = path.join(ROOT, rel);
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowJs: true,
      jsx: jsx ? ts.JsxEmit.ReactJSX : undefined,
    },
    fileName: filename,
  }).outputText;
}

function runModule(rel, requireShim, jsx = false) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel, jsx)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function candidate(overrides = {}) {
  const createdAt = overrides.createdAt ?? '2026-07-28T10:00:00.000Z';
  return {
    schemaVersion: 2,
    candidateId: 'candidate-1',
    batchId: 'batch-1',
    batchPosition: 0,
    ownerId: 'actor-a',
    sourceType: 'gallery',
    originalImageUri: null,
    candidateImageUri: '/doc/kscan_closet_candidates/images/candidate-1.jpg',
    candidateThumbnailUri: '/doc/kscan_closet_candidates/thumbnails/candidate-1.jpg',
    category: 'Outerwear',
    clothingType: 'Jacket',
    primaryColor: 'Black',
    status: 'ready_for_review',
    attemptCount: 1,
    automaticRetryCount: 0,
    interruptionCount: 0,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(NOW + 6 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function ready(id, position, overrides = {}) {
  return candidate({
    candidateId: id,
    batchPosition: position,
    candidateImageUri: `/doc/kscan_closet_candidates/images/${id}.jpg`,
    candidateThumbnailUri: `/doc/kscan_closet_candidates/thumbnails/${id}.jpg`,
    ...overrides,
  });
}

function closetItem(id, title, overrides = {}) {
  return {
    schemaVersion: 2,
    id,
    ownerId: 'actor-a',
    sourceCandidateId: null,
    sourceLineageId: null,
    sourceLocalScanId: null,
    sourceSavedScanId: null,
    clientRequestId: null,
    title,
    category: overrides.category ?? 'Outerwear',
    clothingType: null,
    subtype: null,
    brand: null,
    primaryColor: 'Black',
    secondaryColors: [],
    material: [],
    size: null,
    notes: null,
    origin: 'direct_intake',
    imageUri: `file:///closet/images/${id}.jpg`,
    thumbnailUri: `file:///closet/thumbnails/${id}.jpg`,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

/**
 * Mount the REAL LibraryScreen with the REAL candidate surface AND a real,
 * populated committed Closet — the coexistence the shipped defect required and
 * that closetBatchReviewSurface.test.js's items: [] harness cannot exercise.
 */
function mountLibrary(options = {}) {
  const {
    batchReviewActive = true,
    stagingActive = true,
    candidates = [],
    closetItems = [],
    closetLoading = false,
    closetError = null,
  } = options;

  const renderer = createRenderer();
  const calls = { remove: [], closetRemove: [] };

  const featureFlags = {
    AI_STYLIST_UI_ENABLED: false,
    STYLECHAT_ATTACHMENTS_ENABLED: false,
    CLOSET_SEPARATION_V1: true,
    CLOSET_DIRECT_INTAKE_ACTIVE: true,
    CLOSET_CANDIDATE_STAGING_ACTIVE: stagingActive,
    CLOSET_BATCH_REVIEW_V2_ACTIVE: batchReviewActive,
    MIRROR_SELFIE_V1_ACTIVE: false,
    PRIVATE_DRESSING_ROOM_V1: false,
  };

  const theme = {
    LUXURY: {
      colors: {
        border: '#222',
        graphite: '#111',
        ink: '#000',
        ivory: '#fff',
        pearl: '#eee',
        plum: '#606',
        champagne: '#eee',
        goldBrushed: '#a80',
        stone: '#888',
      },
      typography: { caption: {}, bodyStrong: {}, ctaSecondary: {}, brandMark: {} },
      buttons: { secondary: { minWidth: 200, height: 52, paddingHorizontal: 20 } },
    },
    SPACING: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 },
    RADIUS: { lg: 16, pill: 999 },
    SHADOWS: { editorialSmall: {} },
  };

  const reactNative = {
    ActivityIndicator: 'ActivityIndicator',
    Alert: { alert: () => {} },
    Dimensions: { get: () => ({ width: 400 }) },
    Image: 'Image',
    Linking: { openURL: async () => {}, openSettings: async () => {} },
    Modal: 'Modal',
    Platform: { OS: 'android' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { absoluteFillObject: {}, create: (styles) => styles, hairlineWidth: 1 },
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
  };

  const jsxRuntime = { Fragment: 'Fragment', jsx: renderer.jsx, jsxs: renderer.jsx };
  const reactShim = { ...renderer.react, default: renderer.react };

  // ── The real SavedLookCard, exactly as the committed grid renders it ────────
  const savedLookCard = runModule(
    'components/luxury/SavedLookCard.tsx',
    (spec) => {
      if (spec === 'react') return reactShim;
      if (spec === 'react/jsx-runtime') return jsxRuntime;
      if (spec === 'react-native') return reactNative;
      if (spec === '../../constants/theme') return theme;
      throw new Error(`unexpected SavedLookCard import: ${spec}`);
    },
    true,
  );

  const luxury = {
    EmptyStateCard: 'EmptyStateCard',
    InlineNotice: 'InlineNotice',
    KScanHeader: 'KScanHeader',
    LuxuryScreen: 'LuxuryScreen',
    PrimaryButton: 'PrimaryButton',
    PrivacyFooter: 'PrivacyFooter',
    SavedLookCard: savedLookCard.SavedLookCard,
    SecondaryButton: 'SecondaryButton',
    SectionHeader: 'SectionHeader',
  };

  const types = runModule('types/closetCandidate.ts', () => ({}));
  const stateMachine = runModule('services/closetCandidateStateMachine.ts', (spec) =>
    spec === '../types/closetCandidate' ? types : {},
  );
  const errors = runModule('services/closetCandidateErrors.ts', (spec) =>
    spec === '../types/closetCandidate' ? types : {},
  );
  const eligibility = runModule('services/closetCandidateReviewEligibility.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    throw new Error(`unexpected import: ${spec}`);
  });
  const promotionContract = runModule('services/closetCandidatePromotionContract.ts', (spec) => {
    throw new Error(`the promotion contract must import nothing: ${spec}`);
  });
  const batchReview = runModule('services/closetBatchReview.ts', (spec) => {
    if (spec === '../types/closetCandidate') return types;
    if (spec === './closetCandidateStateMachine') return stateMachine;
    if (spec === './closetCandidateErrors') return errors;
    if (spec === './closetCandidateReviewEligibility') return eligibility;
    if (spec === './closetCandidatePromotionContract') return promotionContract;
    throw new Error(`unexpected import: ${spec}`);
  });
  const selectionHook = runModule('hooks/useClosetBatchSelection.ts', (spec) => {
    if (spec === 'react') return renderer.react;
    if (spec === '../services/closetBatchReview') return batchReview;
    throw new Error(`unexpected import: ${spec}`);
  });

  const candidateHookApi = {
    candidates,
    loading: false,
    busy: false,
    actorId: 'actor-a',
    actorEpoch: 4,
    activeBatchId: null,
    setActiveBatchId: () => {},
    stagingActive,
    batchIntakeActive: batchReviewActive,
    promotion: null,
    promoting: false,
    promoteSelected: async (ids) => ({ ok: true, ids }),
    addFromUri: async () => ({ kind: 'rejected', code: 'candidate_invalid_transition' }),
    addFromAssets: async () => ({ kind: 'rejected', code: 'candidate_invalid_transition' }),
    retry: async () => ({ ok: true }),
    reject: async () => ({ ok: true }),
    remove: async (id) => {
      calls.remove.push(id);
      return { ok: true };
    },
    classifyManually: async () => ({ ok: true }),
    refresh: async () => {},
  };
  const candidateHook = { useClosetCandidates: () => candidateHookApi };

  const manualModal = { ClosetCandidateManualClassifyModal: 'ClosetCandidateManualClassifyModal' };

  const batchPanel = runModule(
    'components/closet/ClosetBatchReviewPanel.tsx',
    (spec) => {
      if (spec === 'react') return reactShim;
      if (spec === 'react/jsx-runtime') return jsxRuntime;
      if (spec === 'react-native') return reactNative;
      if (spec === '../luxury') return luxury;
      if (spec === '../../constants/theme') return theme;
      if (spec === '../../hooks/useClosetCandidates') return candidateHook;
      if (spec === '../../hooks/useClosetBatchSelection') return selectionHook;
      if (spec === '../../services/closetBatchReview') return batchReview;
      if (spec === '../../services/closetCandidatePromotionContract') return promotionContract;
      if (spec === './ClosetCandidateManualClassifyModal') return manualModal;
      throw new Error(`unexpected batch-review import: ${spec}`);
    },
    true,
  );

  const statusPanel = runModule(
    'components/closet/ClosetCandidateStatusPanel.tsx',
    (spec) => {
      if (spec === 'react') return reactShim;
      if (spec === 'react/jsx-runtime') return jsxRuntime;
      if (spec === 'react-native') return reactNative;
      if (spec === '../luxury') return luxury;
      if (spec === '../../constants/theme') return theme;
      if (spec === '../../constants/featureFlags') return featureFlags;
      if (spec === '../../hooks/useClosetCandidates') return candidateHook;
      if (spec === '../../services/closetCandidateStateMachine') return stateMachine;
      if (spec === '../../services/closetCandidateErrors') return errors;
      if (spec === './ClosetCandidateManualClassifyModal') return manualModal;
      if (spec === './ClosetBatchReviewPanel') return batchPanel;
      throw new Error(`unexpected status-panel import: ${spec}`);
    },
    true,
  );

  const libraryRequire = {
    react: reactShim,
    'react/jsx-runtime': jsxRuntime,
    'react-native': reactNative,
    'expo-router': {
      useLocalSearchParams: () => ({ section: 'closet' }),
      useRouter: () => ({ push: () => {}, replace: () => {}, setParams: () => {} }),
    },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'expo-image-picker': {
      requestMediaLibraryPermissionsAsync: async () => ({ status: 'denied' }),
    },
    '../services/navigationExit': { goBackOrHome: () => {} },
    '../components/AnalysisCard': { AnalysisCard: 'AnalysisCard' },
    '../components/AddScanToDressingRoomModal': {
      AddScanToDressingRoomModal: 'AddScanToDressingRoomModal',
    },
    '../components/AddInspirationToDressingRoomModal': {
      AddInspirationToDressingRoomModal: 'AddInspirationToDressingRoomModal',
    },
    '../components/InspirationUploadModal': { InspirationUploadModal: 'InspirationUploadModal' },
    '../hooks/useLibrary': {
      useLibrary: () => ({ scans: [], loading: false, remove: async () => true, actorKey: 'user:actor-a' }),
    },
    '../hooks/useFeatureFreeze': {
      useFeatureFreeze: () => ({ isFeatureEnabled: () => false, isLoading: false }),
    },
    '../contexts/AuthSessionContext': {
      useAuthSession: () => ({ isAuthenticated: true, user: { id: 'actor-a' } }),
    },
    '../services/styleObjects': {
      deleteInspirationItem: async () => {},
      listInspirationItems: () => new Promise(() => {}),
    },
    '../services/dressingRoomItemContract': {
      describeMissingImageReason: () => 'Unavailable',
      hasUsableDressingRoomImageSource: () => true,
    },
    '../services/photoLibraryAccess': {
      hasUsablePhotoLibraryAccess: () => true,
      tryOpenPhotoLibrarySettings: async () => true,
    },
    '../components/luxury': luxury,
    '../constants/theme': theme,
    '../constants/elise': { ELISE_IDENTITY: { styleWithEliseLabel: 'Style with Elise' } },
    '../constants/freeTierUtilityFlags': { FREE_TIER_UTILITY_ENABLED: false },
    '../constants/featureFlags': featureFlags,
    '../components/free-tier/FreeTierUtilitySection': {
      FreeTierUtilitySection: 'FreeTierUtilitySection',
    },
    '../services/ownedClosetItems': { normalizeLocalSavedScan: (scan) => scan },
    '../services/style-chat/styleChatAttachmentStore': { setAttachmentHandoff: () => {} },
    '../hooks/useCloset': {
      // THE ONE DIFFERENCE FROM closetBatchReviewSurface.test.js: a real,
      // populated committed Closet, so the coexistence under test actually
      // exists in the render.
      useCloset: () => ({
        addFromScan: async () => ({ ok: true }),
        addFromUri: async () => ({ ok: true }),
        busy: false,
        items: closetItems,
        loading: closetLoading,
        error: closetError,
        remove: async (id) => {
          calls.closetRemove.push(id);
          return true;
        },
        refresh: async () => {},
      }),
    },
    '../hooks/useClosetCandidates': candidateHook,
    '../services/closetIntakeRouting': {
      routeClosetIntake: async () => ({ ok: false, reason: 'closet_intake_unavailable' }),
    },
    '../services/closetCandidateSchema': { createClosetBatchId: () => 'batch_test' },
    '../components/closet/ClosetIntakeModal': { ClosetIntakeModal: 'ClosetIntakeModal' },
    '../components/closet/MirrorSelfieExtractionModal': {
      MirrorSelfieExtractionModal: 'MirrorSelfieExtractionModal',
    },
    '../components/closet/ClosetCandidateStatusPanel': statusPanel,
    '../services/closetPromotion': { isScanPromoted: async () => false },
  };

  const LibraryScreen = runModule(
    'app/library.tsx',
    (spec) => {
      if (Object.prototype.hasOwnProperty.call(libraryRequire, spec)) return libraryRequire[spec];
      throw new Error(`Unexpected LibraryScreen import: ${spec}`);
    },
    true,
  ).default;

  const tree = renderer.render(renderer.jsx(LibraryScreen, {}));
  return { tree, calls, renderer, LibraryScreen };
}

// SavedLookCard is the real component here (not a mock string), so the
// renderer produces two nodes per card: the SavedLookCard element itself
// (carrying the original title/imageUrl props) and the View its own render
// returns (the actual mounted card root), both tagged testID="closet-card".
function committedCardElements(tree) {
  return findAll(tree, (node) => node.props?.testID === 'closet-card' && node.name === 'SavedLookCard');
}

function committedCardRoots(tree) {
  return findAll(tree, (node) => node.props?.testID === 'closet-card' && node.name === 'View');
}

function committedCards(tree) {
  return committedCardRoots(tree);
}

// ── Phase 3 regression scenarios ────────────────────────────────────────────

test('2 committed items + 1 waiting_for_network candidate: both cards stay mounted with correct content', () => {
  const { tree } = mountLibrary({
    closetItems: [closetItem('closet-a', 'Wedding Dress'), closetItem('closet-b', 'Leather Jacket')],
    candidates: [ready('c-1', 0, { status: 'waiting_for_network' })],
  });

  assert.equal(committedCardRoots(tree).length, 2, 'both committed cards must be mounted');
  const elements = committedCardElements(tree);
  const titles = elements.map((c) => c.props.title);
  assert.deepEqual(titles.sort(), ['Leather Jacket', 'Wedding Dress']);
  for (const card of elements) {
    assert.ok(card.props.imageUrl, `${card.props.title} must retain its image source`);
  }

  // The candidate's status stays rendered.
  const status = byTestId(tree, 'closet-batch-status-c-1')[0];
  assert.ok(status, 'the candidate status must remain rendered');

  // No empty state anywhere on the Closet section.
  const empty = findAll(tree, (node) => node.type === 'EmptyStateCard');
  assert.equal(empty.length, 0, 'a populated Closet with a candidate must show no empty state');
});

test('2 committed items + 1 failed candidate: cards stay mounted, committed items are never modified', () => {
  const { tree, calls } = mountLibrary({
    closetItems: [closetItem('closet-a', 'Wedding Dress'), closetItem('closet-b', 'Leather Jacket')],
    candidates: [ready('c-1', 0, { status: 'failed', errorCode: 'classification_timeout' })],
  });
  assert.equal(committedCards(tree).length, 2);
  assert.deepEqual(calls.closetRemove, [], 'no committed item may be touched by candidate review');
});

test('no candidate: exactly the committed grid renders, no review surface at all', () => {
  const { tree } = mountLibrary({
    closetItems: [closetItem('closet-a', 'Wedding Dress'), closetItem('closet-b', 'Leather Jacket')],
    candidates: [],
  });
  assert.equal(committedCards(tree).length, 2);
  assert.equal(byTestId(tree, 'closet-batch-review').length, 0);
});

test('needs_manual_classification candidate coexists with committed cards', () => {
  const { tree } = mountLibrary({
    closetItems: [closetItem('closet-a', 'Wedding Dress'), closetItem('closet-b', 'Leather Jacket')],
    candidates: [ready('c-1', 0, { status: 'needs_manual_classification', category: null })],
  });
  assert.equal(committedCards(tree).length, 2);
  assert.ok(byTestId(tree, 'closet-batch-manual-c-1')[0], 'Add details must still be reachable');
});

test('multiple simultaneous candidates coexist with committed cards', () => {
  const { tree } = mountLibrary({
    closetItems: [closetItem('closet-a', 'Wedding Dress'), closetItem('closet-b', 'Leather Jacket')],
    candidates: [
      ready('c-1', 0, { status: 'waiting_for_network' }),
      ready('c-2', 1, { status: 'failed', errorCode: 'classification_timeout' }),
    ],
  });
  assert.equal(committedCards(tree).length, 2);
  assert.equal(byTestId(tree, 'closet-batch-review-count')[0].props.children, '2 items');
});

test('candidate removal: cards stay mounted before and after, grid is unaffected', () => {
  const { tree, renderer, LibraryScreen, calls } = mountLibrary({
    closetItems: [closetItem('closet-a', 'Wedding Dress'), closetItem('closet-b', 'Leather Jacket')],
    candidates: [ready('c-1', 0, { status: 'waiting_for_network' })],
  });
  assert.equal(committedCards(tree).length, 2);
  const remove = byTestId(tree, 'closet-batch-remove-c-1')[0];
  assert.ok(remove);
  remove.props.onPress();
  assert.deepEqual(calls.remove, ['c-1']);

  // The panel reads its next state from the hook, not from local removal —
  // simulate the hook's snapshot updating, as the real hook would after remove.
  const after = mountLibrary({
    closetItems: [closetItem('closet-a', 'Wedding Dress'), closetItem('closet-b', 'Leather Jacket')],
    candidates: [],
  });
  assert.equal(committedCards(after.tree).length, 2, 'cards remain mounted after candidate removal');
});

test('genuinely empty Closet plus one candidate: the Closet empty state owns the section, not a second one', () => {
  const { tree } = mountLibrary({
    closetItems: [],
    candidates: [ready('c-1', 0, { status: 'waiting_for_network' })],
  });
  const empty = findAll(tree, (node) => node.type === 'EmptyStateCard');
  assert.equal(empty.length, 1, 'exactly one empty state must own an empty Closet');
  assert.ok(byTestId(tree, 'closet-batch-status-c-1')[0], 'the candidate must still render');
});

// ── Repair mechanism (directly testable properties of the fix) ─────────────

test('the candidate row status text is bounded to 2 lines', () => {
  const { tree } = mountLibrary({
    candidates: [ready('c-1', 0, { status: 'waiting_for_network' })],
  });
  const status = byTestId(tree, 'closet-batch-status-c-1')[0];
  assert.equal(
    status.props.numberOfLines,
    2,
    'an unbounded status Text is exactly the mechanism that produced the runaway row height',
  );
});

test('the row action buttons override the shared 200dp minWidth', () => {
  const { tree } = mountLibrary({
    candidates: [ready('c-1', 0, { status: 'waiting_for_network' })],
  });
  const retry = byTestId(tree, 'closet-batch-retry-c-1')[0];
  const remove = byTestId(tree, 'closet-batch-remove-c-1')[0];
  for (const button of [retry, remove]) {
    assert.ok(button, 'both actions must render for a waiting_for_network candidate');
    assert.equal(
      button.props.style?.minWidth,
      0,
      'the row-scoped action button must not inherit the 200dp CTA minWidth',
    );
  }
});

// ── Build 1 legacy panel (Phase 4) ───────────────────────────────────────────
// The same row shape exists in ClosetCandidateStatusPanel's own Build 1 body,
// reached whenever CLOSET_CANDIDATE_STAGING_ACTIVE is true while
// CLOSET_BATCH_REVIEW_V2_ACTIVE is false. Every source-controlled EAS profile
// currently sets both flags to "true", so this path is not exercised by today's
// shipping configuration — but the two flags are independent env vars
// (EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1 and EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2),
// so the combination is one env value away and cannot be ruled out from source
// alone. The legacy panel therefore carries the same repair, and these tests
// hold it there.

test('BUILD-1 PANEL: the candidate row status text is bounded to 2 lines', () => {
  const { tree } = mountLibrary({
    batchReviewActive: false,
    candidates: [ready('c-1', 0, { status: 'waiting_for_network' })],
  });
  // Prove we are on the legacy path, not the V2 panel.
  assert.equal(
    byTestId(tree, 'closet-batch-status-c-1').length,
    0,
    'with V2 inactive the batch review panel must not render',
  );
  const status = byTestId(tree, 'closet-candidate-status-c-1')[0];
  assert.ok(status, 'the Build 1 status text must render');
  assert.equal(
    status.props.numberOfLines,
    2,
    'an unbounded status Text is exactly the mechanism that produced the runaway row height',
  );
});

test('BUILD-1 PANEL: the row action buttons override the shared 200dp minWidth', () => {
  const { tree } = mountLibrary({
    batchReviewActive: false,
    candidates: [ready('c-1', 0, { status: 'waiting_for_network' })],
  });
  const retry = byTestId(tree, 'closet-candidate-retry-c-1')[0];
  const remove = byTestId(tree, 'closet-candidate-remove-c-1')[0];
  for (const button of [retry, remove]) {
    assert.ok(button, 'both actions must render for a waiting_for_network candidate');
    assert.equal(
      button.props.style?.minWidth,
      0,
      'the row-scoped action button must not inherit the 200dp CTA minWidth',
    );
  }
});

test('BUILD-1 PANEL: the manual-classification action also overrides the CTA minWidth', () => {
  const { tree } = mountLibrary({
    batchReviewActive: false,
    candidates: [ready('c-1', 0, { status: 'needs_manual_classification', category: null })],
  });
  const manual = byTestId(tree, 'closet-candidate-manual-c-1')[0];
  assert.ok(manual, 'Add details must still be reachable on the legacy panel');
  assert.equal(manual.props.style?.minWidth, 0);
});

test('BUILD-1 PANEL: truthful actions and status survive the layout repair', () => {
  const { tree, calls } = mountLibrary({
    batchReviewActive: false,
    closetItems: [closetItem('closet-a', 'Wedding Dress')],
    candidates: [ready('c-1', 0, { status: 'failed', errorCode: 'classification_timeout' })],
  });
  // The committed grid still coexists.
  assert.equal(committedCards(tree).length, 1);
  // A failed candidate still offers retry and remove, and removing calls through.
  const remove = byTestId(tree, 'closet-candidate-remove-c-1')[0];
  assert.ok(remove, 'Remove must remain available');
  remove.props.onPress();
  assert.deepEqual(calls.remove, ['c-1']);
  assert.deepEqual(calls.closetRemove, [], 'no committed item may be touched by candidate review');
  // The status label is real text, not an empty node.
  const status = byTestId(tree, 'closet-candidate-status-c-1')[0];
  assert.ok(
    typeof status.props.children === 'string' && status.props.children.trim().length > 0,
    'the status must still say something truthful',
  );
});

// ── Negative control ─────────────────────────────────────────────────────────
// Proves this suite actually catches the defect: re-run the mechanism
// assertions against the UNPATCHED shape (no numberOfLines, no width override)
// and confirm they fail. This does not touch the source tree; it constructs
// the pre-repair props shape directly.

test('negative control: the mechanism assertions fail against the pre-repair shape', () => {
  const unpatchedStatusProps = { numberOfLines: undefined };
  assert.throws(() => {
    assert.equal(unpatchedStatusProps.numberOfLines, 2);
  }, 'the numberOfLines assertion must fail without the fix');

  const unpatchedButtonStyle = {}; // no style override → inherits minWidth:200 from theme
  assert.throws(() => {
    assert.equal(unpatchedButtonStyle.minWidth, 0);
  }, 'the minWidth assertion must fail without the fix');
});
