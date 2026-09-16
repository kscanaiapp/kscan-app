// P1 live incident — Elise photo upload rejected an ordinary fashion photo.
//
// WHAT THIS PROVES, AND WHY IT IS THE LOAD-BEARING TEST OF THE REPAIR.
//
// The repair is BACKEND-ONLY: `scan-identify` now narrows the detection
// candidate set to one garment for `elise_camera` / `elise_gallery` when one
// garment unambiguously dominates the frame. That only fixes the LIVE app if
// the already-shipped client consumes a one-candidate
// `multiple_items_need_selection` detection by proceeding — with no new
// binary. Nothing about the backend change can establish that; only the client
// code can.
//
// So this exercises the REAL shipped client orchestrator against a stubbed
// transport, and pins both directions:
//
//   one candidate  -> proceeds to a selected-item request and returns a usable
//                     identity (the live rejection is gone)
//   two candidates -> still `needs_selection`, and zero selected-item requests
//                     are spent (ambiguity is still the user's call)
//
// PROVENANCE. `services/style-chat/eliseIdentifyForStyle.ts`,
// `eliseDirectImageIdentification.ts`, `eliseIdentificationV2.ts`,
// `fashionIdentificationV2Core.ts` and `hooks/useStyleChatAttachments.ts` are
// byte-identical between this branch and the live Build 33 source authority
// `release/ios-build33-app-review-hardening` @ 6f681ba4. This file therefore
// describes the binary customers are running today, not just this branch.
//
// No user photograph is used or stored. The bounding boxes below are a
// structural stand-in for the reported image class: one garment filling the
// frame, another grazing the bottom edge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const {
  EVIDENCE_ID,
  baseResult,
  clone,
  eliseEvidence,
} = require('./fixtures/phase2b4CrossPathFixtures.js');

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
      // Load-bearing: a module reaching for commerce or persistence throws
      // HERE rather than silently acquiring it.
      throw new Error(`Unexpected import ${id} from ${relativePath}`);
    },
  });
  return mod.exports;
}

// ── Module graph: the transport is the only stub ─────────────────────────────

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
 * A transport that answers detection and selected-item stages separately, so
 * the two-stage flow is exercised the way the app runs it.
 */
function makeStagedTransport(detection, selected) {
  const calls = [];
  const transport = async (image, options) => {
    calls.push({ image, options });
    const isSelection = options?.contractRequestV2?.mode === 'identify_selected_item';
    return {
      status: 'completed',
      recommendedProducts: [],
      identificationV2: clone(isSelection ? selected : detection),
      scanSessionId: 'sess-incident',
      imageDigestPrefix: 'digest-incident',
    };
  };
  transport.calls = calls;
  return transport;
}

function candidate(candidateId, category, subtype, bounds) {
  return {
    candidateId,
    evidenceId: EVIDENCE_ID,
    category,
    subtype,
    ...(bounds ? { bounds } : {}),
  };
}

/** What the REPAIRED backend returns for the reported photo: the incidental
 *  garment is no longer offered, because one garment dominates the frame. */
const REPAIRED_DOMINANT_DETECTION = baseResult({
  status: 'multiple_items_need_selection',
  candidates: [
    candidate('garment-1-top-henley', 'tops', 'henley', {
      x: 0.08,
      y: 0.04,
      width: 0.84,
      height: 0.74,
    }),
  ],
});

/** What the backend returns TODAY for that same photo, and what it must still
 *  return when nothing dominates. */
const AMBIGUOUS_DETECTION = baseResult({
  status: 'multiple_items_need_selection',
  candidates: [
    candidate('garment-1-top-shirt', 'tops', 'shirt', {
      x: 0.2,
      y: 0.05,
      width: 0.6,
      height: 0.42,
    }),
    candidate('garment-2-bottoms-trousers', 'bottoms', 'trousers', {
      x: 0.22,
      y: 0.48,
      width: 0.56,
      height: 0.47,
    }),
  ],
});

const SELECTED_IDENTITY = baseResult({
  status: 'completed',
  item: { category: 'tops', subtype: 'henley' },
});

function runItemPath(detection, selected = SELECTED_IDENTITY) {
  const transport = makeStagedTransport(detection, selected);
  return eliseIdentify.identifyPreparedImageForStyle({
    evidence: eliseEvidence('gallery'),
    // The live "Choose from Photos" attachment path.
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'req-p1-incident',
    sessionFlag: SESSION_ON,
    policy: 'item',
    transport,
  }).then((outcome) => ({ outcome, transport }));
}

// ── The live defect is closed by the backend response alone ──────────────────

test('live client proceeds on a one-candidate multi-item detection', async () => {
  const { outcome, transport } = await runItemPath(REPAIRED_DOMINANT_DETECTION);

  // Before the repair this same photo produced two candidates and landed on
  // `needs_selection`, which the composer renders as the terminal
  // "Several items found" chip.
  assert.equal(outcome.state, 'ready');
  assert.equal(outcome.candidates.length, 0);
  assert.equal(outcome.identifications.length, 1);
  assert.equal(outcome.identifications[0].item.subtype, 'henley');

  // Detection, then exactly one selected-item request for the garment the
  // backend resolved. No extra identification was billed.
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0].options.contractRequestV2.mode, 'detect_items');
  assert.equal(transport.calls[1].options.contractRequestV2.mode, 'identify_selected_item');
  assert.equal(
    transport.calls[1].options.contractRequestV2.selectedCandidate.candidateId,
    'garment-1-top-henley',
  );
});

test('the client never needed a new binary: no client rule changed', async () => {
  // The one-candidate auto-continue is pre-existing behaviour, not something
  // this repair added. `elise_gallery` and `elise_camera` both take it.
  for (const entryPath of ['direct_camera', 'direct_gallery']) {
    const transport = makeStagedTransport(REPAIRED_DOMINANT_DETECTION, SELECTED_IDENTITY);
    const outcome = await eliseIdentify.identifyPreparedImageForStyle({
      evidence: eliseEvidence(entryPath === 'direct_camera' ? 'camera' : 'gallery'),
      entryPath,
      platform: 'ios',
      requestId: `req-${entryPath}`,
      sessionFlag: SESSION_ON,
      policy: 'item',
      transport,
    });
    assert.equal(outcome.state, 'ready', `${entryPath} must proceed`);
  }
});

// ── Ambiguity is still the user's call ───────────────────────────────────────

test('a genuinely ambiguous detection still asks and never guesses', async () => {
  const { outcome, transport } = await runItemPath(AMBIGUOUS_DETECTION);

  assert.equal(outcome.state, 'needs_selection');
  assert.equal(outcome.identifications.length, 0);
  assert.equal(outcome.candidates.length, 2);
  // Both candidates survive in order. Nothing was ranked away client-side.
  // `Array.from` is load-bearing: the modules run in a separate VM realm, so a
  // foreign-realm array fails deepStrictEqual on its prototype alone.
  assert.deepEqual(
    Array.from(outcome.candidates, (c) => c.candidateId),
    ['garment-1-top-shirt', 'garment-2-bottoms-trousers'],
  );
  // Detection only: no selected-item request was spent guessing which one.
  assert.equal(transport.calls.length, 1);
});

test('the outfit path is unaffected by how the item path resolves', async () => {
  // The header gallery identifies the whole candidate set, and the backend
  // repair deliberately excludes `elise_header_gallery`. A multi-candidate
  // detection must still fan out there.
  const transport = makeStagedTransport(AMBIGUOUS_DETECTION, SELECTED_IDENTITY);
  const outcome = await eliseIdentify.identifyPreparedImageForStyle({
    evidence: eliseEvidence('header_gallery'),
    entryPath: 'header_gallery',
    platform: 'ios',
    requestId: 'req-outfit',
    sessionFlag: SESSION_ON,
    policy: 'outfit',
    transport,
  });

  assert.equal(outcome.state, 'ready');
  assert.equal(outcome.identifications.length, 2);
  // One detection + one selected-item request per candidate.
  assert.equal(transport.calls.length, 3);
});

// ── Safe fallbacks are preserved ─────────────────────────────────────────────

test('a no-garment detection still reaches the existing safe fallback', async () => {
  const transport = makeStagedTransport(
    baseResult({ status: 'multiple_items_need_selection', candidates: [] }),
    SELECTED_IDENTITY,
  );
  const outcome = await eliseIdentify.identifyPreparedImageForStyle({
    evidence: eliseEvidence('gallery'),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'req-empty',
    sessionFlag: SESSION_ON,
    policy: 'item',
    transport,
  });

  // Zero candidates from a completed detection is "saw the image, found no
  // garment" — an honest terminal state, not the multi-item rejection.
  assert.equal(outcome.state, 'insufficient_evidence');
  assert.equal(transport.calls.length, 1);
});

test('a malformed detection response still fails closed', async () => {
  const transport = makeStagedTransport(
    { ...clone(baseResult()), status: 'not_a_real_status' },
    SELECTED_IDENTITY,
  );
  const outcome = await eliseIdentify.identifyPreparedImageForStyle({
    evidence: eliseEvidence('gallery'),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'req-malformed',
    sessionFlag: SESSION_ON,
    policy: 'item',
    transport,
  });

  assert.equal(outcome.state, 'technical_failure');
  assert.equal(outcome.identifications.length, 0);
  assert.equal(transport.calls.length, 1);
});

test('a removed attachment stops the flow before a second request is billed', async () => {
  const transport = makeStagedTransport(REPAIRED_DOMINANT_DETECTION, SELECTED_IDENTITY);
  const outcome = await eliseIdentify.identifyPreparedImageForStyle({
    evidence: eliseEvidence('gallery'),
    entryPath: 'direct_gallery',
    platform: 'ios',
    requestId: 'req-cancelled',
    sessionFlag: SESSION_ON,
    policy: 'item',
    transport,
    isCurrent: () => false,
  });

  assert.equal(outcome.state, 'cancelled');
  assert.equal(transport.calls.length, 0);
});
