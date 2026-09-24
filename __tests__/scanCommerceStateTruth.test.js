/**
 * Build 34 Lane A - Scanner commerce-state truth.
 *
 * HARD INVARIANT (owner brief)
 *   NO_MATCH_COPY_MAY_RENDER_ONLY_AFTER_COMPLETED_EMPTY_RESULT
 *
 * The scanner may state "No strong shopping match found." (or any equivalent
 * no-match copy) only AFTER commerce retrieval demonstrably completed with an
 * empty result, under EVERY backend flag combination, including the posture
 * that most needs it: multi-item detection on with the deferred-commerce funnel
 * off (its default), and the identity/retrieval layers off.
 *
 * In that posture the detection response carries
 *   commerce { provider:'none', commerceSkipped:true,
 *              reason:'multi_item_detection_only' }   (no `deferred`)
 * supabase/functions/scan-identify/index.ts:3704-3754. Nothing ever searches for
 * the detected items, the client never dispatches (hooks/useKScan.js gates on
 * commerce.deferred), and the per-item shelf used to derive "not eligible" from
 * "no card" and print the no-match sentence for a search that never ran.
 *
 * WHAT THESE TESTS ARE
 *   - NC-A..NC-E are negative controls: each one FAILS on the pre-repair source
 *     for the specific reason named in its title.
 *   - The flag-combination matrix drives literal backend response bodies (the
 *     shapes index.ts emits) through the REAL normalizeScanIdentifyResponse ->
 *     mapScanIdentifyToAnalysis -> hooks/useKScan.js -> services/multiItemCommerce
 *     -> services/commerceHydration -> MultiItemCommerceSection chain, with only
 *     the network transport (supabase.functions.invoke) stubbed. That is the
 *     coverage the existing suites lack: multiItemCommerceCriticalPath stubs the
 *     mapper with a literal that already carries commerceDeferred:true, and
 *     multiItemCommerceDetectionDispatch only ever feeds the funnel-ON body.
 *   - A source scan proves the no-match literals exist ONLY inside the
 *     COMPLETED_EMPTY entry of the copy table (services/commerceShelfState.ts).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.env.KSCAN_COMMERCE_SOURCE_ROOT
  ? path.resolve(process.env.KSCAN_COMMERCE_SOURCE_ROOT)
  : path.resolve(__dirname, '..');

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// ── TypeScript-aware production module loader ───────────────────────────────
function createLoader(root, mocks = {}) {
  const cache = new Map();
  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  }
  function transpile(source, fileName) {
    return ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
      fileName,
    }).outputText;
  }
  function run(output, resolved) {
    const module = { exports: {} };
    const localRequire = (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      if (id.startsWith('.')) return loadFile(path.resolve(path.dirname(resolved), id));
      try { return require(id); } catch { return {}; }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', output)(
      module.exports, localRequire, module, resolved, path.dirname(resolved),
    );
    return module;
  }
  function loadFile(filename) {
    const resolved = resolveFile(filename);
    if (!resolved) throw new Error(`Unable to resolve production module: ${filename}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const placeholder = { exports: {} };
    cache.set(resolved, placeholder);
    const module = run(transpile(fs.readFileSync(resolved, 'utf8'), resolved), resolved);
    placeholder.exports = module.exports;
    return module.exports;
  }
  const load = (relativePath) => loadFile(path.resolve(root, relativePath));
  /** Load a module from SOURCE TEXT, resolving its imports relative to `asFile`. */
  load.fromSource = (source, asFile) => {
    const resolved = path.resolve(root, asFile);
    return run(transpile(source, resolved), resolved).exports;
  };
  return load;
}

// ── Minimal React element recorder (no react-test-renderer in this repo) ────
function createReactRecorder() {
  return {
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c);
        else if (c !== null && c !== undefined && c !== false) flat.push(c);
      }
      return {
        __node: true,
        type: typeof type === 'function' ? (type.name || 'Component') : String(type),
        typeFn: typeof type === 'function' ? type : null,
        props: props || {},
        children: flat,
      };
    },
    Fragment: 'Fragment',
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
  };
}

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || !node.__node) return;
  visit(node);
  if (node.typeFn && depth < 6) {
    let expanded = null;
    try { expanded = node.typeFn({ ...node.props, children: node.children }); } catch { /* leaf */ }
    if (expanded) walk(expanded, visit, depth + 1);
  }
  for (const child of node.children) walk(child, visit, depth + 1);
}
function collect(tree) {
  const nodes = [];
  walk(tree, (n) => nodes.push(n));
  return nodes;
}

// ── Deterministic React hook runtime (positional slots, explicit renders) ───
function createHookRuntime() {
  const slots = [];
  let cursor = 0;
  let renderScheduled = false;
  let renderFn = null;
  const pendingEffects = [];
  const cleanups = new Map();
  let lastResult = null;

  const scheduleRender = () => {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => { renderScheduled = false; render(); });
  };
  function depsChanged(prev, next) {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    return prev.some((d, i) => !Object.is(d, next[i]));
  }
  function useState(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
    const slot = slots[i];
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      scheduleRender();
    };
    return [slot.value, set];
  }
  function useRef(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: initial };
    return slots[i];
  }
  function useCallback(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { fn: null, deps: null });
    if (depsChanged(slot.deps, deps)) { slot.fn = fn; slot.deps = deps; }
    return slot.fn;
  }
  function useMemo(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { value: undefined, deps: null });
    if (depsChanged(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; }
    return slot.value;
  }
  function useEffect(fn, deps) {
    const i = cursor++;
    const slot = slots[i] || (slots[i] = { deps: null });
    if (depsChanged(slot.deps, deps)) { slot.deps = deps; pendingEffects.push({ key: i, fn }); }
  }
  function render() {
    cursor = 0;
    lastResult = renderFn();
    const effects = pendingEffects.splice(0, pendingEffects.length);
    for (const effect of effects) {
      const prior = cleanups.get(effect.key);
      if (typeof prior === 'function') { try { prior(); } catch { /* ignore */ } }
      const cleanup = effect.fn();
      cleanups.set(effect.key, typeof cleanup === 'function' ? cleanup : null);
    }
    return lastResult;
  }
  return {
    React: { useState, useRef, useCallback, useMemo, useEffect },
    mount(fn) { renderFn = fn; return render(); },
    get current() { return lastResult; },
    async flush(rounds = 8) {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise((r) => setTimeout(r, 1));
        render();
      }
    },
  };
}

// ── No-match copy detection ─────────────────────────────────────────────────
//
// The family of statements that assert a search happened and found nothing.
// Besides the two live sentences it covers every near variant that existed on
// the pre-repair source: ProductShelf's default empty copy, the legacy Scan
// Result Object card's zero-count label ("No matches yet",
// components/scan/ScanResultCard.tsx) and the dead defensive fallback in
// services/scanResultObject.ts ("No similar items yet - saved as style
// metadata"). Those two legacy strings are catalog-match wording on a card that
// has no way to know whether a search completed, so they were neutralized rather
// than allow-listed: the invariant has no exceptions.
const NO_MATCH_PATTERNS = [
  /no strong shopping match/i,
  /no confident retailer match/i,
  /no similar items yet/i,
  /no matches yet/i,
  // Any other phrasing of the same claim ("No matches found", "No shopping matches",
  // "Nothing matched"): the invariant is about the claim, not four sentences.
  /\bno (?:\w+ ){0,2}match(?:es)?\b/i,
  /\bnothing (?:was )?(?:matched|found)\b/i,
];
const isNoMatchText = (s) => typeof s === 'string' && NO_MATCH_PATTERNS.some((re) => re.test(s));

const TEXT_PROPS = ['body', 'title', 'emptyTitle', 'emptyBody', 'accessibilityLabel', 'label'];
function noMatchNodes(tree) {
  return collect(tree).filter((n) => (
    TEXT_PROPS.some((k) => isNoMatchText(n.props[k]))
    || n.children.some((c) => isNoMatchText(c))
  ));
}
function allText(tree) {
  const out = [];
  for (const n of collect(tree)) {
    for (const k of TEXT_PROPS) if (typeof n.props[k] === 'string') out.push(n.props[k]);
    for (const c of n.children) if (typeof c === 'string') out.push(c);
  }
  return out.join(' | ');
}

// ── Literal backend bodies ──────────────────────────────────────────────────
const GARMENT_BLAZER = {
  candidateId: 'garment-1-outerwear-blazer', order: 0, label: 'black blazer',
  category: 'outerwear', subtype: 'blazer', confidenceScore: 0.82,
  bounds: { x: 0.12, y: 0.08, width: 0.7, height: 0.5 },
  attributes: { category: 'outerwear', itemType: 'blazer', colorPalette: ['black'] },
  identification: { item_type: 'outerwear', subtype: 'blazer', primary_color: 'black', confidence_score: 0.82 },
};
const GARMENT_BOOT = {
  candidateId: 'garment-2-footwear-boot', order: 1, label: 'brown chelsea boot',
  category: 'footwear', subtype: 'chelsea boot', confidenceScore: 0.71,
  bounds: { x: 0.3, y: 0.7, width: 0.3, height: 0.25 },
  attributes: { category: 'footwear', itemType: 'chelsea boot', colorPalette: ['brown'] },
  identification: { item_type: 'footwear', subtype: 'chelsea boot', primary_color: 'brown', confidence_score: 0.71 },
};
const GARMENT_TOTE = {
  candidateId: 'garment-3-bag-tote', order: 2, label: 'tan tote bag',
  category: 'bag', subtype: 'tote', confidenceScore: 0.66,
  attributes: { category: 'bag', itemType: 'tote', colorPalette: ['tan'] },
  identification: { item_type: 'bag', subtype: 'tote', primary_color: 'tan', confidence_score: 0.66 },
};
/** No identification block at all: structurally not eligible for a commerce query. */
const GARMENT_BARE = {
  candidateId: 'garment-4-accessory-scarf', order: 3, label: 'grey scarf',
  category: 'accessory', subtype: 'scarf',
  attributes: { category: 'accessory', itemType: 'scarf' },
};

const INLINE_OFFER = {
  id: 'serper-1', title: 'Black double-breasted blazer', source: 'Shop', retailer: 'Shop',
  price: '$120', type: 'retail', imageUrl: 'https://img.test/1.jpg', productUrl: 'https://shop.test/1',
};

/**
 * What index.ts:3740-3754 emits for a multi-item DETECTION response.
 * FUNNEL OFF (the default): commerce was SKIPPED, not deferred.
 */
const COMMERCE_DETECTION_FUNNEL_OFF = {
  provider: 'none', query: '', count: 0, providersTried: [], catalogCount: 0,
  similarityMatches: 0, commerceSkipped: true, reason: 'multi_item_detection_only',
};
const COMMERCE_DETECTION_FUNNEL_ON = {
  provider: 'deferred', query: '', count: 0, providersTried: [], catalogCount: 0,
  similarityMatches: 0, commerceSkipped: true, deferred: true, funnelVersion: 'v127',
  reason: 'deferred_to_commerce_only_request',
};
/** index.ts:3805-3843 (MODE A: single image / selected item with the funnel on). */
const COMMERCE_MODE_A_DEFERRED = {
  provider: 'deferred', query: '', count: 0, providersTried: [], catalogCount: 0,
  similarityMatches: 0, commerceSkipped: true, deferred: true, funnelVersion: 'v127',
  reason: 'deferred_to_commerce_only_request',
};
/** index.ts:3958-3965 (funnel off, inline retrieval finished with offers). */
const COMMERCE_INLINE = {
  provider: 'serper', providersTried: ['serper'], query: 'black blazer', count: 1,
  catalogCount: 0, similarityMatches: 0,
};

/** The response body a completed scan carries; `garments` empty => single item. */
function scanBody({ commerce, garments = [], recommendedProducts = [] }) {
  const primary = garments[0] || GARMENT_BLAZER;
  return {
    status: 'completed',
    attributes: { category: 'outerwear', itemType: 'blazer', colorPalette: ['black'], confidenceScore: 0.82 },
    identification: {
      visual_observation: 'Black structured blazer over a white shirt.',
      ...primary.identification,
      non_fashion: false,
    },
    recommendedProducts,
    similarityMatches: [],
    userMessage: 'Identified a fashion item from your scan.',
    scanId: 'scan-1',
    scanSessionId: 'scan_sess_1',
    imageDigestPrefix: 'abc123def456',
    commerce,
    ...(garments.length ? { detectedGarments: garments } : {}),
  };
}

/** MODE B bodies, literal from index.ts:2141-2147 and 2244-2260. */
const MODE_B = {
  completedEmpty: {
    status: 'completed', purchaseOptions: [], recommendedProducts: [], canonicalProducts: [],
    commerce: {
      available: false, retryable: true, provider: 'none', providersTried: ['serper', 'brave'],
      count: 0, errorType: 'no_results', enrichmentCandidates: [],
      enrichmentAttempted: 0, enrichmentSucceeded: 0,
    },
    funnel: { version: 'v127', cacheHit: false },
  },
  providerError: {
    status: 'completed', purchaseOptions: [], recommendedProducts: [],
    commerce: { available: false, retryable: true, errorType: 'provider_error' },
  },
  weakQuery: {
    status: 'completed', purchaseOptions: [], recommendedProducts: [],
    commerce: { available: false, retryable: true, provider: 'none', providersTried: [], count: 0, errorType: 'weak_query', enrichmentCandidates: [] },
  },
  success: (n = 2) => {
    const offers = Array.from({ length: n }, (_, i) => ({
      id: `o${i}`, title: `Offer ${i}`, productUrl: `https://shop.test/o${i}`, source: 'Shop',
      retailer: 'Shop', price: '$100', imageUrl: 'https://img.test/o.jpg',
    }));
    return {
      status: 'completed', purchaseOptions: offers, recommendedProducts: offers,
      commerce: { available: true, retryable: false, provider: 'serper', providersTried: ['serper'], count: n, enrichmentCandidates: [] },
      funnel: { version: 'v127', cacheHit: false },
    };
  },
  /**
   * normalized('failed', NO_IMAGE_PROVIDED_MESSAGE) - what a funnel-OFF backend
   * answers to a commerce_only body: the MODE B route does not exist
   * (index.ts:2008), the body falls through to the image path and is answered
   * HTTP 200 (index.ts:2407-2408). There is no `commerce` block.
   */
  funnelOffNoImage: {
    status: 'failed', identification: {}, attributes: {}, recommendedProducts: [], products: [],
    purchaseOptions: [], similarityMatches: [], shoppingMeta: {},
    userMessage: 'No image provided.',
  },
};

// ── The pipeline harness: real normalizer -> mapper -> hook -> services ─────
const HYDRATION_TRANSPORT_MOCKS = (invokes, respond) => ({
  './supabaseClient': {
    supabase: {
      functions: {
        invoke: async (fn, opts) => {
          invokes.push({ fn, body: opts && opts.body });
          return respond(opts && opts.body);
        },
      },
    },
  },
});

/** Resolve a per-candidate MODE B outcome table into a transport responder. */
function respondBy(perCandidate, fallback) {
  return async (body) => {
    const outcome = (body && body.candidateId && perCandidate[body.candidateId]) || fallback;
    if (typeof outcome === 'function') return outcome(body);
    return { data: outcome, error: null };
  };
}

async function runScenario({ body, respond, multiItemFetchOverride, rounds = 60, settleWhen }) {
  const runtime = createHookRuntime();
  const invokes = [];
  const transport = HYDRATION_TRANSPORT_MOCKS(
    invokes,
    respond || (async () => { throw new Error('unexpected MODE B invocation'); }),
  );
  const { normalizeScanIdentifyResponse } = createLoader(ROOT, transport)('services/scanIdentification.ts');

  const load = createLoader(ROOT, {
    ...transport,
    react: runtime.React,
    'react-native': {
      AccessibilityInfo: { announceForAccessibility: () => {}, isReduceMotionEnabled: async () => false },
    },
    'expo-crypto': {
      randomUUID: () => 'uuid-1',
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async () => 'deadbeefcafe0123',
    },
    'expo-image-picker': {},
    '../constants/featureFlags': { SCAN_IDENTIFY_BACKEND_ENABLED: true },
    '../services/scannerEvidenceGateway': {
      prepareScannerEvidence: ({ evidenceId }) => ({ evidenceId: evidenceId || 'evidence-1', imageBase64: 'x', source: 'camera' }),
      createEvidenceId: () => 'evidence-1',
    },
    '../services/scannerIdentificationV2': { beginScannerV2Session: () => ({ enabled: false }) },
    '../services/scannerScanRequest': {
      runScannerIdentification: async () => ({
        contractPath: 'legacy',
        response: normalizeScanIdentifyResponse(body),
        candidates: [],
        identificationV2: null,
        fallbackUsed: false,
      }),
    },
    '../services/secondhand': { buildSecondhandSearchRequest: () => null, searchVintedSecondhand: async () => null },
    '../services/sneakers/index': { searchSneakers: async () => null, shouldEnrichSneakers: () => false },
    '../services/imageUtils': { compressForUpload: async (u) => u },
    '../services/privacyImageSanitizer': {
      sanitizeImageBeforeUpload: async (u) => u,
      getPrivacySanitizerStatus: () => ({ faceBlurApplied: false, plateMaskApplied: false, mode: 'test', faceDetectionAvailable: false }),
    },
    '../services/haptics': new Proxy({}, { get: () => () => {} }),
    ...(multiItemFetchOverride ? { '../services/multiItemCommerce': { fetchMultiItemCommerce: multiItemFetchOverride } } : {}),
  });

  const { useKScan } = load('hooks/useKScan.js');
  const frames = [];
  runtime.mount(() => { const view = useKScan(); frames.push(view); return view; });

  runtime.current.uploadPhoto('memory://capture.jpg');
  await runtime.flush(3);
  assert.equal(runtime.current.status, 'preview', 'scenario reached preview');
  await runtime.current.runAnalysis();

  for (let i = 0; i < rounds; i += 1) {
    await runtime.flush(1);
    if (settleWhen && settleWhen(runtime.current)) break;
  }
  await runtime.flush(4);
  return { runtime, frames, invokes, view: runtime.current };
}

const settleReady = (view) => view.multiItemCommerceStatus === 'ready';

// ── Section rendering ───────────────────────────────────────────────────────
function loadSection() {
  const React = createReactRecorder();
  const load = createLoader(ROOT, {
    react: React,
    'react-native': { View: 'View', Text: 'Text', StyleSheet: { create: (s) => s } },
    './PurchaseOptionsPanel': { PurchaseOptionsPanel: 'PurchaseOptionsPanel' },
    '../luxury/InlineNotice': { InlineNotice: 'InlineNotice' },
    './types': { mapRawProductToPurchaseOption: (p, i) => ({ id: 'p' + i, title: p && p.title }) },
    '../../constants/theme': { LUXURY: { typography: { bodyStrong: {} } }, SPACING: { sm: 8, lg: 16, xl: 24 } },
  });
  return load('components/scan-results/MultiItemCommerceSection.tsx').MultiItemCommerceSection;
}
const Section = loadSection();

/** Render the section exactly as ScanResultV2 mounts it, from a hook view. */
function renderSectionFor(view, { findMatchesAvailable = true } = {}) {
  const analysis = view.analysis || {};
  return Section({
    candidates: analysis.confirmationCandidates || [],
    cardsByCandidateId: new Map((view.multiItemCommerce || []).map((c) => [c.candidateId, c])),
    status: view.multiItemCommerceStatus,
    deferred: Boolean(analysis.commerceDeferred),
    findMatchesAvailable,
    onRetry: () => {},
  });
}

/** candidateId -> Set of rendered kinds, read from the testIDs the section emits. */
function kindsByCandidate(tree, candidates) {
  const nodes = collect(tree);
  const prefixes = {
    'multi-item-commerce-no-match-': 'no-match',
    'multi-item-commerce-pending-': 'pending',
    'multi-item-commerce-error-': 'error',
    'multi-item-commerce-not-started-': 'not-started',
    'multi-item-commerce-best-match-': 'best-match',
  };
  const out = {};
  for (const c of candidates) {
    const kinds = new Set();
    for (const n of nodes) {
      const id = n.props.testID;
      if (typeof id !== 'string' || !id.endsWith(`-${c.id}`)) continue;
      for (const [prefix, kind] of Object.entries(prefixes)) if (id.startsWith(prefix)) kinds.add(kind);
    }
    out[c.id] = kinds;
  }
  return out;
}
const only = (set) => [...set].sort().join(',');

/**
 * THE INVARIANT, checked over every frame the user could have seen: while the
 * shelf has not finished (idle or pending) nothing may be a no-match; on the
 * final frame a candidate is a no-match if and only if its search completed
 * empty (`truth[id] === 'completed_empty'`).
 */
function assertInvariantOverFrames(scenario, truth, label) {
  const candidates = (scenario.view.analysis && scenario.view.analysis.confirmationCandidates) || [];

  // 1. The FINAL frame first, so a row that has its own defect (a vanished
  //    card, a failed body read as empty, an ineligible garment) fails on that
  //    defect rather than on the earlier first-frame gap that every deferred
  //    row also has on the pre-repair source.
  const tree = renderSectionFor(scenario.view);
  const kinds = kindsByCandidate(tree, candidates);
  for (const c of candidates) {
    const expectNoMatch = truth[c.id] === 'completed_empty';
    assert.equal(
      kinds[c.id].has('no-match'), expectNoMatch,
      `${label}: ${c.id} truth=${truth[c.id]} but rendered [${only(kinds[c.id])}]`,
    );
  }

  // 2. Then every earlier frame the user could have seen.
  for (const frame of scenario.frames) {
    if (frame.status !== 'result' || !frame.analysis) continue;
    if (frame.multiItemCommerceStatus === 'ready') continue;
    const frameTree = renderSectionFor(frame);
    const offenders = noMatchNodes(frameTree);
    assert.equal(
      offenders.length, 0,
      `${label}: a no-match statement rendered while commerce had not completed `
        + `(shelfStatus=${frame.multiItemCommerceStatus}, deferred=${Boolean(frame.analysis.commerceDeferred)}): `
        + allText(frameTree),
    );
  }
  return { tree, kinds };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A - live pipeline: flag-combination matrix
// ═══════════════════════════════════════════════════════════════════════════

test('NC-B MULTI-ITEM ON / FUNNEL OFF: the detection screen states NOT_STARTED, never a no-match, and dispatches nothing', async () => {
  const s = await runScenario({
    body: scanBody({ commerce: COMMERCE_DETECTION_FUNNEL_OFF, garments: [GARMENT_BLAZER, GARMENT_BOOT] }),
    rounds: 8,
  });

  // The facts the client actually derives from that body.
  assert.equal(s.view.status, 'result');
  assert.equal(s.view.analysis.confirmationCandidates.length, 2);
  assert.equal(Boolean(s.view.analysis.commerceDeferred), false,
    'a skipped (not deferred) detection is not a deferral');
  assert.equal(s.invokes.length, 0, 'no MODE B request may be dispatched: the route does not exist with the funnel off');
  assert.equal(s.view.multiItemCommerceStatus, 'idle');
  assert.deepEqual(s.view.multiItemCommerce, []);

  // The invariant: nothing ever searched, so nothing may say "no match".
  const { tree, kinds } = assertInvariantOverFrames(s, {
    [GARMENT_BLAZER.candidateId]: 'never_ran',
    [GARMENT_BOOT.candidateId]: 'never_ran',
  }, 'funnel OFF');

  // ...and the shelf is not silent: it states NOT_STARTED and names the real next step.
  for (const g of [GARMENT_BLAZER, GARMENT_BOOT]) {
    assert.equal(only(kinds[g.candidateId]), 'not-started', `${g.candidateId} must state NOT_STARTED`);
  }
  const text = allText(tree);
  assert.match(text, /Find Matches/, 'the NOT_STARTED copy points at the real affordance (Find Matches)');
  assert.doesNotMatch(text, /no match|no strong|nothing found/i);
});

test('NC-A RENDER: idle shelf + no card + not deferred renders zero no-match statements (pre-repair: one per detected item)', () => {
  const candidates = [GARMENT_BLAZER, GARMENT_BOOT, GARMENT_TOTE].map((g, i) => ({
    id: g.candidateId, order: i, label: g.label, category: g.category, subtype: g.subtype, isPrimary: i === 0,
    source: g,
  }));
  for (const status of ['idle']) {
    const tree = Section({ candidates, cardsByCandidateId: new Map(), status, deferred: false, findMatchesAvailable: true });
    const offenders = noMatchNodes(tree);
    assert.equal(offenders.length, 0,
      `shelfStatus=${status}: ${offenders.length} no-match node(s) rendered for a search that never ran: ${allText(tree)}`);
    const kinds = kindsByCandidate(tree, candidates);
    for (const c of candidates) assert.equal(only(kinds[c.id]), 'not-started');
  }
});

test('NC-A RENDER: a completed shelf with no card for an ELIGIBLE candidate is an ERROR, never a no-match; an INELIGIBLE one is NOT_STARTED', () => {
  const candidates = [
    { id: GARMENT_BLAZER.candidateId, order: 0, label: 'black blazer', category: 'outerwear', subtype: 'blazer', isPrimary: true, source: GARMENT_BLAZER },
    { id: GARMENT_BARE.candidateId, order: 1, label: 'grey scarf', category: 'accessory', subtype: 'scarf', isPrimary: false, source: GARMENT_BARE },
  ];
  const tree = Section({
    candidates, cardsByCandidateId: new Map(), status: 'ready', deferred: true, findMatchesAvailable: true, onRetry: () => {},
  });
  assert.equal(noMatchNodes(tree).length, 0, allText(tree));
  const kinds = kindsByCandidate(tree, candidates);
  assert.equal(only(kinds[GARMENT_BLAZER.candidateId]), 'error',
    'an eligible candidate that finished without a card failed; it did not "have no match"');
  assert.equal(only(kinds[GARMENT_BARE.candidateId]), 'not-started',
    'a candidate with no identification can never be searched; it is NOT_STARTED');
});

test('MATRIX multi-item ON, funnel ON: DEFERRED then IN_PROGRESS, and no-match only where the search COMPLETED EMPTY (positive control)', async () => {
  const s = await runScenario({
    body: scanBody({ commerce: COMMERCE_DETECTION_FUNNEL_ON, garments: [GARMENT_BLAZER, GARMENT_BOOT] }),
    respond: respondBy({}, MODE_B.completedEmpty),
    settleWhen: settleReady,
  });
  assert.equal(s.view.multiItemCommerceStatus, 'ready');
  assert.equal(Boolean(s.view.analysis.commerceDeferred), true);
  assert.equal(s.invokes.filter((i) => i.body && i.body.candidateId).length, 2, 'one MODE B request per detected item');

  // First committed 'result' frame: deferred, hydration effect not yet run.
  const first = s.frames.find((f) => f.status === 'result');
  assert.equal(first.multiItemCommerceStatus, 'idle', 'fixture reproduces the first committed frame');
  assert.equal(noMatchNodes(renderSectionFor(first)).length, 0,
    'the first committed frame after a deferral must be DEFERRED (spinner), not a no-match');

  assertInvariantOverFrames(s, {
    [GARMENT_BLAZER.candidateId]: 'completed_empty',
    [GARMENT_BOOT.candidateId]: 'completed_empty',
  }, 'funnel ON, completed empty');

  // The repair does not hide commerce messaging: the genuine statement still renders.
  const tree = renderSectionFor(s.view);
  assert.match(allText(tree), /No strong shopping match found\./);
});

test('MATRIX multi-item ON, funnel ON: DEFERRED/IN_PROGRESS frames render the existing spinner copy', async () => {
  const s = await runScenario({
    body: scanBody({ commerce: COMMERCE_DETECTION_FUNNEL_ON, garments: [GARMENT_BLAZER, GARMENT_BOOT] }),
    respond: respondBy({}, MODE_B.completedEmpty),
    settleWhen: settleReady,
  });
  const inFlight = s.frames.filter((f) => f.status === 'result' && f.multiItemCommerceStatus !== 'ready');
  assert.ok(inFlight.length >= 2, 'both the deferred (idle) and pending frames were observed');
  for (const frame of inFlight) {
    const tree = renderSectionFor(frame);
    const kinds = kindsByCandidate(tree, frame.analysis.confirmationCandidates);
    for (const c of frame.analysis.confirmationCandidates) {
      assert.equal(only(kinds[c.id]), 'pending', `${frame.multiItemCommerceStatus}: ${c.id}`);
    }
    assert.match(allText(tree), /Finding where to buy/);
  }
});

test('MATRIX multi-item ON, funnel ON: provider_error, weak_query and transport failures are ERROR (retryable), never a no-match', async () => {
  const cases = [
    ['provider_error 200', { data: MODE_B.providerError, error: null }],
    ['weak_query 200 (no search ran)', { data: MODE_B.weakQuery, error: null }],
    ['transport error', { data: null, error: { message: 'boom' } }],
  ];
  for (const [name, outcome] of cases) {
    const s = await runScenario({
      body: scanBody({ commerce: COMMERCE_DETECTION_FUNNEL_ON, garments: [GARMENT_BLAZER, GARMENT_BOOT] }),
      respond: async () => outcome,
      settleWhen: settleReady,
    });
    const { tree, kinds } = assertInvariantOverFrames(s, {
      [GARMENT_BLAZER.candidateId]: 'failed', [GARMENT_BOOT.candidateId]: 'failed',
    }, name);
    for (const g of [GARMENT_BLAZER, GARMENT_BOOT]) assert.equal(only(kinds[g.candidateId]), 'error', `${name}: ${g.candidateId}`);
    assert.match(allText(tree), /Couldn't load purchase options/);
  }
});

test('MATRIX multi-item ON, funnel ON: a thrown transport is ERROR for that item, not a vanished card', async () => {
  const s = await runScenario({
    body: scanBody({ commerce: COMMERCE_DETECTION_FUNNEL_ON, garments: [GARMENT_BLAZER, GARMENT_BOOT] }),
    respond: async () => { throw new Error('socket hang up'); },
    settleWhen: settleReady,
  });
  const { kinds } = assertInvariantOverFrames(s, {
    [GARMENT_BLAZER.candidateId]: 'failed', [GARMENT_BOOT.candidateId]: 'failed',
  }, 'thrown transport');
  for (const g of [GARMENT_BLAZER, GARMENT_BOOT]) assert.equal(only(kinds[g.candidateId]), 'error');
});

test('NC-B (thrown fetch): when the whole multi-item fetch throws, every eligible item is ERROR - the hook still reports ready with zero cards', async () => {
  const s = await runScenario({
    body: scanBody({ commerce: COMMERCE_DETECTION_FUNNEL_ON, garments: [GARMENT_BLAZER, GARMENT_BOOT] }),
    respond: async () => ({ data: MODE_B.completedEmpty, error: null }),
    multiItemFetchOverride: async () => { throw new Error('injected orchestrator failure'); },
    settleWhen: settleReady,
  });
  assert.equal(s.view.multiItemCommerceStatus, 'ready', 'hook reports ready even though nothing was fetched');
  assert.deepEqual(s.view.multiItemCommerce, [], 'zero cards: the collapse this test guards');
  const { kinds } = assertInvariantOverFrames(s, {
    [GARMENT_BLAZER.candidateId]: 'failed', [GARMENT_BOOT.candidateId]: 'failed',
  }, 'orchestrator threw');
  for (const g of [GARMENT_BLAZER, GARMENT_BOOT]) assert.equal(only(kinds[g.candidateId]), 'error');
});

test('MATRIX multi-item ON, funnel ON: mixed outcomes stay bound to their own garment', async () => {
  const s = await runScenario({
    body: scanBody({ commerce: COMMERCE_DETECTION_FUNNEL_ON, garments: [GARMENT_BLAZER, GARMENT_BOOT, GARMENT_TOTE, GARMENT_BARE] }),
    respond: respondBy({
      [GARMENT_BLAZER.candidateId]: MODE_B.success(2),
      [GARMENT_BOOT.candidateId]: MODE_B.completedEmpty,
      [GARMENT_TOTE.candidateId]: MODE_B.providerError,
    }, MODE_B.completedEmpty),
    settleWhen: settleReady,
  });
  const { kinds } = assertInvariantOverFrames(s, {
    [GARMENT_BLAZER.candidateId]: 'results',
    [GARMENT_BOOT.candidateId]: 'completed_empty',
    [GARMENT_TOTE.candidateId]: 'failed',
    [GARMENT_BARE.candidateId]: 'never_ran',
  }, 'mixed');
  assert.equal(only(kinds[GARMENT_BLAZER.candidateId]), 'best-match');
  assert.equal(only(kinds[GARMENT_BOOT.candidateId]), 'no-match');
  assert.equal(only(kinds[GARMENT_TOTE.candidateId]), 'error');
  assert.equal(only(kinds[GARMENT_BARE.candidateId]), 'not-started');
  assert.equal(s.invokes.filter((i) => i.body && i.body.candidateId === GARMENT_BARE.candidateId).length, 0,
    'the ineligible garment is never sent to the backend');
});

test('NC-C HAZARD: MODE B answered by a funnel-OFF backend (HTTP 200 "no image provided") is ERROR, never a no-match', async () => {
  // The client only dispatches on commerce.deferred, but a backend rollback
  // between the detection response and the follow-up (or any future ungated
  // dispatch) must not be able to turn that body into a statement about the garment.
  const s = await runScenario({
    body: scanBody({ commerce: COMMERCE_DETECTION_FUNNEL_ON, garments: [GARMENT_BLAZER, GARMENT_BOOT] }),
    respond: async () => ({ data: MODE_B.funnelOffNoImage, error: null }),
    settleWhen: settleReady,
  });
  const { kinds } = assertInvariantOverFrames(s, {
    [GARMENT_BLAZER.candidateId]: 'failed', [GARMENT_BOOT.candidateId]: 'failed',
  }, 'funnel-off body');
  for (const g of [GARMENT_BLAZER, GARMENT_BOOT]) assert.equal(only(kinds[g.candidateId]), 'error');
});

test('MATRIX multi-item OFF, funnel OFF (inline retrieval): no candidates => no shelf; offers arrive inline; an empty inline result claims nothing', async () => {
  const withOffer = await runScenario({
    body: scanBody({ commerce: COMMERCE_INLINE, recommendedProducts: [INLINE_OFFER] }),
    rounds: 6,
  });
  assert.equal(withOffer.view.analysis.confirmationCandidates, undefined, 'no detection => no multi-item shelf');
  assert.equal(renderSectionFor(withOffer.view), null);
  assert.equal(withOffer.view.analysis.purchaseOptions.length, 1, 'inline offers ride the scan response');
  assert.equal(withOffer.invokes.length, 0);

  const emptyInline = await runScenario({
    body: scanBody({ commerce: { ...COMMERCE_INLINE, provider: 'none', providersTried: [], count: 0 }, recommendedProducts: [] }),
    rounds: 6,
  });
  assert.equal(emptyInline.invokes.length, 0);
  assert.equal(emptyInline.view.analysis.purchaseOptions.length, 0);
});

test('MATRIX multi-item OFF, funnel ON (MODE A single item): the single-item state follows the search - error for a provider failure, empty only for a completed empty search', async () => {
  const run = (outcome) => runScenario({
    body: scanBody({ commerce: COMMERCE_MODE_A_DEFERRED }),
    respond: async () => outcome,
    settleWhen: (v) => v.commerceStatus !== 'idle' && v.commerceStatus !== 'pending',
  });

  const completedEmpty = await run({ data: MODE_B.completedEmpty, error: null });
  assert.equal(completedEmpty.view.commerceStatus, 'empty', 'a completed empty search is the only "empty"');

  const providerError = await run({ data: MODE_B.providerError, error: null });
  assert.equal(providerError.view.commerceStatus, 'error',
    'a provider failure answered HTTP 200 must not collapse into "empty" (useKScan stores result.status verbatim)');

  const funnelOffBody = await run({ data: MODE_B.funnelOffNoImage, error: null });
  assert.equal(funnelOffBody.view.commerceStatus, 'error');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART B - reopen (saved scan)
// ═══════════════════════════════════════════════════════════════════════════

function createMemoryStorage() {
  const files = new Map();
  const fileSystem = {
    documentDirectory: 'memory://documents/',
    EncodingType: { UTF8: 'utf8' },
    getInfoAsync: async (uri) => ({ exists: files.has(uri), uri }),
    readAsStringAsync: async (uri) => {
      if (!files.has(uri)) throw new Error(`Missing memory file: ${uri}`);
      return files.get(uri);
    },
    writeAsStringAsync: async (uri, value) => { files.set(uri, value); },
    makeDirectoryAsync: async () => undefined,
    moveAsync: async ({ from, to }) => {
      if (!files.has(from)) throw new Error(`Missing memory file: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    deleteAsync: async (uri) => { files.delete(uri); },
  };
  return { fileSystem, imageManipulator: { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({ uri: 'memory://cache/thumb.jpg' }) } };
}
function loadLibrary(storage) {
  return createLoader(ROOT, {
    'expo-file-system/legacy': storage.fileSystem,
    'expo-image-manipulator': storage.imageManipulator,
    './savedScansCloud': {
      saveScanToCloud: async () => ({ ok: false, reason: 'disabled' }),
      softDeleteCloudSavedScan: async () => ({ ok: false, reason: 'disabled' }),
    },
    './actorContext': { resolveWriteAuthority: () => ({ ok: true, ownerId: null }), isActorRequestCurrent: () => true },
  })('services/library.js');
}

/** The real AnalysisCard, rendered as a plain function with inert React Native. */
function loadAnalysisCard() {
  const React = createReactRecorder();
  class AnimatedValue { constructor(v) { this.v = v; } setValue(v) { this.v = v; } }
  const anim = () => ({ start: (cb) => { if (typeof cb === 'function') cb(); } });
  const load = createLoader(ROOT, {
    react: React,
    'react-native': {
      View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', Modal: 'Modal', ScrollView: 'ScrollView',
      StyleSheet: { create: (s) => s, absoluteFillObject: {}, hairlineWidth: 1, flatten: (s) => s },
      Animated: { Value: AnimatedValue, View: 'Animated.View', timing: anim, parallel: anim, stagger: anim },
      PanResponder: { create: () => ({ panHandlers: {} }) },
      Easing: { bezier: () => () => 0 },
      Platform: { OS: 'ios', select: (o) => (o && (o.ios !== undefined ? o.ios : o.default)) },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    './MetadataChip': { MetadataChip: 'MetadataChip' },
    './ProductShelf': { ProductShelf: 'ProductShelf' },
    './scan/ScanResultCard': { ScanResultCard: 'ScanResultCard' },
    './SecondhandShelf': { SecondhandShelf: 'SecondhandShelf' },
    './SneakerMatchCard': { SneakerMatchCard: 'SneakerMatchCard' },
    '../hooks/useFeatureFreeze': { useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }) },
    '../hooks/useResponsiveLayout': { useResponsiveLayout: () => ({ height: 844, modalMaxWidth: 640 }) },
    '../contexts/AiOutputReportingContext': { useAiOutputReporting: () => ({ openAiOutputReport: () => {} }) },
    './free-tier/SavedItemUtilityPanel': { SavedItemUtilityPanel: 'SavedItemUtilityPanel' },
    '../services/free-tier/itemNormalization': { normalizeItem: (x) => x, normalizeItems: (x) => x },
  });
  return load('components/AnalysisCard.tsx').AnalysisCard;
}
const AnalysisCard = loadAnalysisCard();

/** The user-visible empty copy of a ProductShelf node: its prop, else the shelf's own default. */
function productShelfDefault(prop) {
  const source = fs.readFileSync(path.join(ROOT, 'components/ProductShelf.tsx'), 'utf8');
  const match = source.match(new RegExp(`${prop}\\s*=\\s*'([^']*)'`));
  return match ? match[1] : undefined;
}
const effectiveEmpty = (node, prop) => (typeof node.props[prop] === 'string' ? node.props[prop] : productShelfDefault(prop));

/** Mirrors app/library.tsx:1107-1118 exactly for the props under test. */
function renderReopened(scan, extra = {}) {
  return AnalysisCard({
    result: scan.result,
    metadata: {
      category: scan.attributes.category, color: scan.attributes.color_palette,
      silhouette: scan.attributes.silhouette, pattern: scan.attributes.pattern ?? null,
    },
    products: scan.products,
    purchaseOptions: scan.purchaseOptions ?? [],
    multiItemCandidates: scan.multiItemCandidates ?? [],
    multiItemCommerce: scan.multiItemCommerce ?? [],
    scanImageUri: scan.imageUri ?? null,
    scanSourceId: scan.id,
    scanSourceType: 'style_library_scan',
    relatedSavedScans: [],
    onDismiss: () => {},
    ...extra,
  });
}
const shelves = (tree) => collect(tree).filter((n) => n.type === 'ProductShelf');

const SAVED_CANDIDATES = [
  { id: 'jacket', label: 'Biker Jacket', category: 'outerwear', subtype: 'jacket' },
  { id: 'boots', label: 'Chelsea Boot', category: 'footwear', subtype: 'boot' },
];

test('NC-D REOPEN (funnel off): a scan saved with no commerce reopens as NOT_STARTED, never a no-match', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);
  const saved = await library.saveMultiItemScan({
    photoUri: 'memory://capture.jpg', analysis: { result: 'two items', metadata: {} },
    candidates: SAVED_CANDIDATES, source: 'camera',
  });
  assert.ok(saved, 'multi-item scan saved (stored shapes are unchanged: cards are [])');
  const [reopened] = await loadLibrary(storage).loadLibrary();
  assert.deepEqual(reopened.multiItemCommerce, [], 'commerce never ran, so no card exists');

  const tree = renderReopened(reopened);
  const perItem = shelves(tree).filter((n) => /^multi-item-commerce-/.test(n.props.testID || ''));
  assert.equal(perItem.length, SAVED_CANDIDATES.length);
  for (const node of perItem) {
    const title = effectiveEmpty(node, 'emptyTitle');
    const body = effectiveEmpty(node, 'emptyBody');
    assert.ok(!isNoMatchText(title) && !isNoMatchText(body),
      `reopened item ${node.props.testID} claims a no-match for commerce that never ran: "${title}" / "${body}"`);
    assert.match(node.props.testID, /^multi-item-commerce-not-started-/, 'state is NOT_STARTED');
  }
  assert.equal(noMatchNodes(tree).length, 0, allText(tree));
});

test('REOPEN: stored cards keep their own meaning - only a persisted no_match states the no-match (positive control)', async () => {
  const storage = createMemoryStorage();
  const library = loadLibrary(storage);
  const saved = await library.saveMultiItemScan({
    photoUri: 'memory://capture.jpg', analysis: { result: 'two items', metadata: {} },
    candidates: SAVED_CANDIDATES, source: 'camera',
  });
  assert.equal(await library.attachScanMultiItemCommerce(saved.id, [
    { candidateId: 'jacket', status: 'no_match', bestMatch: null, alternatives: [] },
    { candidateId: 'boots', status: 'error', bestMatch: null, alternatives: [] },
  ]), true);
  const [reopened] = await loadLibrary(storage).loadLibrary();
  const byId = Object.fromEntries(
    shelves(renderReopened(reopened)).map((n) => [n.props.testID, n]),
  );
  const noMatch = byId['multi-item-commerce-no-match-jacket'];
  assert.ok(noMatch, 'a persisted no_match card still renders the no-match statement');
  assert.match(effectiveEmpty(noMatch, 'emptyTitle'), /No strong shopping match found\./);
  assert.ok(byId['multi-item-commerce-error-boots'], 'a persisted error card renders the error treatment');
  assert.ok(!isNoMatchText(effectiveEmpty(byId['multi-item-commerce-error-boots'], 'emptyTitle')));
});

test('REOPEN: the WHERE TO BUY shelf never claims a no-match without a completed-empty status (a reopened scan passes none)', () => {
  const scan = {
    id: 's1', result: 'r', attributes: { category: 'outerwear', color_palette: 'black', silhouette: 'boxy' },
    products: [], purchaseOptions: [], multiItemCandidates: [], multiItemCommerce: [],
  };
  const idle = shelves(renderReopened(scan)).find((n) => n.props.testID === 'purchase-options-shelf');
  assert.ok(idle, 'the shelf mounts for a scan with no persisted offers');
  const idleTitle = effectiveEmpty(idle, 'emptyTitle');
  const idleBody = effectiveEmpty(idle, 'emptyBody');
  assert.ok(typeof idleTitle === 'string' && idleTitle.length > 0, 'explicit neutral copy, not an inherited default');
  assert.ok(!isNoMatchText(idleTitle) && !isNoMatchText(idleBody),
    `idle shelf claims a no-match: "${idleTitle}" / "${idleBody}"`);

  const completed = shelves(renderReopened(scan, { commerceStatus: 'empty' }))
    .find((n) => n.props.testID === 'purchase-options-shelf');
  assert.ok(isNoMatchText(effectiveEmpty(completed, 'emptyTitle')),
    'a completed-empty status (commerceStatus "empty") still states the no-match');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART C - producers
// ═══════════════════════════════════════════════════════════════════════════

function candidateFixture(g) {
  return {
    id: g.candidateId, order: g.order, label: g.label, category: g.category, subtype: g.subtype,
    isPrimary: g.order === 0, source: g,
  };
}
function loadOrchestrator(fetchImpl) {
  return createLoader(ROOT, { './commerceHydration': { fetchDeferredCommerce: fetchImpl } })('services/multiItemCommerce.ts');
}
function loadHydration(invokes, respond) {
  return createLoader(ROOT, HYDRATION_TRANSPORT_MOCKS(invokes, respond))('services/commerceHydration.ts');
}
const emptyResult = (extra = {}) => ({
  status: 'empty', purchaseOptions: [], enrichmentCandidates: [], cacheHit: false, retryable: true, ...extra,
});

test('PRODUCER toCardStatus: no_match only for an empty result that demonstrably completed (errorType no_results)', async () => {
  const table = [
    [emptyResult({ errorType: 'no_results' }), 'no_match'],
    [emptyResult(), 'error'],                                   // UNKNOWN never collapses into no_match
    [emptyResult({ errorType: 'provider_error' }), 'error'],
    [emptyResult({ errorType: 'weak_query' }), 'error'],
    [emptyResult({ errorType: 'no_key' }), 'error'],
    [emptyResult({ errorType: 'timeout' }), 'error'],
    [{ status: 'error', purchaseOptions: [], enrichmentCandidates: [], cacheHit: false, retryable: true }, 'error'],
    [{ status: 'success', purchaseOptions: [{ id: 'a', title: 'A' }], enrichmentCandidates: [], cacheHit: false, retryable: false }, 'ready'],
  ];
  for (const [result, expected] of table) {
    const { fetchMultiItemCommerce } = loadOrchestrator(async () => result);
    const cards = await fetchMultiItemCommerce([candidateFixture(GARMENT_BLAZER)]);
    assert.equal(cards.get(GARMENT_BLAZER.candidateId).status, expected,
      `result ${JSON.stringify({ status: result.status, errorType: result.errorType })}`);
  }
});

test('NC-C PRODUCER: the funnel-OFF "no image provided" HTTP-200 body never becomes no_match (real fetchDeferredCommerce + orchestrator)', async () => {
  const invokes = [];
  const hydration = loadHydration(invokes, async () => ({ data: MODE_B.funnelOffNoImage, error: null }));
  const { fetchMultiItemCommerce } = createLoader(ROOT, { './commerceHydration': hydration })('services/multiItemCommerce.ts');
  const cards = await fetchMultiItemCommerce([candidateFixture(GARMENT_BLAZER)]);
  assert.equal(invokes.length, 1);
  assert.notEqual(cards.get(GARMENT_BLAZER.candidateId).status, 'no_match',
    'a body that says status:"failed" is not evidence that a search completed');
  assert.equal(cards.get(GARMENT_BLAZER.candidateId).status, 'error');
});

test('PRODUCER: a rejected per-candidate entry surfaces as an ERROR card bound to its garment (it no longer vanishes)', async () => {
  const { fetchMultiItemCommerce } = loadOrchestrator(async (evidence) => {
    if (evidence.candidateId === GARMENT_BOOT.candidateId) throw new Error('simulated network failure');
    return { status: 'success', purchaseOptions: [{ id: 'a', title: 'A', retailer: 'R' }], enrichmentCandidates: [], cacheHit: false, retryable: false };
  });
  const cards = await fetchMultiItemCommerce([
    candidateFixture(GARMENT_BLAZER), candidateFixture(GARMENT_BOOT), candidateFixture(GARMENT_BARE),
  ]);
  assert.equal(cards.get(GARMENT_BLAZER.candidateId).status, 'ready', 'a sibling is unaffected');
  const boot = cards.get(GARMENT_BOOT.candidateId);
  assert.ok(boot, 'the failed item has a card');
  assert.equal(boot.status, 'error');
  assert.equal(boot.retryable, true);
  assert.equal(boot.bestMatch, null);
  assert.deepEqual(boot.alternatives, []);
  assert.equal(cards.has(GARMENT_BARE.candidateId), false, 'an ineligible garment is still never dispatched');
});

test('PRODUCER fetchDeferredCommerce: "empty" is returned only for a completed-empty search; every other non-success is an error', async () => {
  const cases = [
    ['completed, errorType no_results', MODE_B.completedEmpty, 'empty'],
    ['completed, provider_error', MODE_B.providerError, 'error'],
    ['completed, weak_query', MODE_B.weakQuery, 'error'],
    ['funnel-off failed body', MODE_B.funnelOffNoImage, 'error'],
    ['completed, empty, no errorType (cause not reported)', { status: 'completed', purchaseOptions: [], commerce: { available: false, retryable: true } }, 'error'],
    ['completed with offers', MODE_B.success(1), 'success'],
  ];
  for (const [name, body, expected] of cases) {
    const hydration = loadHydration([], async () => ({ data: body, error: null }));
    const result = await hydration.fetchDeferredCommerce({ identification: { item_type: 'outerwear' } });
    assert.equal(result.status, expected, name);
    if (expected === 'error') assert.equal(result.retryable, true, `${name}: a failed search is retryable`);
    assert.equal(result.purchaseOptions.length, expected === 'success' ? 1 : 0);
  }
});

test('PRODUCER: normalizeCommerceHydrationResponse stays a faithful wire read (status from offers, errorType carried)', () => {
  const hydration = loadHydration([], async () => ({ data: null, error: null }));
  const provider = hydration.normalizeCommerceHydrationResponse(MODE_B.providerError);
  assert.equal(provider.status, 'empty', 'unchanged: the wire read does not judge');
  assert.equal(provider.errorType, 'provider_error');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART D - the pure resolver
// ═══════════════════════════════════════════════════════════════════════════

const STATES = ['NOT_STARTED', 'DEFERRED', 'IN_PROGRESS', 'RESULTS', 'COMPLETED_EMPTY', 'ERROR'];
const STATE_MODULE = 'services/commerceShelfState.ts';
const loadState = () => createLoader(ROOT)(STATE_MODULE);

const CARDS = {
  none: undefined,
  nullCard: null,
  ready: { status: 'ready', bestMatch: { id: 'a', title: 'A' } },
  readyNoOffer: { status: 'ready', bestMatch: null },
  no_match: { status: 'no_match', bestMatch: null },
  error: { status: 'error', bestMatch: null },
  unknownStatus: { status: 'weird', bestMatch: null },
  noStatus: { bestMatch: null },
};

/** Every input combination; returns the invariant violations for a resolver. */
function resolverViolations(resolveItemCommerceState) {
  const violations = [];
  for (const deferred of [false, true]) {
    for (const shelfStatus of ['idle', 'pending', 'ready', 'weird', undefined]) {
      for (const eligible of [false, true]) {
        for (const [cardName, card] of Object.entries(CARDS)) {
          const state = resolveItemCommerceState({ deferred, shelfStatus, eligible, card });
          const where = `deferred=${deferred} shelf=${shelfStatus} eligible=${eligible} card=${cardName}`;
          if (!STATES.includes(state)) violations.push(`${where}: not a state (${state})`);
          const provenEmpty = Boolean(card) && card.status === 'no_match';
          if ((state === 'COMPLETED_EMPTY') !== provenEmpty) {
            violations.push(`${where}: state=${state} but a persisted completed-empty card is ${provenEmpty}`);
          }
        }
      }
    }
  }
  return violations;
}

test('NC-E RESOLVER MATRIX: COMPLETED_EMPTY if and only if the item carries a no_match card, over every input combination', () => {
  const { resolveItemCommerceState } = loadState();
  assert.deepEqual(resolverViolations(resolveItemCommerceState), []);
});

test('RESOLVER: the six states for each situation the scanner can be in', () => {
  const { resolveItemCommerceState } = loadState();
  const r = (o) => resolveItemCommerceState({ deferred: false, shelfStatus: 'idle', eligible: true, card: undefined, ...o });
  // No card.
  assert.equal(r({}), 'NOT_STARTED', 'funnel-off detection: nothing searched, nothing dispatched');
  assert.equal(r({ deferred: true }), 'DEFERRED', 'announced, dispatch effect not run yet');
  assert.equal(r({ shelfStatus: 'pending' }), 'IN_PROGRESS');
  assert.equal(r({ shelfStatus: 'pending', deferred: true }), 'IN_PROGRESS');
  assert.equal(r({ shelfStatus: 'ready', eligible: true }), 'ERROR', 'searched for, finished, no answer: a failure');
  assert.equal(r({ shelfStatus: 'ready', eligible: false }), 'NOT_STARTED', 'cannot be searched');
  // Cards.
  assert.equal(r({ card: CARDS.ready, shelfStatus: 'ready', deferred: true }), 'RESULTS');
  assert.equal(r({ card: CARDS.no_match, shelfStatus: 'ready', deferred: true }), 'COMPLETED_EMPTY');
  assert.equal(r({ card: CARDS.error, shelfStatus: 'ready', deferred: true }), 'ERROR');
  assert.equal(r({ card: CARDS.readyNoOffer, shelfStatus: 'ready', deferred: true }), 'ERROR',
    'a "ready" card with no offer is malformed, not a no-match');
  assert.equal(r({ card: CARDS.unknownStatus, shelfStatus: 'ready' }), 'ERROR');
  // Unknown lifecycle values are never a no-match.
  assert.notEqual(r({ shelfStatus: 'weird' }), 'COMPLETED_EMPTY');
});

test('RESOLVER (stored/reopen): an absent card is NOT_STARTED, never COMPLETED_EMPTY', () => {
  const { resolveStoredItemCommerceState } = loadState();
  assert.equal(resolveStoredItemCommerceState(undefined), 'NOT_STARTED');
  assert.equal(resolveStoredItemCommerceState(null), 'NOT_STARTED');
  assert.equal(resolveStoredItemCommerceState(CARDS.ready), 'RESULTS');
  assert.equal(resolveStoredItemCommerceState(CARDS.no_match), 'COMPLETED_EMPTY');
  assert.equal(resolveStoredItemCommerceState(CARDS.error), 'ERROR');
  assert.equal(resolveStoredItemCommerceState(CARDS.readyNoOffer), 'NOT_STARTED');
  assert.equal(resolveStoredItemCommerceState(CARDS.unknownStatus), 'NOT_STARTED');
  for (const card of Object.values(CARDS)) {
    assert.equal(resolveStoredItemCommerceState(card) === 'COMPLETED_EMPTY', Boolean(card) && card.status === 'no_match');
  }
});

test('RESOLVER (single-item shelf): options win; only an explicit "empty" status is COMPLETED_EMPTY; idle is NOT_STARTED', () => {
  const { resolveShelfCommerceState } = loadState();
  const s = (optionsCount, commerceStatus) => resolveShelfCommerceState({ optionsCount, commerceStatus });
  assert.equal(s(2, 'error'), 'RESULTS', 'data in hand always wins');
  assert.equal(s(0, 'pending'), 'IN_PROGRESS');
  assert.equal(s(0, 'error'), 'ERROR');
  assert.equal(s(0, 'empty'), 'COMPLETED_EMPTY');
  for (const status of ['idle', 'success', 'weird', undefined]) {
    assert.equal(s(0, status), 'NOT_STARTED', `status ${status}`);
  }
});

test('NC-E MUTATION CONTROL: making the not-deferred idle branch return COMPLETED_EMPTY is caught by the matrix (it has teeth)', () => {
  const source = fs.readFileSync(path.join(ROOT, STATE_MODULE), 'utf8');
  const anchor = "return input.deferred ? 'DEFERRED' : 'NOT_STARTED';";
  assert.ok(source.includes(anchor), 'mutation anchor missing: update it if the resolver was refactored');
  const mutated = source.replace(anchor, "return input.deferred ? 'DEFERRED' : 'COMPLETED_EMPTY';");
  assert.notEqual(mutated, source, 'the mutation must actually land, otherwise this control proves nothing');

  const real = loadState();
  const broken = createLoader(ROOT).fromSource(mutated, STATE_MODULE);
  assert.deepEqual(resolverViolations(real.resolveItemCommerceState), []);
  const violations = resolverViolations(broken.resolveItemCommerceState);
  assert.ok(violations.length > 0, 'the matrix must catch a premature COMPLETED_EMPTY');
  assert.ok(violations.some((v) => /shelf=idle/.test(v)), 'and it must be the idle (never started) case');
});

test('RESOLVER MODULE: pure and dependency-free (the section harness loads it without mocks; the hook never imports it)', () => {
  const file = path.join(ROOT, STATE_MODULE);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const runtimeImports = sf.statements.filter((n) => ts.isImportDeclaration(n) && !(n.importClause && n.importClause.isTypeOnly));
  assert.deepEqual(runtimeImports.map((n) => n.moduleSpecifier.text), [], 'no runtime imports');

  const hook = fs.readFileSync(path.join(ROOT, 'hooks/useKScan.js'), 'utf8');
  assert.ok(!hook.includes('commerceShelfState'),
    'hooks/useKScan.js must not import the resolver: useKScanDuplicateGuard.test.js runs it in a vm with imports stripped');
  assert.equal((hook.match(/\buseState\(/g) || []).length, 10,
    'no new useState slot: the duplicate-guard harness drives the hook through a positional slot table');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART E - source scan: the no-match literals live only under COMPLETED_EMPTY
// ═══════════════════════════════════════════════════════════════════════════

const SCAN_DIRS = ['components', 'app', 'services', 'hooks'];
const SCAN_EXTRA_FILES = ['app.js'];

function listSources(dir) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__snapshots__') continue;
      out.push(...listSources(rel));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

/** True when `node` sits inside a construct that is only entered for COMPLETED_EMPTY. */
function underCompletedEmptyGuard(node) {
  const mentions = (n) => n && /COMPLETED_EMPTY/.test(n.getText());
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
      && parent.name && parent.name.getText().replace(/['"]/g, '') === 'COMPLETED_EMPTY') return true;
    if (ts.isCaseClause(parent) && mentions(parent.expression)) return true;
    if (ts.isConditionalExpression(parent) && child === parent.whenTrue && mentions(parent.condition)) return true;
    if (ts.isIfStatement(parent) && child === parent.thenStatement && mentions(parent.expression)) return true;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && child === parent.right && mentions(parent.left)) return true;
  }
  return false;
}

function findNoMatchLiterals() {
  const files = [...SCAN_DIRS.flatMap(listSources), ...SCAN_EXTRA_FILES];
  const hits = [];
  for (const file of files) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (!NO_MATCH_PATTERNS.some((re) => re.test(text))) continue; // cheap pre-filter
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const visit = (node) => {
      const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
      if (literal && isNoMatchText(node.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        hits.push({ file: file.replace(/\\/g, '/'), line: line + 1, text: node.text.trim().slice(0, 80), guarded: underCompletedEmptyGuard(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

test('NO-MATCH LITERALS: every occurrence in components/, app/, services/, hooks/ and app.js sits under a COMPLETED_EMPTY guard', () => {
  const hits = findNoMatchLiterals();
  const unguarded = hits.filter((h) => !h.guarded);
  assert.deepEqual(
    unguarded.map((h) => `${h.file}:${h.line} "${h.text}"`),
    [],
    'a no-match statement exists outside the COMPLETED_EMPTY branch / copy-table entry',
  );
  assert.ok(hits.some((h) => h.guarded && h.file === 'services/commerceShelfState.ts'),
    'the scan is not vacuous: the copy table entry for COMPLETED_EMPTY exists');
  assert.ok(hits.every((h) => h.file === 'services/commerceShelfState.ts'),
    'the literals live in exactly one place, the copy table');
});

test('NO-MATCH LITERALS: the scan really sees a literal placed outside the guard (negative control for the scanner itself)', () => {
  const sample = "const a = state === 'COMPLETED_EMPTY' ? 'No strong shopping match found.' : 'No strong shopping match found.';";
  const sf = ts.createSourceFile('sample.ts', sample, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const seen = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) && isNoMatchText(node.text)) seen.push(underCompletedEmptyGuard(node));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.deepEqual(seen, [true, false], 'whenTrue is guarded, whenFalse is not');
});

/** Every user-visible string in the copy table, outside COMPLETED_EMPTY, that words a no-match. */
function noMatchOutsideCompletedEmpty(table) {
  const found = [];
  for (const [state, copy] of Object.entries(table)) {
    if (state === 'COMPLETED_EMPTY') continue;
    for (const [field, value] of Object.entries(copy)) {
      const text = typeof value === 'function' ? value('a black blazer') : value;
      if (isNoMatchText(text)) found.push(`${state}.${field}: "${text}"`);
    }
  }
  return found;
}

test('COPY TABLE: no state other than COMPLETED_EMPTY words a no-match, in any phrasing', () => {
  const { COMMERCE_SHELF_COPY } = loadState();
  assert.deepEqual(noMatchOutsideCompletedEmpty(COMMERCE_SHELF_COPY), []);
  const own = Object.keys(COMMERCE_SHELF_COPY).filter((state) => state !== 'COMPLETED_EMPTY');
  assert.deepEqual(own.sort(), ['DEFERRED', 'ERROR', 'IN_PROGRESS', 'NOT_STARTED'], 'the check covers every non-empty state');
});

test('COPY TABLE (negative control): paraphrases of a no-match are recognised, neutral copy is not', () => {
  for (const claim of [
    'No matches found for this item.',
    'No shopping matches',
    'Nothing matched your item.',
    'We found no match for this.',
    'No strong shopping match found.',
  ]) {
    assert.ok(isNoMatchText(claim), `should be recognised as a no-match: "${claim}"`);
  }
  for (const neutral of [
    "Shopping matches aren't shown here.",
    'Finding where to buy this…',
    "Couldn't load purchase options for this item.",
    'Select this item, then tap Find Matches to see where to buy.',
  ]) {
    assert.ok(!isNoMatchText(neutral), `should not be flagged: "${neutral}"`);
  }
});

test('COPY TABLE (mutation control): rewording NOT_STARTED as a no-match in other words is caught', () => {
  const source = fs.readFileSync(path.join(ROOT, STATE_MODULE), 'utf8');
  const anchor = /shelfBody: "This item was identified, but where-to-buy results[^"\n]*",/;
  assert.ok(anchor.test(source), 'mutation anchor missing: update it if the copy was reworded');
  const mutated = source.replace(anchor, 'shelfBody: "No matches found for this item.",');
  assert.notEqual(mutated, source, 'the mutation must actually land');
  const broken = createLoader(ROOT).fromSource(mutated, STATE_MODULE);
  assert.deepEqual(noMatchOutsideCompletedEmpty(loadState().COMMERCE_SHELF_COPY), []);
  const violations = noMatchOutsideCompletedEmpty(broken.COMMERCE_SHELF_COPY);
  assert.deepEqual(violations, ['NOT_STARTED.shelfBody: "No matches found for this item."']);
});

test('CONSUMERS: the section, the reopen path and ProductShelf take their state and copy from services/commerceShelfState', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const section = read('components/scan-results/MultiItemCommerceSection.tsx');
  assert.match(section, /from '\.\.\/\.\.\/services\/commerceShelfState'/);
  assert.match(section, /resolveItemCommerceState\(/);
  const card = read('components/AnalysisCard.tsx');
  assert.match(card, /from '\.\.\/services\/commerceShelfState'/);
  assert.match(card, /storedItemEmptyShelfProps\(/);
  assert.match(card, /purchaseShelfEmptyProps\(/);
  const shelf = read('components/ProductShelf.tsx');
  assert.match(shelf, /from '\.\.\/services\/commerceShelfState'/,
    'ProductShelf default empty copy comes from the copy table (NOT_STARTED), not a no-match sentence');
});
