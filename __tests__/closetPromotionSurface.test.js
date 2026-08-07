// PROMOTION REACHABILITY, PROJECTION CONTINUITY and GOVERNANCE (Build 2, Phase 3).
//
// The real LibraryScreen is executed with the real candidate surface, the real
// batch-review panel, the real selection hook and the real projection beneath it.
// "The production surface can promote" is proven by rendering the screen and
// pressing the control, not by reading the file.
//
// WHY THIS SUITE EXISTS. Build 1 shipped with every unit green and the production
// intake path wired straight past the candidate pipeline. Phase 2 added the locks
// that catch that for review. These are the same locks for promotion: if the
// Library stops reaching the coordinator, if a component starts writing the
// committed manifest, or if a promoted card silently drops out of its batch, this
// suite fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
// The projection reads the real clock (eligibility defaults nowMs to Date.now()),
// so a frozen literal here silently rots: every "live" fixture below is minted
// relative to NOW, and once wall-clock passed NOW + the candidate TTL they all
// became `expired` and lost their selection controls.
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
    if (typeof element !== 'object') {
      return { type: '#text', props: {}, value: element, children: [] };
    }
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
    schemaVersion: 3,
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
    promotedClosetItemId: null,
    promotedAt: null,
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

function promoted(id, position, closetItemId, overrides = {}) {
  return ready(id, position, {
    status: 'saved',
    promotedClosetItemId: closetItemId,
    promotedAt: '2026-07-28T11:00:00.000Z',
    ...overrides,
  });
}

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
  const closetRefreshCalls = { count: 0 };
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
    // The coordinator's own suite proves what promotion DOES. What matters here is
    // that the production control exists, is gated correctly, and hands the
    // selection snapshot to this one api rather than reaching a service directly.
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

  const manualModal = {
    ClosetCandidateManualClassifyModal: 'ClosetCandidateManualClassifyModal',
  };

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
      // THE SURFACE LOCK. The panel may not import the promotion coordinator, the
      // candidate store, the committed Closet, or the filesystem.
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
      useLibrary: () => ({
        scans: [],
        loading: false,
        remove: async () => true,
        actorKey: 'user:actor-a',
      }),
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
    // `refresh` is part of the real useCloset contract and MUST be present here.
    // Omitting it is what let BUG-13 through: a promotion committed the record
    // and nothing re-read the committed manifest, and this harness could not
    // observe the difference. The counter makes that seam assertable.
    '../hooks/useCloset': {
      useCloset: () => ({
        addFromScan: async () => ({ ok: true }),
        addFromUri: async () => ({ ok: true }),
        busy: false,
        items: [],
        loading: false,
        error: null,
        remove: async () => true,
        refresh: async () => {
          closetRefreshCalls.count += 1;
        },
      }),
    },
    '../hooks/useClosetCandidates': candidateHook,
    '../services/closetIntakeRouting': {
      routeClosetIntake: async () => ({ ok: false, reason: 'closet_intake_unavailable' }),
    },
    '../services/closetCandidateSchema': { createClosetBatchId: () => 'batch_test' },
    '../components/closet/ClosetIntakeModal': { ClosetIntakeModal: 'ClosetIntakeModal' },
    '../components/closet/ClosetItemEditModal': { ClosetItemEditModal: 'ClosetItemEditModal' },
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
  return {
    tree,
    calls,
    renderer,
    LibraryScreen,
    batchReview,
    promotionContract,
    closetRefreshCalls,
  };
}

// ── Reachability ─────────────────────────────────────────────────────────────

test('the production Library surface reaches the promotion action with a selection', () => {
  const { tree, renderer, LibraryScreen, calls } = mountLibrary({
    candidates: [ready('a', 0), ready('b', 1), ready('c', 2)],
  });

  // No selection, no action: an affordance that would promote nothing is noise.
  assert.equal(byTestId(tree, 'closet-batch-promote').length, 0);

  byTestId(tree, 'closet-batch-select-a')[0].props.onPress();
  byTestId(renderer.render(renderer.jsx(LibraryScreen, {})), 'closet-batch-select-c')[0]
    .props.onPress();
  const withSelection = renderer.render(renderer.jsx(LibraryScreen, {}));

  const action = byTestId(withSelection, 'closet-batch-promote')[0];
  assert.ok(action, 'the production promotion action must be reachable');
  assert.equal(action.props.title, 'Add selected to Closet');
  assert.match(action.props.accessibilityLabel, /2 selected/);

  action.props.onPress();
  assert.equal(calls.promoteSelected.length, 1, 'the action must reach the one hook api');
  assert.deepEqual(calls.promoteSelected[0], ['a', 'c'], 'the submitted snapshot is wrong');
});

test('BUG-13: promoting re-reads the committed Closet so the new item can appear', async () => {
  // Promotion is the ONLY path that commits a Closet item from the candidate
  // side, and the two hooks hold independent snapshots. Without this re-read the
  // record lands on disk and the grid never shows it — "I added an item and my
  // Closet is still empty".
  const { tree, renderer, LibraryScreen, closetRefreshCalls } = mountLibrary({
    candidates: [ready('a', 0), ready('b', 1)],
  });

  byTestId(tree, 'closet-batch-select-a')[0].props.onPress();
  const withSelection = renderer.render(renderer.jsx(LibraryScreen, {}));
  assert.equal(closetRefreshCalls.count, 0, 'nothing re-reads before a promotion');

  await byTestId(withSelection, 'closet-batch-promote')[0].props.onPress();

  assert.equal(
    closetRefreshCalls.count,
    1,
    'the committed Closet must be re-read once the promotion settles',
  );
});

test('while an operation is running the action is disabled and progress is shown', () => {
  const { tree, calls } = mountLibrary({
    candidates: [ready('a', 0), ready('b', 1), ready('c', 2)],
    promoting: true,
    promotion: {
      batchId: 'batch-1',
      requestedCount: 3,
      completedCount: 1,
      promotedCount: 1,
      alreadyPromotedCount: 0,
      failedCount: 0,
      activeCandidateId: 'b',
      pendingCandidateIds: ['c'],
      results: [],
      done: false,
    },
  });

  const progress = byTestId(tree, 'closet-batch-promotion-progress')[0];
  assert.ok(progress, 'aggregate progress must be visible');
  assert.equal(progress.props.children, 'Adding 2 of 3');
  assert.equal(progress.props.accessibilityLiveRegion, 'polite');

  // The active card says so, in words, and shows activity.
  assert.equal(byTestId(tree, 'closet-batch-status-b')[0].props.children, 'Adding to Closet');
  assert.equal(byTestId(tree, 'closet-batch-promoting-b').length, 1);
  // Exactly one card is ever active.
  assert.equal(
    findAll(tree, (node) => String(node.props?.testID ?? '').startsWith('closet-batch-promoting-'))
      .length,
    1,
  );
  // The pending card is neutral, never "saving", and never a second spinner.
  assert.equal(byTestId(tree, 'closet-batch-status-c')[0].props.children, 'Waiting to be added');
  // The active card offers nothing that could race its own write.
  assert.equal(byTestId(tree, 'closet-batch-select-b').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-remove-b').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-retry-b').length, 0);
  assert.equal(calls.promoteSelected.length, 0);
});

test('a repeated tap while promoting cannot start a second operation', () => {
  const { tree, calls } = mountLibrary({
    candidates: [ready('a', 0)],
    promoting: true,
    promotion: {
      batchId: 'batch-1',
      requestedCount: 1,
      completedCount: 0,
      promotedCount: 0,
      alreadyPromotedCount: 0,
      failedCount: 0,
      activeCandidateId: 'a',
      pendingCandidateIds: [],
      results: [],
      done: false,
    },
  });
  const action = byTestId(tree, 'closet-batch-promote')[0];
  // The only reachable state for the control while an operation runs is disabled.
  if (action) {
    assert.equal(action.props.disabled, true);
    assert.equal(action.props.loading, true);
  }
  assert.equal(calls.promoteSelected.length, 0);
});

// ── Promoted continuity ──────────────────────────────────────────────────────

test('a promoted candidate stays in its batch, in place, inert, and says where it is', () => {
  const { tree } = mountLibrary({
    candidates: [
      ready('first', 0),
      promoted('second', 1, 'closet_2'),
      ready('third', 2),
    ],
  });

  // Still counted, still in position, and the summary names it.
  assert.equal(byTestId(tree, 'closet-batch-review-count')[0].props.children, '3 items');
  assert.match(
    byTestId(tree, 'closet-batch-review-summary')[0].props.children,
    /1 added to Closet/,
  );
  assert.equal(byTestId(tree, 'closet-batch-status-second')[0].props.children, 'Added to Closet');

  const order = findAll(
    tree,
    (node) => typeof node.props?.testID === 'string' && node.props.testID.startsWith('closet-batch-status-'),
  ).map((node) => node.props.testID);
  assert.deepEqual(order, [
    'closet-batch-status-first',
    'closet-batch-status-second',
    'closet-batch-status-third',
  ]);

  // Inert: no selection control, no retry, no remove, no promotion spinner.
  assert.equal(byTestId(tree, 'closet-batch-select-second').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-retry-second').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-remove-second').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-promoting-second').length, 0);

  // The committed item id is never rendered to the user.
  assert.ok(!textContent(tree).includes('closet_2'));
});

test('select-all-ready never re-selects a promoted card', () => {
  const { tree, renderer, LibraryScreen } = mountLibrary({
    candidates: [ready('a', 0), promoted('b', 1, 'closet_b'), ready('c', 2)],
  });
  byTestId(tree, 'closet-batch-select-all')[0].props.onPress();
  const next = renderer.render(renderer.jsx(LibraryScreen, {}));
  assert.equal(byTestId(next, 'closet-batch-review-selected')[0].props.children, '2 selected');
  assert.deepEqual(byTestId(next, 'closet-batch-promote')[0].props.accessibilityLabel.match(/\d+/g), [
    '2',
  ]);
  assert.equal(byTestId(next, 'closet-batch-select-b').length, 0);
});

test('a promoted-only batch renders as complete rather than as an empty review list', () => {
  const { tree } = mountLibrary({
    candidates: [promoted('a', 0, 'closet_a'), promoted('b', 1, 'closet_b')],
  });
  assert.equal(byTestId(tree, 'closet-batch-review').length, 1);
  assert.equal(byTestId(tree, 'closet-batch-review-count')[0].props.children, '2 items');
  assert.match(
    byTestId(tree, 'closet-batch-review-summary')[0].props.children,
    /2 added to Closet/,
  );
  assert.equal(byTestId(tree, 'closet-batch-promote').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-select-all').length, 0);
});

test('a promoted card past its draft lifetime still reads as added, never as expired', () => {
  const { tree } = mountLibrary({
    candidates: [
      promoted('a', 0, 'closet_a', { expiresAt: new Date(NOW - 1000).toISOString() }),
    ],
  });
  assert.equal(byTestId(tree, 'closet-batch-status-a')[0].props.children, 'Added to Closet');
  assert.ok(!textContent(tree).includes('Expired'));
  assert.equal(byTestId(tree, 'closet-batch-remove-a').length, 0);
});

// ── Flag gating ──────────────────────────────────────────────────────────────

test('with V2 off there is no promotion control anywhere on the Library', () => {
  const { tree } = mountLibrary({
    batchReviewActive: false,
    candidates: [ready('a', 0), ready('b', 1)],
  });
  assert.equal(byTestId(tree, 'closet-batch-promote').length, 0);
  assert.equal(byTestId(tree, 'closet-batch-promotion-progress').length, 0);
  const rendered = textContent(tree);
  assert.ok(!rendered.includes('Add selected to Closet'));
  assert.ok(!rendered.includes('Adding to Closet'));
  // Build 1's surface is intact and unchanged.
  assert.match(rendered, /WAITING FOR REVIEW/);
});

test('with candidate staging off nothing promotion-shaped is mounted at all', () => {
  const { tree } = mountLibrary({
    stagingActive: false,
    batchReviewActive: false,
    candidates: [ready('a', 0)],
  });
  assert.equal(byTestId(tree, 'closet-batch-promote').length, 0);
  const rendered = textContent(tree);
  assert.ok(!rendered.includes('Add selected to Closet'));
  // The committed Closet still owns its own empty state, untouched.
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

test('the production Library candidate mount point still reaches batch review', () => {
  const library = readSource('app/library.tsx');
  assert.ok(
    /CLOSET_CANDIDATE_STAGING_ACTIVE \? \(\s*<ClosetCandidateStatusPanel\s+api=\{closetCandidates(?:WithCommitBridge)?\}\s*\/>\s*\) : null/.test(
      library,
    ),
    'the Library must keep mounting the candidate surface under the derived capability',
  );
  const panel = readSource('components/closet/ClosetCandidateStatusPanel.tsx');
  assert.ok(
    /if \(CLOSET_BATCH_REVIEW_V2_ACTIVE\) \{\s*return <ClosetBatchReviewPanel api=\{api\} \/>;/.test(
      panel,
    ),
    'the candidate surface must delegate to batch review, passing its one api instance',
  );
});

test('the review surface reaches promotion only through the one hook api', () => {
  const panel = stripComments(readSource('components/closet/ClosetBatchReviewPanel.tsx'));
  assert.ok(panel.includes('promoteSelected'), 'the surface must call the hook api');
  assert.ok(
    panel.includes('void promoteSelected([...selection.selectedCandidateIds])'),
    'the surface must submit a SNAPSHOT of the selection, not the live set',
  );
  // The component may not reach any service directly. The PURE promotion
  // vocabulary is allowed and is the only promotion module it may import, so the
  // coordinator specifier is matched with its closing quote rather than as a
  // prefix of `closetCandidatePromotionContract`.
  for (const symbol of [
    "closetCandidatePromotion'",
    'promoteSelectedClosetCandidates',
    'closetCandidateLibrary',
    'closetLibrary',
    'createClosetItem',
    'updateClosetItem',
    'deleteClosetItem',
    'finalizeClosetCandidatePromotion',
    'transitionClosetCandidate',
    'expo-file-system',
    'expo-image-manipulator',
    'AsyncStorage',
    'supabase',
  ]) {
    assert.ok(!panel.includes(symbol), `the review surface reaches ${symbol} directly`);
  }
});

test('no UI module writes the committed manifest or copies committed media', () => {
  const files = [
    'components/closet/ClosetBatchReviewPanel.tsx',
    'components/closet/ClosetCandidateStatusPanel.tsx',
    'hooks/useClosetBatchSelection.ts',
    'services/closetBatchReview.ts',
    'services/closetCandidateReviewEligibility.ts',
    'services/closetCandidatePromotionContract.ts',
  ];
  const forbidden = [
    'createClosetItem',
    'updateClosetItem',
    'deleteClosetItem',
    'persistCloset',
    'closetPromotionMediaAssetId',
    'deriveClosetMedia',
    'manipulateAsync',
    'expo-file-system',
    'kscan_closet',
  ];
  for (const rel of files) {
    const code = stripComments(readSource(rel));
    for (const symbol of forbidden) {
      assert.ok(!code.includes(symbol), `${rel} reaches committed storage via ${symbol}`);
    }
  }
});

test('the committed write and the media destination live in the committed store alone', () => {
  const coordinator = stripComments(readSource('services/closetCandidatePromotion.js'));
  // The coordinator ORCHESTRATES; it never writes either store itself.
  assert.ok(coordinator.includes('createClosetItem'), 'promotion must use the Closet service');
  assert.ok(
    coordinator.includes('finalizeClosetCandidatePromotion'),
    'promotion must finalize through the candidate store',
  );
  for (const symbol of [
    'expo-file-system',
    'expo-image-manipulator',
    'writeAsStringAsync',
    'moveAsync',
    'deleteAsync',
    'persistCandidates',
    'kscan_closet',
  ]) {
    assert.ok(!coordinator.includes(symbol), `the coordinator touches the filesystem via ${symbol}`);
  }

  // The destination is derived from the promotion identity INSIDE the store, so
  // no caller can choose a filename.
  const store = stripComments(readSource('services/closetLibrary.js'));
  assert.ok(store.includes('export function closetPromotionMediaAssetId'));
  assert.ok(
    !coordinator.includes('closetPromotionMediaAssetId'),
    'the coordinator must not choose the committed media destination',
  );
});

test('promotion never reaches Recent Scan, Elise, StyleChat, commerce or the network', () => {
  const files = [
    'services/closetCandidatePromotion.js',
    'services/closetCandidatePromotionContract.ts',
    'services/closetBatchReview.ts',
  ];
  const forbidden = [
    'saveScan',
    'services/library',
    './library',
    'savedScansCloud',
    'styleChat',
    'stylechat',
    'elise',
    'Elise',
    'purchaseOptions',
    'retailer',
    'affiliate',
    'checkout',
    'price',
    'sku',
    'supabase',
    'fetch(',
  ];
  for (const rel of files) {
    const code = stripComments(readSource(rel));
    for (const symbol of forbidden) {
      assert.ok(!code.includes(symbol), `${rel} reaches ${symbol}`);
    }
  }
});

test('candidate media cleanup is never triggered by promotion in this phase', () => {
  const coordinator = stripComments(readSource('services/closetCandidatePromotion.js'));
  for (const symbol of [
    'deleteClosetCandidate',
    'deleteClosetCandidateBatch',
    'rejectClosetCandidate',
    'unlinkUnreferencedCandidateMedia',
    'sweepOrphanedClosetCandidateMedia',
    'cleanupExpiredClosetCandidates',
  ]) {
    assert.ok(
      !coordinator.includes(symbol),
      `promotion triggers candidate cleanup via ${symbol}; that is Phase 4`,
    );
  }
  // And the expiry sweep explicitly spares a promoted tombstone.
  const store = stripComments(readSource('services/closetCandidateLibrary.js'));
  assert.ok(
    /entry\.status !== 'saved'/.test(store),
    'the expiry sweep must not collect promoted tombstones in this phase',
  );
});

test('the promotion tombstone is protected against every generic write path', () => {
  const store = readSource('services/closetCandidateLibrary.js');
  const protectedList = store.slice(
    store.indexOf('CLOSET_CANDIDATE_PROTECTED_FIELDS'),
    store.indexOf('PATCHABLE_FIELDS'),
  );
  assert.ok(protectedList.includes("'promotedClosetItemId'"));
  assert.ok(protectedList.includes("'promotedAt'"));

  const patchable = store.slice(
    store.indexOf('const PATCHABLE_FIELDS'),
    store.indexOf('let candidateMutationQueue'),
  );
  assert.ok(!patchable.includes('promotedClosetItemId'));
  assert.ok(!patchable.includes('promotedAt'));

  // Exactly one writer.
  const writers = (store.match(/promotedClosetItemId: closetItemId/g) ?? []).length;
  assert.equal(writers, 1, 'the tombstone must have exactly one writer');
});

test('promotion order is the display order, from one shared comparator', () => {
  const projection = stripComments(readSource('services/closetBatchReview.ts'));
  const coordinator = stripComments(readSource('services/closetCandidatePromotion.js'));
  assert.ok(projection.includes('export function compareClosetBatchOrder'));
  assert.ok(coordinator.includes('compareClosetBatchOrder'));
  // The coordinator must not carry its own ordering rule.
  assert.ok(!coordinator.includes('batchPosition -'), 'a second ordering rule appeared');
});

test('the selection hook still owns nothing but selection', () => {
  const selection = stripComments(readSource('hooks/useClosetBatchSelection.ts'));
  for (const symbol of ['promote', 'Promotion', 'closetLibrary', 'AsyncStorage']) {
    assert.ok(!selection.includes(symbol), `the selection hook acquired ${symbol}`);
  }
  assert.ok(selection.includes('reconcileClosetBatchSelection'));
});

test('the candidate hook cancels the queue on background and on actor change', () => {
  const hook = stripComments(readSource('hooks/useClosetCandidates.js'));
  assert.ok(hook.includes("AppState.addEventListener('change'"), 'no lifecycle listener');
  // NARROWED BY BUILD 2.5 STEP 4: the single-line form
  // `if (nextState !== 'active') promotionLiveRef.current = false;` became a
  // block once backgrounding also had to clear
  // mirrorIntegrationLiveRef.current — same invariant (backgrounding still
  // clears promotion's continue flag), different source shape. The regex
  // tolerates whatever comes between the condition and the assignment rather
  // than requiring them on one line.
  assert.ok(
    /nextState !== 'active'\)\s*\{[\s\S]{0,80}promotionLiveRef\.current = false/.test(hook),
    'backgrounding must clear the continue flag',
  );
  assert.ok(
    /shouldContinue: \(\) => promotionLiveRef\.current === true/.test(hook),
    'the coordinator must be given the cooperative cancellation predicate',
  );
  // An actor transition invalidates the queue and the operation the UI shows.
  assert.ok(/promotionLiveRef\.current = false;\s*promotionGenerationRef\.current \+= 1;/.test(hook));
  // A stale consumer settles nothing.
  assert.ok(hook.includes('if (!isCurrent()) return;'));
  assert.match(
    hook,
    /onProgress: async \(event\) => \{\s*if \(!isCurrent\(\)\) return;/,
    'the progress callback must reject a stale actor epoch before updating state',
  );
});
