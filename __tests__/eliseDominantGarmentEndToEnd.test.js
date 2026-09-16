// P1 live Elise photo upload — the backend-to-client seam, end to end.
//
// WHY THIS EXISTS SEPARATELY FROM THE OTHER TWO SUITES.
//
//   supabase/functions/scan-identify/eliseDominantGarment.test.ts proves the
//   RULE is right. __tests__/eliseDominantGarmentLiveConsumption.test.js proves
//   the shipped CLIENT proceeds when handed one candidate. Neither proves the
//   thing that actually has to hold in production: that the backend, starting
//   from raw provider output, emits a response the client validates and
//   consumes the way we think it does. A repair can be correct on both sides of
//   a contract and still not meet in the middle.
//
// So this runs the real chain, with no network and no stubbed step between the
// provider payload and the client's answer:
//
//   raw provider garments
//     -> sanitizeDetectedGarments            (backend, multiItemGarments.ts)
//     -> resolveEliseDominantGarment         (backend, the repair)
//     -> the index.ts candidate projection   (transcribed below, pinned by the
//                                             WIRING tests in the Deno suite)
//     -> normalizeToV2                       (backend, _shared)
//     -> validateFashionV2Response           (client, strict validator)
//     -> extractFashionV2Candidates          (client)
//     -> identifyPreparedImageForStyle       (client orchestrator, policy item)
//
// The backend modules are Deno sources with `.ts` specifiers; they are loaded
// through the same transpiling VM loader the other cross-path suites use, so
// this executes the real files rather than a Node-flavoured copy of them.
//
// Cases are the four the incident asks about: single item, dominant plus
// incidental, genuine ambiguity, and no item. No user photograph is used or
// stored — the boxes are structural stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const { EVIDENCE_ID, eliseEvidence } = require('./fixtures/phase2b4CrossPathFixtures.js');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    console,
    __DEV__: false,
    process: { env: {} },
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected import ${id} from ${relativePath}`);
    },
  });
  return mod.exports;
}

// ── Backend half ─────────────────────────────────────────────────────────────

const backendGarments = loadTsModule('supabase/functions/scan-identify/multiItemGarments.ts', {});
const backendDominance = loadTsModule(
  'supabase/functions/scan-identify/eliseDominantGarment.ts',
  { './multiItemGarments.ts': backendGarments },
);
const backendV2 = loadTsModule('supabase/functions/_shared/fashionIdentificationV2.ts', {});

// ── Client half ──────────────────────────────────────────────────────────────

let cryptoCounter = 0;
const contractTypes = loadTsModule('types/fashionIdentificationV2.ts', {});
const evidenceGateway = loadTsModule('services/fashionEvidenceGateway.ts', {
  'expo-crypto': {
    getRandomBytes: (n) => {
      cryptoCounter += 1;
      return Uint8Array.from({ length: n }, (_, i) => (i * 17 + cryptoCounter * 13) & 0xff);
    },
  },
});
const v2Core = loadTsModule('services/fashionIdentificationV2Core.ts', {
  '../types/fashionIdentificationV2': contractTypes,
  './fashionEvidenceGateway': evidenceGateway,
});
const eliseAdapter = loadTsModule('services/style-chat/eliseIdentificationV2.ts', {
  '../../types/fashionIdentificationV2': contractTypes,
  '../fashionEvidenceGateway': evidenceGateway,
  '../fashionIdentificationV2Core': v2Core,
  '../../constants/featureFlags': { resolveEliseIdentificationV2Enabled: () => true },
});
const transportStub = { identifyScanImage: null };
const eliseIdentify = loadTsModule('services/style-chat/eliseIdentifyForStyle.ts', {
  '../scanIdentification': {
    get identifyScanImage() { return transportStub.identifyScanImage; },
  },
  '../fashionEvidenceGateway': evidenceGateway,
  '../fashionIdentificationV2Core': v2Core,
  './eliseIdentificationV2': eliseAdapter,
});

const SESSION_ON = { enabled: true, reason: 'flag_on' };

/**
 * The candidate projection from `supabase/functions/scan-identify/index.ts`.
 *
 * Transcribed rather than imported because index.ts is a Deno server module
 * that binds a request handler at import time. The Deno suite's WIRING tests
 * assert the real projection still reads exactly this way, so a drift between
 * the two fails there rather than passing silently here.
 */
function backendDetectionResponse({ providerGarments, wireEntryPath, requestId }) {
  const detectedGarments = backendGarments.sanitizeDetectedGarments(providerGarments);

  const eliseDominant = detectedGarments.length > 1 &&
      backendDominance.isEliseItemEntryPath(wireEntryPath)
    ? backendDominance.resolveEliseDominantGarment(detectedGarments)
    : null;
  const v2CandidateGarments = eliseDominant?.kind === 'dominant'
    ? [eliseDominant.garment]
    : detectedGarments;

  const v2DetectionCandidates = v2CandidateGarments.length > 0
    ? v2CandidateGarments.map((garment) => ({
      candidateId: garment.candidateId,
      evidenceId: EVIDENCE_ID,
      category: garment.category ?? null,
      subtype: garment.subtype ?? null,
      ...(garment.bounds ? { bounds: garment.bounds } : {}),
    }))
    : undefined;

  const primary = v2CandidateGarments[0];
  return backendV2.normalizeToV2({
    requestId,
    outcome: v2DetectionCandidates ? 'multiple_items_need_selection' : 'classified',
    evidenceIds: [EVIDENCE_ID],
    identification: primary ? primary.identification : undefined,
    attributes: primary ? primary.attributes : undefined,
    ...(v2DetectionCandidates ? { candidates: v2DetectionCandidates } : {}),
  });
}

/** The selected-item answer for whichever candidate the client asks about. */
function backendSelectedResponse(providerGarments, candidateId, requestId) {
  const match = backendGarments.sanitizeDetectedGarments(providerGarments)
    .find((g) => g.candidateId === candidateId);
  assert.ok(match, `selected-item request named an unknown candidate: ${candidateId}`);
  return backendV2.normalizeToV2({
    requestId,
    outcome: 'classified',
    evidenceIds: [EVIDENCE_ID],
    identification: match.identification,
    attributes: match.attributes,
  });
}

function runCase({ providerGarments, entryPath, policy = 'item', requestId }) {
  const seen = { detectionValidation: null, selectedCandidateIds: [] };

  // The client's entry-path KEY (`direct_gallery`) is not the value that
  // travels (`elise_gallery`); `ELISE_ENTRY_PATHS` maps between them. Using the
  // production mapper here rather than a literal is deliberate — it makes this
  // suite fail if the backend gate and the value the client actually sends ever
  // stop naming the same path.
  const wireEntryPath = eliseAdapter.eliseEntryPathFor(entryPath);

  const transport = async (image, options) => {
    const request = options?.contractRequestV2;
    if (request?.mode === 'identify_selected_item') {
      const id = request.selectedCandidate.candidateId;
      seen.selectedCandidateIds.push(id);
      return {
        status: 'completed',
        recommendedProducts: [],
        identificationV2: backendSelectedResponse(providerGarments, id, requestId),
        scanSessionId: 'sess-e2e',
        imageDigestPrefix: 'digest-e2e',
      };
    }
    const detection = backendDetectionResponse({ providerGarments, wireEntryPath, requestId });
    // The client's own strict validator, run on the real backend bytes. An
    // `additionalProperties` violation or a missing confidence key is caught
    // HERE, where it is a contract defect, rather than as a mystery
    // technical_failure downstream.
    seen.detectionValidation = v2Core.validateFashionV2Response(detection);
    seen.detectionCandidates = v2Core.extractFashionV2Candidates(detection, EVIDENCE_ID);
    return {
      status: 'completed',
      recommendedProducts: [],
      identificationV2: detection,
      scanSessionId: 'sess-e2e',
      imageDigestPrefix: 'digest-e2e',
    };
  };

  return eliseIdentify.identifyPreparedImageForStyle({
    evidence: eliseEvidence(entryPath === 'direct_camera' ? 'camera' : 'gallery'),
    entryPath,
    platform: 'ios',
    requestId,
    sessionFlag: SESSION_ON,
    policy,
    transport,
  }).then((outcome) => ({ outcome, seen }));
}

// Raw provider shapes, exactly as Gemini emits them: [yMin, xMin, yMax, xMax]
// on a 0..1000 scale.
const WHITE_TOP = {
  category: 'tops',
  subtype: 'henley',
  bounds: [40, 80, 820, 920],
  confidenceScore: 0.88,
  identification: { item_type: 'tops', subtype: 'henley', primary_color: 'white' },
};
const INCIDENTAL_GREY_BOTTOM = {
  category: 'bottoms',
  subtype: 'trousers',
  bounds: [880, 100, 980, 900],
  confidenceScore: 0.72,
  identification: { item_type: 'bottoms', subtype: 'trousers', primary_color: 'grey' },
};
const OUTFIT_SHIRT = {
  category: 'tops',
  subtype: 'shirt',
  bounds: [50, 200, 470, 800],
  identification: { item_type: 'tops', subtype: 'shirt', primary_color: 'blue' },
};
const OUTFIT_TROUSERS = {
  category: 'bottoms',
  subtype: 'trousers',
  bounds: [480, 220, 950, 780],
  identification: { item_type: 'bottoms', subtype: 'trousers', primary_color: 'stone' },
};

// ── A. single usable item ────────────────────────────────────────────────────

test('E2E single item: proceeds, exactly as it does today', async () => {
  const { outcome, seen } = await runCase({
    providerGarments: [WHITE_TOP],
    entryPath: 'direct_gallery',
    requestId: 'e2e-single',
  });

  assert.equal(seen.detectionValidation.kind, 'ok');
  assert.equal(seen.detectionCandidates.length, 1);
  assert.equal(outcome.state, 'ready');
  assert.equal(outcome.identifications[0].item.subtype, 'henley');
  assert.deepEqual(Array.from(seen.selectedCandidateIds), ['garment-1-tops-henley']);
});

// ── B. the reported defect: dominant plus incidental ─────────────────────────

test('E2E dominant + incidental: the reported photo now proceeds on the top', async () => {
  const { outcome, seen } = await runCase({
    providerGarments: [WHITE_TOP, INCIDENTAL_GREY_BOTTOM],
    entryPath: 'direct_gallery',
    requestId: 'e2e-dominant',
  });

  // The backend offered one candidate, and the client's strict validator
  // accepted the narrowed response.
  assert.equal(seen.detectionValidation.kind, 'ok');
  assert.equal(seen.detectionCandidates.length, 1);
  assert.equal(seen.detectionCandidates[0].candidateId, 'garment-1-tops-henley');

  // No blocking modal: the flow completes with a usable identity.
  assert.equal(outcome.state, 'ready');
  assert.equal(outcome.candidates.length, 0);
  assert.equal(outcome.identifications[0].item.subtype, 'henley');
  assert.deepEqual(Array.from(seen.selectedCandidateIds), ['garment-1-tops-henley']);
});

test('E2E dominant + incidental: same result when the camera path sends it', async () => {
  const { outcome } = await runCase({
    providerGarments: [INCIDENTAL_GREY_BOTTOM, WHITE_TOP],
    entryPath: 'direct_camera',
    requestId: 'e2e-dominant-camera',
  });
  assert.equal(outcome.state, 'ready');
  assert.equal(outcome.identifications[0].item.subtype, 'henley');
});

// ── C. genuine ambiguity ─────────────────────────────────────────────────────

test('E2E genuine ambiguity: both candidates reach the client and it asks', async () => {
  const { outcome, seen } = await runCase({
    providerGarments: [OUTFIT_SHIRT, OUTFIT_TROUSERS],
    entryPath: 'direct_gallery',
    requestId: 'e2e-ambiguous',
  });

  assert.equal(seen.detectionValidation.kind, 'ok');
  assert.equal(seen.detectionCandidates.length, 2);
  assert.equal(outcome.state, 'needs_selection');
  assert.equal(outcome.candidates.length, 2);
  // Nothing was identified, so nothing was billed past detection.
  assert.deepEqual(Array.from(seen.selectedCandidateIds), []);
});

// ── D. no usable item ────────────────────────────────────────────────────────

test('E2E no item: reaches the existing safe fallback, not the multi-item block', async () => {
  const { outcome, seen } = await runCase({
    // Nothing the sanitizer can build a garment from.
    providerGarments: [{ primary_color: 'beige' }, null, 'not a garment'],
    entryPath: 'direct_gallery',
    requestId: 'e2e-none',
  });

  assert.equal(seen.detectionValidation.kind, 'ok');
  assert.equal(seen.detectionCandidates.length, 0);
  assert.equal(outcome.state, 'insufficient_evidence');
  assert.deepEqual(Array.from(seen.selectedCandidateIds), []);
});

// ── Non-Elise paths keep the full candidate set ──────────────────────────────

test('E2E Scanner: the same photo still yields every candidate', async () => {
  // Scanner's own orchestrator is separate; what is proved here is that the
  // BACKEND does not narrow for a scanner entry path. Same provider payload as
  // the dominant case, which for Elise collapses to one.
  const detection = backendDetectionResponse({
    providerGarments: [WHITE_TOP, INCIDENTAL_GREY_BOTTOM],
    wireEntryPath: 'scanner_camera',
    requestId: 'e2e-scanner',
  });

  assert.equal(v2Core.validateFashionV2Response(detection).kind, 'ok');
  const candidates = v2Core.extractFashionV2Candidates(detection, EVIDENCE_ID);
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    Array.from(candidates, (c) => c.candidateId),
    ['garment-1-tops-henley', 'garment-2-bottoms-trousers'],
  );
});

test('E2E Closet and the header gallery keep every candidate too', async () => {
  for (const entryPath of ['closet_camera', 'closet_gallery', 'closet_mirror', 'elise_header_gallery']) {
    const detection = backendDetectionResponse({
      providerGarments: [WHITE_TOP, INCIDENTAL_GREY_BOTTOM],
      wireEntryPath: entryPath,
      requestId: `e2e-${entryPath}`,
    });
    const candidates = v2Core.extractFashionV2Candidates(detection, EVIDENCE_ID);
    assert.equal(candidates.length, 2, `${entryPath} must keep both candidates`);
  }
});

test('E2E outfit policy still fans out across the full set', async () => {
  const { outcome, seen } = await runCase({
    providerGarments: [WHITE_TOP, INCIDENTAL_GREY_BOTTOM],
    entryPath: 'header_gallery',
    policy: 'outfit',
    requestId: 'e2e-outfit',
  });

  assert.equal(outcome.state, 'ready');
  assert.equal(outcome.identifications.length, 2);
  assert.equal(seen.selectedCandidateIds.length, 2);
});

// ── The narrowed response is still a well-formed contract response ───────────

test('E2E the narrowed response carries no extra or missing contract fields', async () => {
  const detection = backendDetectionResponse({
    providerGarments: [WHITE_TOP, INCIDENTAL_GREY_BOTTOM],
    wireEntryPath: 'elise_gallery',
    requestId: 'e2e-shape',
  });

  // `candidates` is `additionalProperties: false` in the schema, so a field
  // invented while narrowing would be a contract break. The client's own
  // validator and extractor are the judges.
  assert.equal(v2Core.validateFashionV2Response(detection).kind, 'ok');
  assert.equal(detection.status, 'multiple_items_need_selection');
  assert.equal(detection.candidates.length, 1);
  assert.deepEqual(
    Object.keys(detection.candidates[0]).sort(),
    ['bounds', 'candidateId', 'category', 'evidenceId', 'subtype'],
  );
  // The selection tuple survives: a candidate that lost its evidence id would
  // be dropped by the client and the flow would stall.
  assert.equal(detection.candidates[0].evidenceId, EVIDENCE_ID);
});
