'use strict';

/**
 * Test infrastructure: EXECUTE the real hooks/useKScan.js (multi-image enabled)
 * against the real Scanner service graph.
 *
 * Real, transpiled from the repository on every run:
 *   hooks/useKScan.js, services/multiImageScan.ts, services/actorContext.js,
 *   services/scannerEvidenceGateway.ts, services/fashionEvidenceGateway.ts,
 *   services/scannerIdentificationV2.ts, services/scannerScanRequest.ts,
 *   services/scanIdentification.ts (the real transport + response normaliser),
 *   services/scanIdentificationMapper.ts and the pure modules it imports.
 *
 * Simulated, because they are device or network edges:
 *   - the photo picker, image compression and the privacy sanitiser,
 *   - haptics, secondhand/sneaker/commerce enrichment,
 *   - the Supabase `scan-identify` invoke. It receives the REAL request body the
 *     transport built and returns a RAW edge-function payload, so the transport's
 *     own normalisation, the Scanner adapter and the mapper all execute.
 *
 * This is deliberately NOT a shortcut for device proof: it cannot show native
 * picker ordering, real HEIC/EXIF handling or real provider behaviour.
 *
 * It is a helper, not a test: scripts/run-all-tests.js only discovers
 * `*.test.js`, so nothing here runs on its own.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { createRenderer, transpile, ROOT, settle } = require('./componentRenderer');

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (callback) => setImmediate(callback);
}

function stripExt(rel) {
  return rel.replace(/\.(ts|tsx|js)$/, '');
}

/**
 * Loads repository modules on demand and resolves relative imports to real
 * files. A bare import, or a relative import that is neither stubbed nor part of
 * the real graph, throws: a new dependency is visible instead of silently stubbed.
 */
function createGraph({ stubs, mutate = {} }) {
  const cache = new Map();

  function resolve(fromRel, spec) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    for (const ext of ['.ts', '.tsx', '.js', '/index.ts', '/index.js', '']) {
      const candidate = base + ext;
      const absolute = path.join(ROOT, candidate);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return candidate;
    }
    throw new Error(`Unresolvable import ${spec} from ${fromRel}`);
  }

  function load(rel) {
    if (cache.has(rel)) return cache.get(rel).exports;
    const mod = { exports: {} };
    cache.set(rel, mod);
    const graphRequire = (spec) => {
      if (spec.startsWith('.')) {
        const target = resolve(rel, spec);
        const key = stripExt(target);
        if (Object.prototype.hasOwnProperty.call(stubs, key)) return stubs[key];
        return load(target);
      }
      if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec];
      throw new Error(`Unexpected require in ${rel}: ${spec}`);
    };
    const options = { jsx: false, ...(mutate[rel] ? { mutate: mutate[rel] } : {}) };
    vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel, options)}\n})`, {
      filename: rel,
    })(mod.exports, mod, graphRequire);
    return mod.exports;
  }

  return { load };
}

// ── Simulated device edges ──────────────────────────────────────────────────

const encodeImage = (uri) => `data:image/jpeg;base64,${Buffer.from(`IMG:${uri}`).toString('base64')}`;
const decodeImage = (base64) => Buffer.from(String(base64), 'base64').toString('utf8').replace(/^IMG:/, '');

/** A raw backend payload for the detection call of one photo. */
function detectionPayload(photo, uri) {
  const garments = (photo.garments ?? []).map((garment, index) => ({
    candidateId: garment.candidateId,
    order: index,
    label: garment.label ?? garment.subtype,
    category: garment.category,
    subtype: garment.subtype,
    ...(garment.bounds ? { bounds: garment.bounds } : {}),
    // `bare` models a detection entry with no attributes/identification, whose
    // selected-item failure therefore has no genuine detail to fall back on.
    ...(garment.bare
      ? {}
      : {
        attributes: { category: garment.category, colorPalette: [garment.color ?? 'black'] },
        identification: {
          visual_observation: `DET|${uri}|${garment.candidateId}`,
          primary_color: garment.color ?? 'black',
          subtype: garment.subtype,
        },
      }),
  }));
  return {
    status: 'completed',
    attributes: { category: photo.garments?.[0]?.category ?? 'outfit', colorPalette: ['black'] },
    identification: { visual_observation: `DET-TOP|${uri}` },
    detectedGarments: garments,
    recommendedProducts: [],
    userMessage: 'Identified a fashion item from your scan.',
  };
}

/** A raw backend payload for the selected-item call. It records WHAT the request carried. */
function selectedPayload(uri, candidateId, garment) {
  return {
    status: 'completed',
    attributes: { category: garment?.category ?? 'coat', colorPalette: [garment?.color ?? 'black'] },
    identification: { visual_observation: `SEL|${uri}|${candidateId}` },
    recommendedProducts: [],
    userMessage: 'Identified a fashion item from your scan.',
  };
}

/** What the real edge function returns when the daily quota is spent (HTTP 200). */
function rateLimitedPayload() {
  return {
    status: 'rate_limited',
    identification: null,
    attributes: {},
    recommendedProducts: [],
    products: [],
    purchaseOptions: [],
    similarityMatches: [],
    shoppingMeta: { provider: 'rate_limited', query: '', count: 0, providersTried: [], reason: 'daily_limit' },
    userMessage: 'Daily scan limit reached. Try again tomorrow.',
  };
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * The simulated Supabase `scan-identify` invoke. `respond(request)` may return a
 * raw payload, return `{ __error: Error }` to model an invoke/network failure, or
 * return a promise (to hold the request open). Every request is recorded.
 */
function createEdge({ photos = {}, respond } = {}) {
  const requests = [];
  const edge = {
    photos,
    requests,
    respond: respond ?? null,
    get detection() { return requests.filter((request) => request.mode === 'multi_item_detection'); },
    get selected() { return requests.filter((request) => request.mode === 'selected_item'); },
    async invoke(_name, { body, signal }) {
      const uri = decodeImage(body.imageBase64);
      const request = {
        uri,
        mode: body.requestMode ?? 'legacy',
        candidateId: body.selectedCandidate?.candidateId ?? null,
        body,
        signal,
        index: requests.length,
      };
      requests.push(request);
      if (signal?.aborted) throw abortError();

      const resolveResponse = async () => {
        if (edge.respond) {
          const custom = await edge.respond(request);
          if (custom !== undefined) return custom;
        }
        const photo = photos[uri];
        if (!photo) return { data: { status: 'failed' } };
        if (request.mode === 'selected_item') {
          const garment = (photo.garments ?? []).find((entry) => entry.candidateId === request.candidateId);
          return { data: selectedPayload(uri, request.candidateId, garment) };
        }
        if (photo.nonFashion) return { data: { status: 'non_fashion', userMessage: 'Not fashion.' } };
        return { data: detectionPayload(photo, uri) };
      };

      const aborted = new Promise((_, reject) => {
        signal?.addEventListener?.('abort', () => reject(abortError()), { once: true });
      });
      const outcome = await Promise.race([resolveResponse(), aborted]);
      if (outcome && outcome.__error) return { data: null, error: outcome.__error };
      return outcome && 'data' in outcome ? outcome : { data: outcome };
    },
  };
  return edge;
}

function createPicker() {
  const picker = {
    launches: [],
    queue: [],
    async launchImageLibraryAsync(options) {
      picker.launches.push(options);
      if (picker.queue.length === 0) return { canceled: true };
      const next = picker.queue.shift();
      return typeof next === 'function' ? next(options) : next;
    },
    /** Queue a picker answer. assets: [{ uri, assetId? , type? }] in the order the user picked. */
    pick(assets) {
      picker.queue.push({ canceled: false, assets });
    },
  };
  return picker;
}

// ── Mount ───────────────────────────────────────────────────────────────────

const FLAGS_DEFAULT = {
  MULTI_IMAGE_SCANNER_ENABLED: true,
  SCAN_IDENTIFY_BACKEND_ENABLED: true,
  resolveScannerIdentificationV2Enabled: () => false,
};

/**
 * Mount the real hook inside a stateful probe component.
 * @param {object} options
 * @param {object} [options.photos]       uri -> { garments: [...] } | { nonFashion: true }
 * @param {Function} [options.respond]    request -> raw payload | { __error } | undefined (default scenario)
 * @param {Function} [options.hookMutate] negative-control rewrite of hooks/useKScan.js
 * @param {object}  [options.mutate]      rel path -> rewrite, for any other real module
 * @param {object}  [options.compress]    uri -> throw to model a corrupt/unsupported image
 */
function mountUseKScan(options = {}) {
  const renderer = createRenderer();
  const edge = createEdge({ photos: options.photos ?? {}, respond: options.respond });
  const picker = createPicker();
  const alerts = [];
  const announcements = [];
  const preparedFailures = options.compress ?? {};

  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'actor-a' } } } }) },
    functions: { invoke: (name, payload) => edge.invoke(name, payload) },
  };

  const stubs = {
    react: { ...renderer.react, default: renderer.react },
    'react-native': {
      Platform: { OS: 'ios' },
      Alert: { alert: (...args) => alerts.push(args) },
      AccessibilityInfo: { announceForAccessibility: (message) => announcements.push(message) },
    },
    'expo-crypto': {
      digestStringAsync: async (_algorithm, value) => nodeCrypto.createHash('sha256').update(String(value)).digest('hex'),
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    },
    'expo-image-picker': { launchImageLibraryAsync: (launchOptions) => picker.launchImageLibraryAsync(launchOptions) },
    'constants/featureFlags': { ...FLAGS_DEFAULT, ...(options.flags ?? {}) },
    'constants/build': { SCAN_DIAGNOSTICS_ENABLED: false, SCAN_IDENTITY_DEBUG: false },
    'services/supabaseClient': { supabase },
    'services/imageUtils': {
      compressForUpload: async (uri) => {
        if (preparedFailures[uri]) throw new Error(`cannot decode ${uri}`);
        return encodeImage(uri);
      },
    },
    'services/privacyImageSanitizer': {
      sanitizeImageBeforeUpload: async (compressed) => compressed,
      getPrivacySanitizerStatus: () => ({
        mode: 'test', faceDetectionAvailable: true, faceBlurApplied: true, plateMaskApplied: true,
      }),
    },
    'services/haptics': {
      errorPulse() {}, softImpact() {}, successPulse() {}, warningPulse() {},
    },
    'services/commerceHydration': {
      fetchDeferredCommerce: async () => ({ status: 'error', purchaseOptions: [], enrichmentCandidates: [], retryable: false }),
      mergeEnrichedOffers: (current) => current,
    },
    'services/multiItemCommerce': { fetchMultiItemCommerce: async () => new Map() },
    'services/secondhand': {
      buildSecondhandSearchRequest: () => null,
      searchVintedSecondhand: async () => null,
    },
    'services/sneakers/index': {
      searchSneakers: async () => [],
      shouldEnrichSneakers: () => false,
    },
    ...(options.stubs ?? {}),
  };

  const mutate = {
    'hooks/useKScan.js': (source) => {
      // Test seam only: the 600 ms cinematic minimum is wall-clock time, not behaviour.
      const fast = source.replace('const MIN_ANALYSIS_MS = 600;', 'const MIN_ANALYSIS_MS = 0;');
      return options.hookMutate ? options.hookMutate(fast) : fast;
    },
    ...(options.mutate ?? {}),
  };

  const graph = createGraph({ stubs, mutate });
  const actor = graph.load('services/actorContext.js');
  actor.__resetActorContextForTests();
  actor.advanceActorEpoch(options.actorId ?? 'actor-a');
  const { useKScan } = graph.load('hooks/useKScan.js');

  let current = null;
  function Probe() {
    current = useKScan();
    return null;
  }
  const root = renderer.jsx(Probe, {});
  renderer.render(root);

  async function idle(cycles = 8) {
    for (let index = 0; index < cycles; index += 1) {
      await settle(2);
      renderer.render(root);
    }
  }

  return {
    get hook() { return current; },
    actor,
    edge,
    picker,
    alerts,
    announcements,
    graph,
    idle,
    unmount: () => renderer.unmount(),
    rerender: () => renderer.render(root),
    /** Drive a normal gallery selection through to the preview state. */
    async selectPhotos(assets) {
      picker.pick(assets);
      await current.selectGalleryPhoto();
      await idle();
    },
    async addPhotos(assets) {
      picker.pick(assets);
      await current.addGalleryPhotos();
      await idle();
    },
    /** Run detection and wait for the hook to leave `processing`. */
    async analyze() {
      const pending = current.runAnalysis();
      await pending;
      await idle();
    },
  };
}

module.exports = {
  createEdge,
  createGraph,
  createPicker,
  decodeImage,
  detectionPayload,
  encodeImage,
  mountUseKScan,
  rateLimitedPayload,
  selectedPayload,
};
