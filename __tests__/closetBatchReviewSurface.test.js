// Batch-review REACHABILITY and governance (Build 2, Phase 2).
//
// The real LibraryScreen is executed, and every component on the Closet candidate
// path is executed with it: ClosetCandidateStatusPanel, ClosetBatchReviewPanel and
// the real useClosetBatchSelection hook over the real projection. A tiny renderer
// invokes function components for real, so "the production surface reaches batch
// review" is proven by rendering it, not by reading the file.
//
// WHY THIS SUITE EXISTS AT ALL. Build 1 shipped with every candidate unit green
// and the one production intake path wired straight to the committed Closet: the
// pipeline was unreachable in the shipped app and no test noticed. These are the
// locks that fail the moment the same thing happens to review.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
// Eligibility defaults to the real clock, so a frozen literal eventually turns
// every otherwise-live fixture into an expired candidate.
const NOW = Date.now();

// ── Mini renderer ────────────────────────────────────────────────────────────

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
    /** Render until state settles, exactly as a React commit loop would. */
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

/**
 * Mount the REAL LibraryScreen with the REAL candidate surface beneath it.
 *
 * Only leaves that have nothing to do with review are tokenised. Everything on
 * the path under test — the panel, the batch review, the selection hook and the
 * projection — is the production module.
 */
function mountLibrary(options = {}) {
  const {
    batchReviewActive = true,
    stagingActive = true,
    candidates = [],
    activeBatchId = null,
    promotion = null,
    promoting = false,
  } = options;

  const renderer = createRenderer();
  const calls = {
    retry: [],
    remove: [],
    classifyManually: [],
    setActiveBatchId: [],
    promoteSelected: [],
  };

  const featureFlags = {
    AI_STYLIST_UI_ENABLED: false,
    STYLECHAT_ATTACHMENTS_ENABLED: false,
    CLOSET_SEPARATION_V1: true,
    CLOSET_DIRECT_INTAKE_ACTIVE: true,
    CLOSET_CANDIDATE_STAGING_ACTIVE: stagingActive,
    CLOSET_BATCH_REVIEW_V2_ACTIVE: batchReviewActive,
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
      },
      typography: { caption: {} },
    },
    SPACING: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 },
  };

  const reactNative = {
    ActivityIndicator: 'ActivityIndicator',
    Alert: { alert: () => {} },
    Dimensions: { get: () => ({ width: 400 }) },
    Image: 'Image',
    Linking: { openURL: async () => {}, openSettings: async () => {} },
    Modal: 'Modal',
    Platform: { OS: 'android' },
    ScrollView: 'ScrollView',
    StyleSheet: { absoluteFillObject: {}, create: (styles) => styles, hairlineWidth: 1 },
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
  };

  const luxury = {
    EmptyStateCard: 'EmptyStateCard',
    InlineNotice: 'InlineNotice',
    KScanHeader: 'KScanHeader',
    LuxuryScreen: 'LuxuryScreen',
    PrimaryButton: 'PrimaryButton',
    PrivacyFooter: 'PrivacyFooter',
    SavedLookCard: 'SavedLookCard',
    SecondaryButton: 'SecondaryButton',
    SectionHeader: 'SectionHeader',
  };

  const jsxRuntime = { Fragment: 'Fragment', jsx: renderer.jsx, jsxs: renderer.jsx };

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

  // The candidate hook's disk work is out of scope here; its own suites cover it.
  // What matters is that the surface receives ONE api object and drives every
  // mutation back through it.
  const candidateHookApi = {
    candidates,
    loading: false,
    busy: false,
    actorId: 'actor-a',
    actorEpoch: 4,
    activeBatchId,
    setActiveBatchId: (next) => calls.setActiveBatchId.push(next),
    stagingActive,
    batchIntakeActive: batchReviewActive,
    promotion,
    promoting,
    // The surface may only REACH promotion; the coordinator's own suite proves
    // what it then does. What matters here is that the production control exists
    // and hands the selection snapshot to this one api.
    promoteSelected: async (ids) => {
      calls.promoteSelected.push([...ids]);
      return { ok: true };
    },
    addFromUri: async () => ({ kind: 'rejected', code: 'candidate_invalid_transition' }),
    addFromAssets: async () => ({ kind: 'rejected', code: 'candidate_invalid_transition' }),
    retry: async (id) => {
      calls.retry.push(id);
      return { ok: true };
    },
    reject: async () => ({ ok: true }),
    remove: async (id) => {
      calls.remove.push(id);
      return { ok: true };
    },
    classifyManually: async (id, fields) => {
      calls.classifyManually.push({ id, fields });
      return { ok: true };
    },
    refresh: async () => {},
  };
  const candidateHook = { useClosetCandidates: () => candidateHookApi };

  const manualModal = { ClosetCandidateManualClassifyModal: 'ClosetCandidateManualClassifyModal' };

  const batchPanel = runModule(
    'components/closet/ClosetBatchReviewPanel.tsx',
    (spec) => {
      if (spec === 'react') return { ...renderer.react, default: renderer.react };
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
      if (spec === 'react') return { ...renderer.react, default: renderer.react };
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
    react: { ...renderer.react, default: renderer.react },
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
    '../services/actorContext': {
      createActorRequest: () => ({ actorId: 'test-actor', epoch: 1 }),
      isActorRequestCurrent: () => true,
    },
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
    // iPad forward-port (certified b14566c): card geometry is derived
    // per-render from the live window. A fixed compact-width stand-in keeps
    // this harness rendering the certified two-column phone layout.
    '../hooks/useResponsiveLayout': {
      useResponsiveLayout: () => ({
        width: 390,
        height: 844,
        widthClass: 'compact',
        isRegular: false,
        isLandscape: false,
        contentWidth: 390,
        contentMaxWidth: 840,
        formMaxWidth: 560,
        conversationMaxWidth: 640,
        modalMaxWidth: 560,
        gridColumns: 2,
        gridCellWidth: () => 165,
      }),
    },
    '../hooks/useClosetCandidates': candidateHook,
    '../services/closetIntakeRouting': {
      routeClosetIntake: async () => ({ ok: false, reason: 'closet_intake_unavailable' }),
    },
    '../services/closetCandidateSchema': { createClosetBatchId: () => 'batch_test' },
    '../components/closet/ClosetIntakeModal': { ClosetIntakeModal: 'ClosetIntakeModal' },
    // Closet V2 / S6 wear surface. Stubbed rather than executed: these tests
    // are about batch-review/promotion rendering, and the wear service owns
    // its own coverage in wearHistoryProductSurface.test.js.
    '../components/closet/WoreThisButton': { WoreThisButton: 'WoreThisButton' },
    '../services/wearHistory': {
      logItemWear: async () => ({ ok: true, deduplicated: false, event: { id: 'e', wornAt: '', savedLookId: null, sourceItemId: null, items: [] } }),
      getWearStats: async () => ({ ok: true, stats: [], truncated: false }),
      describeWearState: () => 'none_recorded',
      WEAR_TRACKING_STARTED_AT: '2026-08-14T00:00:00.000Z',
    },
    // Build 2.5 Step 3. Stubbed like its sibling: this harness renders the
    // Closet screen, and the Mirror sheet is gated off in every profile here.
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
  return { tree, calls, renderer, LibraryScreen, batchReview, statusPanel, batchPanel };
}

// ── Reachability ─────────────────────────────────────────────────────────────

test('the production Library surface reaches ordered batch review', () => {
  const { tree } = mountLibrary({
    candidates: [ready('c-1', 0), ready('c-2', 1), ready('c-3', 2)],
  });
  const panels = byTestId(tree, 'closet-batch-review');
  assert.equal(panels.length, 1, 'the Library must render exactly one batch-review surface');
  assert.equal(byTestId(tree, 'closet-batch-review-count')[0].props.children, '3 items');
});

test('a focused batch renders its candidates in picker order', () => {
  const { tree } = mountLibrary({
    candidates: [ready('third', 2), ready('first', 0), ready('second', 1)],
  });
  const order = ['first', 'second', 'third'].map(
    (id) => byTestId(tree, `closet-batch-select-${id}`)[0],
  );
  assert.ok(order.every(Boolean), 'every ready candidate must expose a selection control');
  // Selection controls appear in render order, so their sequence in the tree IS
  // the displayed order.
  const rendered = findAll(
    tree,
    (node) =>
      typeof node.props?.testID === 'string' &&
      node.props.testID.startsWith('closet-batch-select-') &&
      node.props.testID !== 'closet-batch-select-all',
  ).map((node) => node.props.testID);
  assert.deepEqual(rendered, [
    'closet-batch-select-first',
    'closet-batch-select-second',
    'closet-batch-select-third',
  ]);
});

test('the batch header summarises the mixed states it actually contains', () => {
  const { tree } = mountLibrary({
    candidates: [
      ready('r1', 0),
      ready('r2', 1),
      ready('r3', 2),
      ready('p1', 3, { status: 'classifying' }),
      ready('p2', 4, { status: 'queued' }),
      ready('n1', 5, { status: 'needs_manual_classification', category: null }),
      ready('d1', 6, { status: 'duplicate' }),
      ready('f1', 7, { status: 'failed', errorCode: 'classification_timeout' }),
    ],
  });
  assert.equal(byTestId(tree, 'closet-batch-review-count')[0].props.children, '8 items');
  const summary = byTestId(tree, 'closet-batch-review-summary')[0].props.children;
  assert.match(summary, /3 ready/);
  assert.match(summary, /2 processing/);
  assert.match(summary, /1 need details/);
  assert.match(summary, /1 already in your Closet/);
  assert.match(summary, /1 couldn't be identified/);
  // Zero counts are omitted rather than rendered as noise.
  assert.ok(!/0 /.test(summary), `a zero count was rendered: ${summary}`);
  assert.ok(!summary.includes('expired'));
  assert.ok(!summary.includes('waiting for connection'));
});

test('only a ready candidate exposes a selection control', () => {
  const { tree } = mountLibrary({
    candidates: [
      ready('ready', 0),
      ready('busy', 1, { status: 'classifying' }),
      ready('needs', 2, { status: 'needs_manual_classification', category: null }),
      ready('dupe', 3, { status: 'duplicate' }),
      ready('failed', 4, { status: 'failed', errorCode: 'classification_timeout' }),
    ],
  });
  assert.equal(byTestId(tree, 'closet-batch-select-ready').length, 1);
  for (const id of ['busy', 'needs', 'dupe', 'failed']) {
    assert.equal(byTestId(tree, `closet-batch-select-${id}`).length, 0, `${id} offered selection`);
  }
});

test('the selection control exposes checked state and toggles it', () => {
  const { tree, renderer, LibraryScreen } = mountLibrary({ candidates: [ready('a', 0)] });
  const control = byTestId(tree, 'closet-batch-select-a')[0];
  assert.equal(control.props.accessibilityRole, 'checkbox');
  assert.deepEqual(control.props.accessibilityState, { checked: false });
  assert.match(control.props.accessibilityLabel, /not selected/);

  control.props.onPress();
  const next = renderer.render(renderer.jsx(LibraryScreen, {}));
  const toggled = byTestId(next, 'closet-batch-select-a')[0];
  assert.deepEqual(toggled.props.accessibilityState, { checked: true });
  assert.match(toggled.props.accessibilityLabel, /selected/);
  assert.equal(byTestId(next, 'closet-batch-review-selected')[0].props.children, '1 selected');
});

test('select-all-ready is reachable and selects only the ready items', () => {
  const { tree, renderer, LibraryScreen } = mountLibrary({
    candidates: [
      ready('a', 0),
      ready('b', 1),
      ready('busy', 2, { status: 'classifying' }),
      ready('dupe', 3, { status: 'duplicate' }),
    ],
  });
  const selectAll = byTestId(tree, 'closet-batch-select-all')[0];
  assert.ok(selectAll, 'the select-all action must be reachable');
  selectAll.props.onPress();

  const next = renderer.render(renderer.jsx(LibraryScreen, {}));
  assert.equal(byTestId(next, 'closet-batch-review-selected')[0].props.children, '2 selected');
  assert.deepEqual(byTestId(next, 'closet-batch-select-a')[0].props.accessibilityState, {
    checked: true,
  });
  assert.deepEqual(byTestId(next, 'closet-batch-select-b')[0].props.accessibilityState, {
    checked: true,
  });
  // Everything eligible is chosen, so the action retires and Clear appears.
  assert.equal(byTestId(next, 'closet-batch-select-all').length, 0);
  const clear = byTestId(next, 'closet-batch-clear-selection')[0];
  assert.ok(clear);
  clear.props.onPress();
  const cleared = renderer.render(renderer.jsx(LibraryScreen, {}));
  assert.equal(byTestId(cleared, 'closet-batch-review-selected').length, 0);
});

test('a needs-details candidate exposes Add details, wired to the Build 1 editor', () => {
  const { tree } = mountLibrary({
    candidates: [ready('n', 0, { status: 'needs_manual_classification', category: null })],
  });
  const action = byTestId(tree, 'closet-batch-manual-n')[0];
  assert.ok(action, 'Add details must be reachable');
  assert.equal(action.props.title, 'Add details');

  const editors = findAll(tree, (node) => node.type === 'ClosetCandidateManualClassifyModal');
  assert.equal(editors.length, 1, 'the batch surface must mount the Build 1 editor');
  action.props.onPress();
});

test('a retryable failure exposes Retry, and it reaches the hook', async () => {
  const { tree, calls } = mountLibrary({
    candidates: [ready('f', 0, { status: 'failed', errorCode: 'classification_timeout' })],
  });
  const retry = byTestId(tree, 'closet-batch-retry-f')[0];
  assert.ok(retry, 'a retryable failure must offer Retry');
  retry.props.onPress();
  await Promise.resolve();
  assert.deepEqual(calls.retry, ['f']);
});

test('a non-retryable failure offers removal and no retry at all', () => {
  const { tree } = mountLibrary({
    candidates: [ready('f', 0, { status: 'failed', errorCode: 'candidate_media_unsupported' })],
  });
  assert.equal(byTestId(tree, 'closet-batch-retry-f').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-remove-f').length, 1);
});

test('a duplicate explains itself in plain language and offers no selection', () => {
  const { tree } = mountLibrary({
    candidates: [
      ready('d', 0, {
        status: 'duplicate',
        duplicateMatch: {
          closetItemId: 'closet-9',
          confidence: 1,
          reasons: ['exact_normalized_bytes'],
          algorithmVersion: 'sha256-normalized-v1',
        },
      }),
    ],
  });
  const message = byTestId(tree, 'closet-batch-message-d')[0];
  assert.ok(message, 'a duplicate must explain itself');
  assert.equal(message.props.children, 'This photo matches an item already in your Closet.');
  assert.equal(byTestId(tree, 'closet-batch-select-d').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-remove-d').length, 1);

  const rendered = textContent(tree);
  for (const leak of ['sha256', 'exact_normalized_bytes', 'closet-9']) {
    assert.ok(!rendered.includes(leak), `the surface leaked ${leak}`);
  }
});

test('a processing item has no selection control and no retry', () => {
  const { tree } = mountLibrary({ candidates: [ready('p', 0, { status: 'classifying' })] });
  assert.equal(byTestId(tree, 'closet-batch-select-p').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-retry-p').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-remove-p').length, 1);
});

test('a waiting candidate offers the existing manual retry, not a second mechanism', () => {
  const { tree, calls } = mountLibrary({
    candidates: [ready('w', 0, { status: 'waiting_for_network' })],
  });
  const retry = byTestId(tree, 'closet-batch-retry-w')[0];
  assert.ok(retry);
  assert.equal(byTestId(tree, 'closet-batch-select-w').length, 0);
  retry.props.onPress();
  assert.deepEqual(calls.retry, ['w'], 'reconnect must route through the one retry entry point');
});

test('every row exposes a spoken description carrying taxonomy, status and selection', () => {
  const { tree } = mountLibrary({
    candidates: [
      ready('a', 0, { category: 'Outerwear', clothingType: 'Jacket', primaryColor: 'Black' }),
      ready('b', 1, { status: 'classifying', category: 'Denim', clothingType: 'Jeans', primaryColor: 'Blue' }),
    ],
  });
  const labels = findAll(
    tree,
    (node) => typeof node.props?.accessibilityLabel === 'string',
  ).map((node) => node.props.accessibilityLabel);
  assert.ok(labels.includes('Outerwear · Jacket · Black, Ready to review, not selected'));
  assert.ok(labels.includes('Denim · Jeans · Blue, Identifying'));
});

test('switching the active batch is reachable and routes through the one hook instance', () => {
  const { tree, calls } = mountLibrary({
    candidates: [
      ready('new-1', 0, { batchId: 'batch-new', createdAt: '2026-07-28T10:00:00.000Z' }),
      ready('old-1', 0, { batchId: 'batch-old', createdAt: '2026-07-20T10:00:00.000Z' }),
    ],
    activeBatchId: 'batch-new',
  });
  const tab = byTestId(tree, 'closet-batch-tab-batch-old')[0];
  assert.ok(tab, 'a second batch must be reachable');
  assert.deepEqual(tab.props.accessibilityState, { selected: false });
  tab.props.onPress();
  assert.deepEqual(calls.setActiveBatchId, ['batch-old']);
});

test('a pre-batch candidate is shown under neutral copy, never the word legacy', () => {
  const { tree } = mountLibrary({
    candidates: [ready('legacy', null, { batchId: 'batch-legacy', batchPosition: null })],
  });
  assert.equal(byTestId(tree, 'closet-batch-review-count')[0].props.children, 'Previous item');
  assert.ok(!/legacy/i.test(textContent(tree)), 'user-facing copy said "legacy"');
});

// ── Flag-off behaviour ───────────────────────────────────────────────────────

test('with V2 off the Library renders exactly the Build 1 candidate panel', () => {
  const { tree } = mountLibrary({
    batchReviewActive: false,
    candidates: [ready('a', 0), ready('b', 1)],
  });
  assert.equal(byTestId(tree, 'closet-batch-review').length, 0, 'batch review must not mount');
  assert.equal(byTestId(tree, 'closet-batch-select-a').length, 0);
  const rendered = textContent(tree);
  assert.match(rendered, /WAITING FOR REVIEW/, 'the Build 1 heading must be intact');
  assert.ok(!rendered.includes('REVIEW ITEMS'));
  assert.ok(!rendered.includes('Select all ready'));
});

test('with candidate staging off nothing candidate-shaped is mounted at all', () => {
  const { tree } = mountLibrary({
    stagingActive: false,
    batchReviewActive: false,
    candidates: [ready('a', 0)],
  });
  assert.equal(byTestId(tree, 'closet-batch-review').length, 0);
  const rendered = textContent(tree);
  assert.ok(!rendered.includes('WAITING FOR REVIEW'));
  assert.ok(!rendered.includes('REVIEW ITEMS'));
  // The committed Closet is untouched and still owns its own empty state.
  const empty = findAll(tree, (node) => node.type === 'EmptyStateCard');
  assert.equal(empty.length, 1);
  assert.equal(empty[0].props.title, 'Your Closet is empty');
});

// ── Governance locks ─────────────────────────────────────────────────────────

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('the production Library candidate mount point reaches batch review', () => {
  // DEAD-CODE LOCK. If the Library stops mounting the candidate surface, or the
  // candidate surface stops delegating to batch review, this fails — and the
  // render tests above fail with it.
  const library = readSource('app/library.tsx');
  assert.ok(
    /CLOSET_CANDIDATE_STAGING_ACTIVE \? \(\s*<ClosetCandidateStatusPanel\s+api=\{closetCandidates\}\s*\/>\s*\) : null/.test(
      library,
    ),
    'the Library must keep mounting the candidate surface under the derived capability',
  );

  const panel = readSource('components/closet/ClosetCandidateStatusPanel.tsx');
  assert.ok(
    panel.includes('CLOSET_BATCH_REVIEW_V2_ACTIVE'),
    'the candidate surface must gate review on the derived V2 capability',
  );
  assert.ok(
    /if \(CLOSET_BATCH_REVIEW_V2_ACTIVE\) \{\s*return <ClosetBatchReviewPanel api=\{api\} \/>;/.test(
      panel,
    ),
    'the candidate surface must delegate to batch review, passing its one api instance',
  );
});

test('batch review reads selection eligibility from the one authoritative source', () => {
  // The component must not form a second opinion, and the projection must be the
  // only thing that asks the predicate.
  const panel = stripComments(readSource('components/closet/ClosetBatchReviewPanel.tsx'));
  assert.ok(
    panel.includes('getClosetBatchReviewProjection'),
    'the review surface must render from the projection',
  );
  assert.ok(
    panel.includes('useClosetBatchSelection'),
    'the review surface must use the shared selection hook',
  );
  assert.ok(
    !panel.includes('closetCandidateReviewEligibility'),
    'the component must not reach past the projection to the predicate',
  );
  for (const status of [
    "'ready_for_review'",
    "'needs_manual_classification'",
    "'duplicate'",
    "'waiting_for_network'",
    "'classifying'",
    "'queued'",
  ]) {
    assert.ok(
      !panel.includes(status),
      `the component re-decided status ${status}; that belongs to the projection`,
    );
  }

  const selection = stripComments(readSource('hooks/useClosetBatchSelection.ts'));
  assert.ok(
    !selection.includes("'ready_for_review'"),
    'the selection hook must not carry its own status vocabulary',
  );
  assert.ok(
    selection.includes('reconcileClosetBatchSelection'),
    'the selection hook must reconcile through the shared helper',
  );

  const projection = stripComments(readSource('services/closetBatchReview.ts'));
  assert.ok(
    projection.includes('getClosetCandidateReviewEligibility'),
    'the projection must ask the authoritative predicate',
  );
});

test('there is exactly one selection-eligibility implementation in the repository', () => {
  const files = [
    'services/closetBatchReview.ts',
    'components/closet/ClosetBatchReviewPanel.tsx',
    'components/closet/ClosetCandidateStatusPanel.tsx',
    'hooks/useClosetBatchSelection.ts',
    'hooks/useClosetCandidates.js',
  ];
  const definitions = files.filter((rel) =>
    /export function (getClosetCandidateReviewEligibility|isClosetCandidateSelectable)/.test(
      readSource(rel),
    ),
  );
  assert.deepEqual(definitions, [], 'the predicate must be defined only in its own module');
  const owner = readSource('services/closetCandidateReviewEligibility.ts');
  assert.equal(
    (owner.match(/export function getClosetCandidateReviewEligibility/g) ?? []).length,
    1,
  );
});

test('no Phase 2 surface exposes or implements promotion', () => {
  const files = [
    'services/closetBatchReview.ts',
    'services/closetCandidateReviewEligibility.ts',
    'hooks/useClosetBatchSelection.ts',
    'components/closet/ClosetBatchReviewPanel.tsx',
    'components/closet/ClosetCandidateStatusPanel.tsx',
  ];
  const forbidden = [
    'sourceCandidateId',
    'promoteCandidate',
    'promotionCoordinator',
    'promotionQueue',
    'promotionLedger',
    'promotionTombstone',
    'createClosetItem',
    'updateClosetItem',
    'deleteClosetItem',
    'promoteScanToCloset',
    'Add selected to Closet',
    'Add to Closet',
  ];
  for (const rel of files) {
    const code = stripComments(readSource(rel));
    for (const symbol of forbidden) {
      assert.ok(!code.includes(symbol), `${rel} introduces promotion symbol ${symbol}`);
    }
  }
});

test('no Phase 2 surface writes candidate storage or the committed Closet', () => {
  const files = [
    'services/closetBatchReview.ts',
    'services/closetCandidateReviewEligibility.ts',
    'hooks/useClosetBatchSelection.ts',
    'components/closet/ClosetBatchReviewPanel.tsx',
  ];
  const forbidden = [
    'closetCandidateLibrary',
    'closetCandidateMedia',
    'closetLibrary',
    'persistCandidates',
    'transitionClosetCandidate',
    'updateClosetCandidate',
    'deleteClosetCandidate',
    'AsyncStorage',
    'expo-file-system',
    'supabase',
  ];
  for (const rel of files) {
    const code = stripComments(readSource(rel));
    for (const symbol of forbidden) {
      assert.ok(!code.includes(symbol), `${rel} reaches persistence via ${symbol}`);
    }
  }
});

test('every mutation the review surface offers goes back through the one hook api', () => {
  const panel = stripComments(readSource('components/closet/ClosetBatchReviewPanel.tsx'));
  // Destructured from the injected api, never imported.
  assert.ok(/retry,\s*\n?\s*remove,\s*\n?\s*classifyManually,/.test(panel));
  assert.ok(panel.includes('void retry(item.candidateId)'));
  assert.ok(panel.includes('void remove(item.candidateId)'));
  assert.ok(panel.includes('onSubmit={classifyManually}'));
  assert.ok(
    !panel.includes("from '../../services/closetCandidateLibrary'"),
    'the surface must not import the store',
  );
});

test('the candidate hook focuses a new batch only through the shared resolver', () => {
  const hook = stripComments(readSource('hooks/useClosetCandidates.js'));
  assert.ok(hook.includes('resolveClosetBatchFocus'), 'focus must use the shared resolver');
  assert.ok(
    /const focusBatchId = resolveClosetBatchFocus\(result\);\s*if \(focusBatchId\) setActiveBatchId\(focusBatchId\);/.test(
      hook,
    ),
    'a batch is focused only when the resolver says a record was durably created',
  );
  assert.ok(
    !/setActiveBatchId\(result\.batchId\)/.test(hook),
    'the hook must not focus a batch straight off the intake outcome',
  );
  // Selection and active batch are never persisted by the hook.
  assert.ok(!hook.includes('selectedCandidateIds'), 'the candidate hook must not own selection');
});

test('KSB29-027: unbounded status text cannot collapse the review row', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'closet', 'ClosetBatchReviewPanel.tsx'),
    'utf8',
  );

  // The defect: a long network/error message grew the body until the action
  // column was squeezed out and the committed Closet grid below was pushed off
  // screen. The row is otherwise a working surface -- this is a layout bound,
  // not a redesign.
  const statusBlock = source.slice(
    source.indexOf('testID={`closet-batch-status-'),
    source.indexOf('</View>', source.indexOf('closet-batch-message-')),
  );
  assert.match(statusBlock, /numberOfLines=\{2\}/, 'status text must be bounded');

  const messageBlock = source.slice(
    source.indexOf('style={styles.message}'),
    source.indexOf('testID={`closet-batch-message-'),
  );
  assert.match(messageBlock, /numberOfLines=\{2\}/, 'the status message must be bounded');

  // Every action control keeps a fixed footprint, so the body cannot win the
  // flex fight against the column the row exists for.
  const actionButtons = source.match(/<SecondaryButton\s+style=\{styles\.actionButton\}/g) || [];
  assert.equal(actionButtons.length, 3, 'all three row actions must be width-bounded');

  assert.match(source, /actions:\s*\{[^}]*flexShrink:\s*0/, 'the action column must not shrink');
  assert.match(source, /actionButton:\s*\{[^}]*minWidth:\s*\d+/, 'actions need a minimum width');
  // Added now rather than left for the accessibility wave to come back to.
  assert.match(source, /actionButton:\s*\{[^}]*minHeight:\s*48/, 'actions need a 48dp target');

  // A tall body must grow the row downward rather than centring against it.
  assert.match(source, /row:\s*\{[^}]*alignItems:\s*'flex-start'/);
});
