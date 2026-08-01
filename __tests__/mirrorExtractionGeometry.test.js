// Mirror Selfie geometry and privacy-primitive suite (Build 2.5 Step 3).
//
// Everything proved here is a PURE FUNCTION over data: person resolution,
// region derivation, ordering, deduplication, crop-key determinism, pixel-rect
// mapping, and the JPEG metadata inspector. No filesystem, no native module and
// no React are involved, so a failure here is a failure of the rule, not of a
// harness.
//
// WHAT THIS FILE CANNOT PROVE, and does not claim to: that on-device extraction
// works. That needs ML Kit and Apple Vision on real hardware against real
// photographs. See the Step 3 report's limitations section.

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
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

const moduleCache = new Map();

function runModule(rel, shims = {}) {
  if (moduleCache.has(rel)) return moduleCache.get(rel);
  const mod = { exports: {} };
  moduleCache.set(rel, mod.exports);
  const requireShim = (request) => {
    if (shims[request]) return shims[request];
    if (request.startsWith('.')) {
      const resolved = path
        .relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), request))
        .split(path.sep)
        .join('/');
      for (const candidate of [`${resolved}.ts`, `${resolved}.js`, `${resolved}/index.ts`]) {
        if (fs.existsSync(path.join(ROOT, candidate))) return runModule(candidate, shims);
      }
    }
    throw new Error(`Unexpected require in geometry suite: ${request}`);
  };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  moduleCache.set(rel, mod.exports);
  return mod.exports;
}

const contract = runModule('types/mirrorExtraction.ts');
const adapter = runModule('services/mirror/mirrorExtractionAdapter.ts');
const resolution = runModule('services/mirror/mirrorPersonResolution.ts');
const regions = runModule('services/mirror/mirrorGarmentRegions.ts');
const jpegMeta = runModule('services/mirror/jpegMetadata.ts');
const cropGen = (() => {
  // Crop generation pulls in expo modules; only its pure helpers are exercised
  // here, so the native surfaces are stubbed rather than the file split apart.
  return runModule('services/mirror/mirrorCropGeneration.ts', {
    'expo-file-system/legacy': {},
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' } },
    'expo-crypto': { randomUUID: () => 'x' },
  });
})();

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A synthetic person. Landmarks are placed at plausible normalized positions
 * for a standing figure; the numbers are a FIXTURE, not a measurement, and
 * exist so the geometry rules can be checked deterministically.
 */
function person(overrides = {}) {
  const base = {
    bounds: { x: 0.25, y: 0.05, width: 0.5, height: 0.9 },
    rankingExtent: { x: 0.42, y: 0.06, width: 0.16, height: 0.12 },
    confidence: 0.95,
    maskCoverage: null,
    landmarks: [
      { type: 'nose', x: 0.5, y: 0.1, confidence: 0.95 },
      { type: 'left_shoulder', x: 0.4, y: 0.2, confidence: 0.95 },
      { type: 'right_shoulder', x: 0.6, y: 0.2, confidence: 0.95 },
      { type: 'left_hip', x: 0.43, y: 0.5, confidence: 0.9 },
      { type: 'right_hip', x: 0.57, y: 0.5, confidence: 0.9 },
      { type: 'left_knee', x: 0.44, y: 0.7, confidence: 0.85 },
      { type: 'right_knee', x: 0.56, y: 0.7, confidence: 0.85 },
      { type: 'left_ankle', x: 0.45, y: 0.9, confidence: 0.8 },
      { type: 'right_ankle', x: 0.55, y: 0.9, confidence: 0.8 },
    ],
  };
  return adapter.normalizeDetectedPerson({ ...base, ...overrides });
}

function classesOf(list) {
  return list.map((r) => r.regionClass);
}

// ── MIRROR-ONE-PERSON-PROCEEDS ──────────────────────────────────────────────

test('MIRROR-ONE-PERSON-PROCEEDS: a single confident person resolves without asking', () => {
  const result = resolution.resolvePrimaryPerson([person()]);
  assert.equal(result.kind, 'resolved');
  assert.equal(result.personCount, 1);
});

test('MIRROR-NO-PERSON-RETURNS-BOUNDED-ERROR: an empty detection resolves to none', () => {
  assert.equal(resolution.resolvePrimaryPerson([]).kind, 'none');
  // Below the confidence floor is the same outcome as nothing at all.
  const faint = person({ confidence: 0.1 });
  assert.equal(resolution.resolvePrimaryPerson([faint]).kind, 'none');
});

// ── MIRROR-DOMINANT-PERSON-RULE-DETERMINISTIC ───────────────────────────────

test('MIRROR-DOMINANT-PERSON-RULE-DETERMINISTIC: a clearly larger subject wins silently', () => {
  const subject = person({ rankingExtent: { x: 0.4, y: 0.05, width: 0.2, height: 0.16 } });
  const bystander = person({ rankingExtent: { x: 0.05, y: 0.2, width: 0.06, height: 0.05 } });
  const forward = resolution.resolvePrimaryPerson([subject, bystander]);
  const reversed = resolution.resolvePrimaryPerson([bystander, subject]);
  assert.equal(forward.kind, 'resolved');
  assert.equal(reversed.kind, 'resolved');
  // Input order must not change the answer.
  assert.deepEqual(forward.person.rankingExtent, reversed.person.rankingExtent);
  // The subject, not the bystander. Compared with a tolerance because
  // normalizeBounds rebuilds width from clamped edges.
  assert.ok(Math.abs(forward.person.rankingExtent.width - 0.2) < 1e-9);
});

test('MIRROR-DOMINANT-PERSON-RULE-DETERMINISTIC: ties break on distance from centre', () => {
  const centred = person({ rankingExtent: { x: 0.45, y: 0.45, width: 0.1, height: 0.1 } });
  const offset = person({ rankingExtent: { x: 0.02, y: 0.02, width: 0.1, height: 0.1 } });
  // Identical areas, so dominance cannot fire; the ORDER is still total.
  const ordered = [offset, centred].sort(resolution.compareCandidates);
  assert.deepEqual(ordered[0].rankingExtent, centred.rankingExtent);
});

test('MIRROR-AMBIGUOUS-MULTI-PERSON-REQUIRES-SELECTION: similar sizes stop and ask', () => {
  const a = person({ rankingExtent: { x: 0.3, y: 0.1, width: 0.14, height: 0.12 } });
  const b = person({ rankingExtent: { x: 0.6, y: 0.1, width: 0.13, height: 0.12 } });
  const result = resolution.resolvePrimaryPerson([a, b]);
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.personCount, 2);
});

test('MIRROR-AMBIGUOUS-MULTI-PERSON-REQUIRES-SELECTION: an explicit choice resolves it', () => {
  const a = person({ rankingExtent: { x: 0.3, y: 0.1, width: 0.14, height: 0.12 } });
  const b = person({ rankingExtent: { x: 0.6, y: 0.1, width: 0.13, height: 0.12 } });
  const chosen = resolution.resolvePrimaryPerson([a, b], { explicitChoiceIndex: 1 });
  assert.equal(chosen.kind, 'resolved');
  // A stale index addresses nothing and must NOT silently select a stranger.
  const stale = resolution.resolvePrimaryPerson([a, b], { explicitChoiceIndex: 7 });
  assert.equal(stale.kind, 'ambiguous');
});

test('MIRROR-BACKGROUND-PERSON-GARMENTS-NOT-MERGED: only one person reaches derivation', () => {
  const subject = person({ rankingExtent: { x: 0.4, y: 0.05, width: 0.2, height: 0.16 } });
  const bystander = person({
    rankingExtent: { x: 0.02, y: 0.3, width: 0.05, height: 0.04 },
    bounds: { x: 0.0, y: 0.25, width: 0.12, height: 0.5 },
    landmarks: [
      { type: 'left_shoulder', x: 0.02, y: 0.32, confidence: 0.9 },
      { type: 'right_shoulder', x: 0.09, y: 0.32, confidence: 0.9 },
      { type: 'left_hip', x: 0.03, y: 0.5, confidence: 0.9 },
      { type: 'right_hip', x: 0.08, y: 0.5, confidence: 0.9 },
    ],
  });
  const resolved = resolution.resolvePrimaryPerson([subject, bystander]);
  assert.equal(resolved.kind, 'resolved');
  const derived = regions.deriveGarmentRegions(resolved.person);
  // Every region must sit inside the SELECTED person's box. A merged set would
  // produce a region spanning both figures and reach x < 0.1.
  for (const region of derived) {
    assert.ok(
      region.bounds.x + region.bounds.width > 0.15,
      `region ${region.regionClass} leaked into the bystander's side of the frame`,
    );
  }
});

// ── MIRROR-VISIBLE-GARMENTS-ONLY / region derivation ────────────────────────

test('MIRROR-VISIBLE-GARMENTS-ONLY: a full figure yields bands, never a whole-frame crop', () => {
  const derived = regions.deriveGarmentRegions(person());
  const classes = classesOf(derived);
  assert.ok(classes.includes('upper_body'));
  assert.ok(classes.includes('lower_body'));
  // With both bands available, a whole-figure region would duplicate their
  // union and add nothing but an ambiguous third choice.
  assert.ok(!classes.includes('full_length'));
  for (const region of derived) {
    assert.ok(region.bounds.width < 0.985 || region.bounds.height < 0.985);
  }
});

test('MIRROR-VISIBLE-GARMENTS-ONLY: no landmarks below the hip yields full_length only', () => {
  const partial = person({
    landmarks: [
      { type: 'left_shoulder', x: 0.4, y: 0.2, confidence: 0.9 },
      { type: 'right_shoulder', x: 0.6, y: 0.2, confidence: 0.9 },
      { type: 'left_hip', x: 0.43, y: 0.5, confidence: 0.9 },
      { type: 'right_hip', x: 0.57, y: 0.5, confidence: 0.9 },
    ],
  });
  const classes = classesOf(regions.deriveGarmentRegions(partial));
  assert.ok(classes.includes('upper_body'));
  assert.ok(!classes.includes('lower_body'));
  assert.ok(classes.includes('full_length'));
});

test('MIRROR-VISIBLE-GARMENTS-ONLY: an unusable landmark cannot define an edge', () => {
  // Ankles below the confidence floor must not place the lower-body hem.
  const weakAnkles = person({
    landmarks: person().landmarks.map((l) =>
      l.type.endsWith('_ankle') ? { ...l, confidence: 0.05 } : l,
    ),
  });
  const derived = regions.deriveGarmentRegions(weakAnkles);
  const lower = derived.find((r) => r.regionClass === 'lower_body');
  assert.ok(lower, 'knees should still support a lower-body band');
  // The hem is extrapolated from the knee, not pinned to the discarded ankle.
  assert.ok(lower.bounds.y + lower.bounds.height < 0.95);
  assert.equal(classesOf(derived).includes('left_foot'), false);
});

test('full_length is ALWAYS review — it spans more than one garment by construction', () => {
  const partial = person({
    landmarks: [
      { type: 'left_shoulder', x: 0.4, y: 0.2, confidence: 0.99 },
      { type: 'right_shoulder', x: 0.6, y: 0.2, confidence: 0.99 },
    ],
  });
  const derived = regions.deriveGarmentRegions(partial);
  const full = derived.find((r) => r.regionClass === 'full_length');
  assert.ok(full);
  assert.equal(full.confidenceBucket, 'review');
});

test('PARITY: an absent mask never changes which regions exist, only their bucket', () => {
  const withoutMask = regions.deriveGarmentRegions(person({ maskCoverage: null }));
  const withGoodMask = regions.deriveGarmentRegions(person({ maskCoverage: 0.8 }));
  const withPoorMask = regions.deriveGarmentRegions(person({ maskCoverage: 0.05 }));

  // Same regions, same order, same geometry on both platforms.
  assert.deepEqual(classesOf(withoutMask), classesOf(withGoodMask));
  assert.deepEqual(classesOf(withoutMask), classesOf(withPoorMask));
  assert.deepEqual(
    withoutMask.map((r) => r.bounds),
    withPoorMask.map((r) => r.bounds),
  );

  // Absence is NEUTRAL (Android must not be demoted for lacking a mask)...
  assert.deepEqual(
    withoutMask.map((r) => r.confidenceBucket),
    withGoodMask.map((r) => r.confidenceBucket),
  );
  // ...and a poor mask may only ever demote, never promote.
  const upperWithout = withoutMask.find((r) => r.regionClass === 'upper_body');
  const upperPoor = withPoorMask.find((r) => r.regionClass === 'upper_body');
  assert.equal(upperWithout.confidenceBucket, 'high');
  assert.equal(upperPoor.confidenceBucket, 'review');
});

// ── MIRROR-CROP-ORDER-DETERMINISTIC ─────────────────────────────────────────

test('MIRROR-CROP-ORDER-DETERMINISTIC: landmark order does not affect region order', () => {
  const forward = regions.deriveGarmentRegions(person());
  const shuffled = regions.deriveGarmentRegions(
    person({ landmarks: [...person().landmarks].reverse() }),
  );
  assert.deepEqual(classesOf(forward), classesOf(shuffled));
  assert.deepEqual(
    forward.map((r) => r.bounds),
    shuffled.map((r) => r.bounds),
  );
});

test('MIRROR-CROP-ORDER-DETERMINISTIC: canonical class order is respected', () => {
  const classes = classesOf(regions.deriveGarmentRegions(person()));
  const indices = classes.map((c) => contract.MIRROR_REGION_CLASS_ORDER.indexOf(c));
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i] >= indices[i - 1], `class order broke at position ${i}`);
  }
});

// ── MIRROR-OVERLAPPING-DETECTIONS-DEDUPED ───────────────────────────────────

test('MIRROR-OVERLAPPING-DETECTIONS-DEDUPED: coincident regions collapse to one', () => {
  const overlapping = [
    { regionClass: 'upper_body', bounds: { x: 0.3, y: 0.2, width: 0.4, height: 0.3 }, confidenceBucket: 'high' },
    { regionClass: 'lower_body', bounds: { x: 0.31, y: 0.21, width: 0.4, height: 0.3 }, confidenceBucket: 'high' },
  ];
  assert.equal(regions.dedupeRegions(overlapping).length, 1);
});

test('MIRROR-OVERLAPPING-DETECTIONS-DEDUPED: feet together produce one crop, not two', () => {
  // Ankles almost on top of each other — legs crossed, or a mis-placed joint.
  const feetTogether = person({
    landmarks: person()
      .landmarks.filter((l) => !l.type.endsWith('_ankle'))
      .concat([
        { type: 'left_ankle', x: 0.5, y: 0.9, confidence: 0.9 },
        { type: 'right_ankle', x: 0.505, y: 0.9, confidence: 0.9 },
      ]),
  });
  const feet = classesOf(regions.deriveGarmentRegions(feetTogether)).filter((c) =>
    c.endsWith('_foot'),
  );
  assert.equal(feet.length, 1);
});

test('MIRROR-OVERLAPPING-DETECTIONS-DEDUPED: distinct regions are NOT collapsed', () => {
  const derived = regions.deriveGarmentRegions(person());
  const upper = derived.find((r) => r.regionClass === 'upper_body');
  const lower = derived.find((r) => r.regionClass === 'lower_body');
  assert.ok(upper && lower);
  assert.ok(
    regions.intersectionOverUnion(upper.bounds, lower.bounds) <
      contract.MIRROR_REGION_IOU_THRESHOLD,
  );
});

// ── MIRROR-SOURCE-SELFIE-IS-NOT-A-CROP ──────────────────────────────────────

test('MIRROR-SOURCE-SELFIE-IS-NOT-A-CROP: a whole-frame region is refused', () => {
  assert.equal(cropGen.mirrorSourceIsNotACrop({ x: 0, y: 0, width: 1, height: 1 }), false);
  assert.equal(cropGen.mirrorSourceIsNotACrop({ x: 0, y: 0, width: 0.99, height: 0.99 }), false);
  assert.equal(cropGen.mirrorSourceIsNotACrop({ x: 0.1, y: 0.1, width: 0.6, height: 0.4 }), true);
});

test('MIRROR-SOURCE-SELFIE-IS-NOT-A-CROP: a frame-filling region is refused, not cropped', async () => {
  // The degenerate input: a person filling the frame with NO landmarks. The
  // only region geometry can offer is the whole picture — which is the selfie
  // itself. Derivation may propose it; crop generation must refuse to write it,
  // so the user is told no clothing could be isolated rather than being handed
  // a full-body photo of themselves as a "garment".
  const framed = adapter.normalizeDetectedPerson({
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    rankingExtent: { x: 0, y: 0, width: 1, height: 1 },
    confidence: 0.99,
    landmarks: [],
    maskCoverage: null,
  });
  const derived = regions.deriveGarmentRegions(framed);
  assert.equal(derived.length, 1);
  assert.equal(derived[0].regionClass, 'full_length');
  assert.equal(cropGen.mirrorSourceIsNotACrop(derived[0].bounds), false);

  const result = await cropGen.generateMirrorGarmentCrops(
    {
      extractionSessionId: 'session-a',
      normalizedSourceUri: 'file:///cache/kscan_mirror_sessions/session-a/normalized_source/s.jpg',
      normalizedWidth: 1000,
      normalizedHeight: 1400,
      sourceImageIndex: 0,
      regions: derived,
    },
    {
      // Reaching either of these would mean the frame-filling guard failed.
      ImageManipulator: {
        SaveFormat: { JPEG: 'jpeg' },
        manipulateAsync: async () => assert.fail('a frame-filling region must never be encoded'),
      },
      FileSystem: {
        moveAsync: async () => assert.fail('a frame-filling region must never be written'),
        deleteAsync: async () => {},
      },
      verifyMetadata: false,
    },
  );
  assert.equal(result.crops.length, 0);
  assert.equal(result.failedCount, 1);
});

// ── MIRROR-CROP-KEYS-DETERMINISTIC ──────────────────────────────────────────

test('MIRROR-CROP-KEYS-DETERMINISTIC: same inputs, same key; keys satisfy the Step 1 pattern', () => {
  assert.equal(cropGen.buildCropKey(0, 'upper_body', 0), 's0_upper_body_0');
  assert.equal(cropGen.buildCropKey(0, 'upper_body', 0), cropGen.buildCropKey(0, 'upper_body', 0));
  assert.notEqual(cropGen.buildCropKey(0, 'upper_body', 0), cropGen.buildCropKey(1, 'upper_body', 0));
  for (const regionClass of contract.MIRROR_REGION_CLASS_ORDER) {
    const key = cropGen.buildCropKey(0, regionClass, 3);
    assert.ok(contract.isValidMirrorCropKey(key), `${key} is not a legal staging crop key`);
  }
});

test('crop keys carry no URI, filename or coordinate', () => {
  const key = cropGen.buildCropKey(0, 'lower_body', 2);
  assert.ok(!/file:|content:|\/|\\|\.jpg/.test(key));
});

// ── pixel mapping ───────────────────────────────────────────────────────────

test('toPixelCrop never runs past the last pixel of the source', () => {
  const rect = cropGen.toPixelCrop({ x: 0.9, y: 0.9, width: 0.2, height: 0.2 }, 1000, 800);
  assert.ok(rect.originX + rect.width <= 1000);
  assert.ok(rect.originY + rect.height <= 800);
});

test('toPixelCrop refuses a degenerate rect rather than emitting a zero-size crop', () => {
  assert.equal(cropGen.toPixelCrop({ x: 0, y: 0, width: 0, height: 0.5 }, 1000, 800), null);
  assert.equal(cropGen.toPixelCrop({ x: 0, y: 0, width: 0.5, height: 0.5 }, 0, 800), null);
});

// ── JPEG metadata inspector ─────────────────────────────────────────────────

function jpeg(segments) {
  const parts = [Buffer.from([0xff, 0xd8])];
  for (const segment of segments) parts.push(segment);
  // Minimal scan + end of image.
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));
  return Buffer.concat(parts);
}

function app(marker, payload) {
  const length = payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, marker, (length >> 8) & 0xff, length & 0xff]),
    payload,
  ]);
}

/** JFIF APP0 — the benign header every camera JPEG carries. */
const JFIF = app(0xe0, Buffer.from('JFIF\0\0\0\0\0\0', 'latin1'));

/** An Exif APP1 whose IFD0 declares a GPS IFD pointer (tag 0x8825). */
function exifWithGps() {
  const header = Buffer.from('Exif\0\0', 'latin1');
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1'); // big endian
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 at offset 8
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x8825, 10); // GPS IFD pointer
  tiff.writeUInt16BE(4, 12); // LONG
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(200, 18);
  return app(0xe1, Buffer.concat([header, tiff]));
}

test('the inspector finds a GPS-bearing Exif segment', () => {
  const result = jpegMeta.inspectJpegBytes(new Uint8Array(jpeg([exifWithGps()])));
  assert.equal(result.kind, 'ok');
  assert.equal(result.hasExif, true);
  assert.equal(result.hasGps, true);
  assert.equal(jpegMeta.isMetadataFreeJpeg(result), false);
});

test('the inspector accepts a re-encoded JPEG carrying only JFIF', () => {
  const result = jpegMeta.inspectJpegBytes(new Uint8Array(jpeg([JFIF])));
  assert.equal(result.kind, 'ok');
  assert.equal(result.hasExif, false);
  assert.equal(result.hasGps, false);
  assert.equal(jpegMeta.isMetadataFreeJpeg(result), true);
});

test('the inspector rejects IPTC (APP13) and free-text comments', () => {
  const iptc = jpegMeta.inspectJpegBytes(
    new Uint8Array(jpeg([JFIF, app(0xed, Buffer.from('Photoshop 3.0\0', 'latin1'))])),
  );
  assert.equal(jpegMeta.isMetadataFreeJpeg(iptc), false);
  const comment = jpegMeta.inspectJpegBytes(
    new Uint8Array(jpeg([JFIF, app(0xfe, Buffer.from('IMG_4821.HEIC', 'latin1'))])),
  );
  assert.equal(jpegMeta.isMetadataFreeJpeg(comment), false);
});

test('an ICC colour profile is NOT disqualifying — it describes pixels, not people', () => {
  const icc = jpegMeta.inspectJpegBytes(
    new Uint8Array(jpeg([JFIF, app(0xe2, Buffer.from('ICC_PROFILE\0', 'latin1'))])),
  );
  assert.equal(jpegMeta.isMetadataFreeJpeg(icc), true);
});

test('the inspector FAILS CLOSED on anything it cannot parse', () => {
  assert.equal(jpegMeta.isMetadataFreeJpeg(jpegMeta.inspectJpegBytes(null)), false);
  assert.equal(
    jpegMeta.isMetadataFreeJpeg(jpegMeta.inspectJpegBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))),
    false,
  );
  // Truncated mid-segment: a file we cannot read is a file we cannot vouch for.
  const truncated = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40]), Buffer.alloc(4)]);
  assert.equal(
    jpegMeta.isMetadataFreeJpeg(jpegMeta.inspectJpegBytes(new Uint8Array(truncated))),
    false,
  );
});

test('base64ToBytes round-trips and refuses malformed input', () => {
  const bytes = jpegMeta.base64ToBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'));
  assert.deepEqual(Array.from(bytes), [0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(jpegMeta.base64ToBytes('not*valid*base64'), null);
});

// ── adapter normalization ───────────────────────────────────────────────────

test('bridge output is coerced: NaN, out-of-range and duplicate joints cannot survive', () => {
  const normalized = adapter.normalizeDetectedPerson({
    bounds: { x: -0.5, y: 0.5, width: 2, height: 0.2 },
    confidence: 5,
    maskCoverage: 9,
    landmarks: [
      { type: 'nose', x: Number.NaN, y: 0.1, confidence: 0.9 },
      { type: 'left_hip', x: 0.4, y: 0.5, confidence: 0.9 },
      { type: 'left_hip', x: 0.9, y: 0.9, confidence: 0.1 },
      { type: 'not_a_joint', x: 0.5, y: 0.5, confidence: 0.9 },
    ],
  });
  assert.equal(normalized.bounds.x, 0);
  assert.equal(normalized.bounds.width, 1);
  assert.equal(normalized.confidence, 1);
  assert.equal(normalized.maskCoverage, 1);
  // NaN dropped, unknown joint dropped, duplicate ignored (first wins).
  assert.deepEqual(normalized.landmarks.map((l) => l.type), ['left_hip']);
  assert.equal(normalized.landmarks[0].x, 0.4);
  // A runtime that omits rankingExtent falls back to bounds.
  assert.deepEqual(normalized.rankingExtent, normalized.bounds);
});

test('a rect that is entirely outside the frame is rejected, not clamped to a sliver', () => {
  assert.equal(adapter.normalizeBounds({ x: 1.5, y: 1.5, width: 0.2, height: 0.2 }), null);
});
