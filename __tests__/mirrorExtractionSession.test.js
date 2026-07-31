// Mirror Selfie extraction session suite (Build 2.5 Step 3).
//
// The REAL pipeline — mirrorExtractionSession, mirrorSourcePreparation,
// mirrorSessionStorage, mirrorGarmentRegions, mirrorCropGeneration,
// mirrorPersonResolution, mirrorTelemetry and the real closetTelemetry sink —
// running over an in-memory filesystem and a controlled image manipulator.
// Only expo-file-system, expo-image-manipulator, expo-crypto and the actor
// context are doubled; everything above that boundary is production code.
//
// ── WHAT THE CONTROLLED EXTRACTOR PROVES, AND WHAT IT DOES NOT ──────────────
//
// It proves ORCHESTRATION: lifecycle, ordering, cancellation, retry, cleanup,
// retention, telemetry privacy, domain separation and the typed handoff.
//
// It proves NOTHING about extraction quality. Whether ML Kit and Apple Vision
// actually find a person and place their joints correctly can only be shown on
// physical hardware against real photographs, and no verdict in this build is
// based on this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CACHE = 'file:///app-cache/';

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

// ── in-memory filesystem ────────────────────────────────────────────────────

function memfs() {
  const files = new Map();
  const dirs = new Set();
  const api = {
    cacheDirectory: CACHE,
    documentDirectory: 'file:///doc/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync(dir) {
      dirs.add(dir);
    },
    async getInfoAsync(uri) {
      if (files.has(uri)) {
        return { exists: true, size: files.get(uri).length, modificationTime: 1_000 };
      }
      if (dirs.has(uri) || [...files.keys()].some((f) => f.startsWith(uri))) {
        return { exists: true, isDirectory: true, modificationTime: 1_000 };
      }
      return { exists: false };
    },
    async readDirectoryAsync(dir) {
      const names = new Set();
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(dir)) continue;
        const rest = key.slice(dir.length);
        const head = rest.split('/')[0];
        if (head) names.add(head);
      }
      return [...names];
    },
    async readAsStringAsync(uri) {
      if (!files.has(uri)) throw new Error('ENOENT');
      return files.get(uri).toString('base64');
    },
    async moveAsync({ from, to }) {
      if (!files.has(from)) throw new Error('ENOENT');
      files.set(to, files.get(from));
      files.delete(from);
    },
    async deleteAsync(uri) {
      files.delete(uri);
      dirs.delete(uri);
      for (const key of [...files.keys()]) if (key.startsWith(uri)) files.delete(key);
      for (const key of [...dirs]) if (key.startsWith(uri)) dirs.delete(key);
    },
    // test helpers
    __write(uri, buffer) {
      files.set(uri, buffer);
    },
    __has(uri) {
      return files.has(uri);
    },
    __list() {
      return [...files.keys()];
    },
    __count(prefix) {
      return [...files.keys()].filter((k) => k.startsWith(prefix)).length;
    },
  };
  return api;
}

/** A minimal JPEG carrying only the benign JFIF header. */
function cleanJpeg() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x0c]),
    Buffer.from('JFIF\0\0\0\0\0\0', 'latin1'),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
  ]);
}

/** A JPEG whose Exif APP1 declares a GPS IFD pointer. */
function gpsJpeg() {
  const header = Buffer.from('Exif\0\0', 'latin1');
  const tiff = Buffer.alloc(22);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8825, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(200, 18);
  const payload = Buffer.concat([header, tiff]);
  const len = payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]),
    payload,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
  ]);
}

/**
 * Controlled image manipulator.
 *
 * Writes a REAL, metadata-free JPEG byte stream for every operation, which is
 * what lets the pipeline's own metadata gate run for real in these tests
 * instead of being stubbed out.
 */
function manipulator(memory, options = {}) {
  let counter = 0;
  const calls = [];
  return {
    SaveFormat: { JPEG: 'jpeg' },
    calls,
    async manipulateAsync(uri, ops, opts) {
      calls.push({ uri, ops, opts });
      if (options.throwOn && options.throwOn(uri, ops)) throw new Error('decode failed');
      counter += 1;
      const out = `file:///os-cache/tmp-${counter}.jpg`;
      memory.__write(out, options.dirty ? gpsJpeg() : cleanJpeg());
      const crop = ops.find((o) => o.crop)?.crop;
      const resize = ops.find((o) => o.resize)?.resize;
      let width = options.sourceWidth ?? 1080;
      let height = options.sourceHeight ?? 1440;
      if (crop) {
        width = crop.width;
        height = crop.height;
      }
      if (resize?.width) {
        height = Math.round((height * resize.width) / width);
        width = resize.width;
      } else if (resize?.height) {
        width = Math.round((width * resize.height) / height);
        height = resize.height;
      }
      return { uri: out, width, height };
    },
  };
}

// ── module loader ───────────────────────────────────────────────────────────

function loadPipeline({ memory, manip, active = true, actorCurrent = () => true }) {
  const cache = new Map();
  let uuid = 0;
  const shims = {
    'expo-file-system/legacy': memory,
    'expo-file-system': memory,
    'expo-image-manipulator': manip,
    'expo-crypto': { randomUUID: () => `id-${(uuid += 1)}` },
    'react-native': { AppState: { addEventListener: () => ({ remove() {} }) } },
  };

  function load(rel) {
    if (cache.has(rel)) return cache.get(rel);
    const mod = { exports: {} };
    cache.set(rel, mod.exports);
    const requireShim = (request) => {
      if (shims[request]) return shims[request];
      if (request.includes('constants/featureFlags')) {
        return { MIRROR_SELFIE_V1_ACTIVE: active };
      }
      if (request.endsWith('actorContext')) {
        return { isActorRequestCurrent: actorCurrent, createActorRequest: () => actor };
      }
      if (request.startsWith('.')) {
        const resolved = path
          .relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), request))
          .split(path.sep)
          .join('/');
        for (const candidate of [`${resolved}.ts`, `${resolved}.js`, `${resolved}/index.ts`]) {
          if (fs.existsSync(path.join(ROOT, candidate))) return load(candidate);
        }
      }
      throw new Error(`Unexpected require: ${request} (from ${rel})`);
    };
    vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
      filename: rel,
    })(mod.exports, mod, requireShim);
    cache.set(rel, mod.exports);
    return mod.exports;
  }

  const actor = { actorId: 'actor-1', epoch: 1, requestId: 'req-1' };
  return {
    session: load('services/mirror/mirrorExtractionSession.ts'),
    storage: load('services/mirror/mirrorSessionStorage.ts'),
    adapter: load('services/mirror/mirrorExtractionAdapter.ts'),
    telemetry: load('services/closetTelemetry.ts'),
    contract: load('types/mirrorExtraction.ts'),
    actor,
  };
}

/** A standing figure with every joint reported confidently. */
const FULL_PERSON = {
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
    { type: 'left_ankle', x: 0.42, y: 0.9, confidence: 0.8 },
    { type: 'right_ankle', x: 0.58, y: 0.9, confidence: 0.8 },
  ],
};

const SOURCE = 'file:///picker/IMG_4821.jpg';

function harness(overrides = {}) {
  const memory = memfs();
  memory.__write(SOURCE, gpsJpeg()); // the picker's file HAS metadata
  const manip = manipulator(memory, overrides.manipulator ?? {});
  const loaded = loadPipeline({ memory, manip, ...overrides });
  const events = [];
  loaded.telemetry.setClosetTelemetrySink((event, payload) => events.push({ event, payload }));
  return { memory, manip, events, ...loaded };
}

function controlled(loaded, config) {
  return loaded.adapter.createControlledMirrorExtractionAdapter(config);
}

// ── MIRROR-CAMERA/GALLERY-SOURCE-CREATES-LOCAL-SESSION ──────────────────────

test('MIRROR-CAMERA-SOURCE-CREATES-LOCAL-SESSION and MIRROR-GALLERY-SOURCE-CREATES-LOCAL-SESSION', async () => {
  for (const sourceType of ['camera', 'gallery']) {
    const h = harness();
    const controller = h.session.createMirrorExtractionSession({
      adapter: controlled(h, { persons: [FULL_PERSON] }),
      actorRequest: h.actor,
    });
    await controller.extractFromSource({ sourceUri: SOURCE, sourceType, sourceWidth: 1080, sourceHeight: 1440 });
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.status, 'reviewing_crops');
    assert.equal(snapshot.sourceType, sourceType);
    assert.ok(snapshot.cropCount > 0);
    // The session id is a legal Step 1 staging id.
    assert.ok(h.contract.isValidMirrorSessionId(snapshot.extractionSessionId));
    // Provenance is carried truthfully, never asserted as camera for a pick.
    const selected = h.events.find((e) => e.event === 'mirror_selfie_source_selected');
    assert.equal(selected.payload.sourceType, sourceType);
  }
});

test('MIRROR-ORIENTATION-NORMALIZED: the source is re-encoded before anything reads it', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });

  // The FIRST manipulator call must be against the picker's URI: that decode is
  // what bakes EXIF orientation into the pixels and drops the metadata.
  assert.equal(h.manip.calls[0].uri, SOURCE);
  assert.equal(h.manip.calls[0].opts.format, 'jpeg');
  // No explicit rotate op — the decode already applied the orientation, and a
  // rotate would apply it a second time.
  assert.equal(h.manip.calls[0].ops.some((op) => op.rotate !== undefined), false);
  // Every crop is cut from the NORMALIZED copy, never from the picker's file.
  for (const call of h.manip.calls.filter((c) => c.ops.some((o) => o.crop))) {
    assert.notEqual(call.uri, SOURCE);
    assert.ok(call.uri.includes('kscan_mirror_sessions'));
  }
});

// ── validation ──────────────────────────────────────────────────────────────

test('MIRROR-UNREADABLE-SOURCE-REJECTED and MIRROR-CORRUPT-SOURCE-REJECTED', async () => {
  const missing = harness();
  const c1 = missing.session.createMirrorExtractionSession({
    adapter: controlled(missing, { persons: [FULL_PERSON] }),
    actorRequest: missing.actor,
  });
  await c1.extractFromSource({ sourceUri: 'file:///nope.jpg', sourceType: 'gallery' });
  assert.equal(c1.getSnapshot().errorCode, 'mirror_source_unreadable');

  const corrupt = harness({ manipulator: { throwOn: (uri) => uri === SOURCE } });
  const c2 = corrupt.session.createMirrorExtractionSession({
    adapter: controlled(corrupt, { persons: [FULL_PERSON] }),
    actorRequest: corrupt.actor,
  });
  await c2.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  assert.equal(c2.getSnapshot().errorCode, 'mirror_source_unsupported');
  // A source that failed validation leaves nothing behind.
  assert.equal(corrupt.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
});

test('MIRROR-SMALL-SOURCE-REJECTED: a tiny photo is refused at intake', async () => {
  const h = harness({ manipulator: { sourceWidth: 200, sourceHeight: 260 } });
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  // The picker's OWN dimensions. Without them a blind ceiling resize would
  // enlarge this photo and the guard would measure the enlargement.
  await controller.extractFromSource({
    sourceUri: SOURCE,
    sourceType: 'gallery',
    sourceWidth: 200,
    sourceHeight: 260,
  });
  assert.equal(controller.getSnapshot().errorCode, 'mirror_source_too_small');
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
});

test('MIRROR-NO-PERSON-RETURNS-BOUNDED-ERROR: a bounded, recoverable outcome', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.errorCode, 'mirror_no_person_detected');
  assert.equal(h.contract.isRecoverableMirrorError(snapshot.errorCode), true);
});

test('an unsupported runtime is NOT reported as "no person in this photo"', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { outcome: 'unsupported' }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  // Blaming the user's photograph for a missing binary would be a lie.
  assert.equal(controller.getSnapshot().errorCode, 'mirror_extraction_unsupported');
});

test('MIRROR-AMBIGUOUS-MULTI-PERSON-REQUIRES-SELECTION: the session stops and offers a choice', async () => {
  const h = harness();
  const second = {
    ...FULL_PERSON,
    rankingExtent: { x: 0.1, y: 0.06, width: 0.15, height: 0.12 },
  };
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON, second] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });

  let snapshot = controller.getSnapshot();
  assert.equal(snapshot.errorCode, 'mirror_multiple_people_ambiguous');
  assert.equal(snapshot.personChoices.length, 2);
  assert.equal(snapshot.cropCount, 0, 'no crop may exist before the user has chosen');

  await controller.choosePerson(0);
  snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, 'reviewing_crops');
  assert.equal(snapshot.personChoices, null);
  assert.ok(snapshot.cropCount > 0);
});

// ── crops ───────────────────────────────────────────────────────────────────

test('MIRROR-REAL-FIXTURE-PRODUCES-REAL-CROP-FILES and MIRROR-CROP-FILES-ARE-READABLE', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const snapshot = controller.getSnapshot();

  assert.ok(snapshot.crops.length >= 2);
  for (const crop of snapshot.crops) {
    // A real file at a session-owned path, not a record pointing at nothing.
    assert.equal(h.memory.__has(crop.cropUri), true);
    assert.ok(crop.cropUri.includes(`kscan_mirror_sessions/${snapshot.extractionSessionId}/crops/`));
    assert.ok(crop.cropWidth > 0 && crop.cropHeight > 0);
    assert.ok(h.contract.isValidMirrorCropKey(crop.cropKey));
  }
});

test('MIRROR-CROP-KEYS-DETERMINISTIC across a full re-run of the same source', async () => {
  const first = harness();
  const c1 = first.session.createMirrorExtractionSession({
    adapter: controlled(first, { persons: [FULL_PERSON] }),
    actorRequest: first.actor,
  });
  await c1.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });

  const second = harness();
  const c2 = second.session.createMirrorExtractionSession({
    adapter: controlled(second, { persons: [FULL_PERSON] }),
    actorRequest: second.actor,
  });
  await c2.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });

  assert.deepEqual(
    c1.getSnapshot().crops.map((c) => c.cropKey),
    c2.getSnapshot().crops.map((c) => c.cropKey),
  );
});

test('crops are encoded with the repository\'s authoritative candidate settings', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const cropCalls = h.manip.calls.filter((c) => c.ops.some((o) => o.crop));
  assert.ok(cropCalls.length > 0);
  for (const call of cropCalls) {
    assert.equal(call.opts.format, 'jpeg');
    assert.equal(call.opts.compress, 0.9);
    // No upscaling: a small region is not resized up to the 1440 ceiling.
    const crop = call.ops.find((o) => o.crop).crop;
    const resize = call.ops.find((o) => o.resize);
    if (crop.width <= 1440 && crop.height <= 1440) assert.equal(resize, undefined);
  }
});

// ── MIRROR-CROP-CONTAINS-NO-EXIF-METADATA ───────────────────────────────────

test('MIRROR-CROP-CONTAINS-NO-EXIF-METADATA and MIRROR-NORMALIZED-SOURCE-CONTAINS-NO-GPS-METADATA', async () => {
  // The manipulator is made to emit GPS-bearing output — i.e. the strip did not
  // happen. The pipeline must destroy the result rather than show it.
  const h = harness({ manipulator: { dirty: true } });
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });

  assert.equal(controller.getSnapshot().cropCount, 0);
  assert.equal(controller.getSnapshot().errorCode, 'mirror_source_unsupported');
  // Nothing metadata-bearing survives anywhere in the session tree.
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
});

test('MIRROR-ORIGINAL-EXTERNAL-FILE-IS-UNMODIFIED', async () => {
  const h = harness();
  const before = Buffer.from(h.memory.__has(SOURCE) ? gpsJpeg() : Buffer.alloc(0));
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  await controller.acceptSelection();
  // Still present, still byte-identical, still carrying its original metadata.
  assert.equal(h.memory.__has(SOURCE), true);
  assert.deepEqual(
    Buffer.from(await h.memory.readAsStringAsync(SOURCE), 'base64'),
    before,
  );
});

test('MIRROR-CROP-CONTAINS-NO-SOURCE-FILENAME', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  for (const crop of controller.getSnapshot().crops) {
    assert.ok(!crop.cropUri.includes('IMG_4821'));
    assert.ok(!crop.cropKey.includes('IMG_4821'));
  }
});

// ── capacity ────────────────────────────────────────────────────────────────

test('MIRROR-MORE-THAN-EIGHT-NOT-TRUNCATED and MIRROR-NINE-CROPS-STAY-SELECTABLE', async () => {
  // Nine people-sized regions is not physically meaningful; what IS meaningful
  // is that the session carries whatever the extractor produced without
  // trimming it. Regions are injected directly for that reason.
  const h = harness();
  const many = Array.from({ length: 9 }, (_, i) => ({
    regionClass: i === 0 ? 'upper_body' : i === 1 ? 'lower_body' : 'left_foot',
    // Disjoint columns so dedup cannot legitimately remove any of them.
    bounds: { x: i * 0.1, y: 0.1, width: 0.09, height: 0.3 },
    confidenceBucket: 'high',
  }));

  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
    // Substitute crop generation so exactly nine crops reach review.
    generateCrops: async (input) => {
      return {
        crops: many.map((region, index) => ({
          cropUri: `${CACHE}kscan_mirror_sessions/${input.extractionSessionId}/crops/c${index}.jpg`,
          cropKey: `s0_${region.regionClass}_${index}`,
          sourceImageIndex: 0,
          regionClass: region.regionClass,
          localBounds: region.bounds,
          localConfidenceBucket: 'high',
          cropWidth: 100,
          cropHeight: 200,
          selected: true,
        })),
        failedCount: 0,
      };
    },
  });

  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const snapshot = controller.getSnapshot();

  // All nine displayed, all nine selectable, true count reported.
  assert.equal(snapshot.cropCount, 9);
  assert.equal(snapshot.crops.length, 9);
  assert.equal(snapshot.selectedCount, 9);

  const selection = await controller.acceptSelection();
  // All nine returned, in order, UNPARTITIONED — Step 4 owns the eight limit.
  assert.equal(selection.crops.length, 9);
  assert.deepEqual(
    selection.crops.map((c) => c.cropKey),
    snapshot.crops.map((c) => c.cropKey),
  );
  // And the handoff carries ONLY the two staging fields.
  for (const crop of selection.crops) {
    assert.deepEqual(Object.keys(crop).sort(), ['cropKey', 'cropUri']);
  }
});

// ── review ──────────────────────────────────────────────────────────────────

test('MIRROR-CROP-CAN-BE-DESELECTED', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const first = controller.getSnapshot().crops[0];

  controller.setCropSelected(first.cropKey, false);
  assert.equal(controller.getSnapshot().crops[0].selected, false);
  // Deselected is NOT deleted — the user can change their mind.
  assert.equal(h.memory.__has(first.cropUri), true);

  const selection = await controller.acceptSelection();
  assert.ok(!selection.crops.some((c) => c.cropKey === first.cropKey));
  // Only once the selection is accepted does the rejected file go.
  assert.equal(h.memory.__has(first.cropUri), false);
});

test('MIRROR-BAD-CROP-CAN-BE-DISCARDED: discard deletes immediately', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const before = controller.getSnapshot();
  const target = before.crops[0];

  await controller.discardCrop(target.cropKey);
  const after = controller.getSnapshot();
  assert.equal(after.cropCount, before.cropCount - 1);
  assert.equal(h.memory.__has(target.cropUri), false);
});

test('MIRROR-RETRY-REPLACES-OLD-CROPS: no obsolete file survives a retry', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const firstRun = controller.getSnapshot().crops.map((c) => c.cropUri);

  await controller.retry();
  const secondRun = controller.getSnapshot().crops.map((c) => c.cropUri);

  assert.equal(secondRun.length, firstRun.length);
  for (const uri of firstRun) {
    assert.equal(h.memory.__has(uri), false, 'a pre-retry crop file survived');
    assert.equal(secondRun.includes(uri), false, 'a pre-retry crop leaked into the new result');
  }
  for (const uri of secondRun) assert.equal(h.memory.__has(uri), true);
});

// ── cancellation and cleanup ────────────────────────────────────────────────

test('MIRROR-CANCEL-CLEANS-SESSION: source and crops both go', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  assert.ok(h.memory.__count(`${CACHE}kscan_mirror_sessions`) > 0);

  await controller.cancel();
  assert.equal(controller.getSnapshot().status, 'cancelled');
  assert.equal(controller.getSnapshot().cropCount, 0);
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
});

test('MIRROR-LATE-INFERENCE-RESULT-CANNOT-REVIVE-CANCELLED-SESSION', async () => {
  const h = harness();
  const deferred = controlled(h, { persons: [FULL_PERSON], deferred: true });
  const controller = h.session.createMirrorExtractionSession({
    adapter: deferred,
    actorRequest: h.actor,
  });

  const running = controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  // Wait for detection to be genuinely in flight before cancelling.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await controller.cancel();
  assert.equal(controller.getSnapshot().status, 'cancelled');

  // The native runtime finishes AFTER the cancel, as ML Kit and Vision both do.
  deferred.release();
  await running;

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, 'cancelled', 'a late result revived a cancelled session');
  assert.equal(snapshot.cropCount, 0);
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0, 'a late run left files behind');
});

test('MIRROR-ACTOR-CHANGE-CANCELS-EXTRACTION', async () => {
  let current = true;
  const h = harness({ actorCurrent: () => current });
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
    isActorCurrent: () => current,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  assert.equal(controller.getSnapshot().status, 'reviewing_crops');

  current = false; // sign-out / account switch
  const selection = await controller.acceptSelection();

  assert.equal(selection, null, 'crops were handed to the wrong actor');
  assert.equal(controller.getSnapshot().status, 'cancelled');
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
});

test('an actor change before any work refuses to start the session at all', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
    isActorCurrent: () => false,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  assert.equal(controller.getSnapshot().errorCode, 'mirror_actor_changed');
  // Not one byte was copied.
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
});

test('MIRROR-ZERO-APPROVED-CROPS-CLEANS-SESSION', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  for (const crop of controller.getSnapshot().crops) {
    controller.setCropSelected(crop.cropKey, false);
  }

  const selection = await controller.acceptSelection();
  // A legitimate user choice, not a system error.
  assert.equal(selection, null);
  assert.equal(controller.getSnapshot().status, 'completed');
  assert.equal(controller.getSnapshot().errorCode, null);
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
  const review = h.events.find((e) => e.event === 'mirror_selfie_crop_review_completed');
  assert.equal(review.payload.outcome, 'zero_selected');
});

// ── retention ───────────────────────────────────────────────────────────────

test('RETENTION: the normalized selfie dies at accept; approved crops survive', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const id = controller.getSnapshot().extractionSessionId;
  const sourcePrefix = `${CACHE}kscan_mirror_sessions/${id}/normalized_source`;
  assert.ok(h.memory.__count(sourcePrefix) > 0, 'the normalized source should exist during review');

  const selection = await controller.acceptSelection();

  // The photograph of the user's body has the shortest life of anything here.
  assert.equal(h.memory.__count(sourcePrefix), 0, 'the normalized selfie outlived crop selection');
  // The crops they chose are still readable for Step 4.
  for (const crop of selection.crops) assert.equal(h.memory.__has(crop.cropUri), true);
});

test('MIRROR-STALE-SESSION-FILES-CLEANED: expiry sweeps only the Mirror namespace', async () => {
  const h = harness();
  h.memory.__write(`${CACHE}kscan_mirror_sessions/old-session/crops/a.jpg`, cleanJpeg());
  h.memory.__write(`${CACHE}kscan_mirror_sessions/keep-session/crops/b.jpg`, cleanJpeg());
  // A neighbouring namespace that must not be touched.
  h.memory.__write(`${CACHE}kscan-privacy/orig-1.jpg`, cleanJpeg());

  const ttl = h.contract.MIRROR_SESSION_MAX_TTL_MS;
  const result = await h.storage.reconcileStaleMirrorSessions({
    nowMs: 1_000_000 + ttl * 2,
    keepSessionIds: ['keep-session'],
  });

  assert.ok(result.deleted >= 1);
  assert.equal(h.memory.__has(`${CACHE}kscan_mirror_sessions/old-session/crops/a.jpg`), false);
  assert.equal(h.memory.__has(`${CACHE}kscan_mirror_sessions/keep-session/crops/b.jpg`), true);
  assert.equal(h.memory.__has(`${CACHE}kscan-privacy/orig-1.jpg`), true);
});

test('the approved-crop TTL is the candidate TTL, not a second invented clock', () => {
  const contract = require('node:fs').readFileSync(
    path.join(ROOT, 'types/mirrorExtraction.ts'),
    'utf8',
  );
  assert.ok(
    /CLOSET_CANDIDATE_TTL_MS as MIRROR_SESSION_MAX_TTL_MS/.test(contract),
    'Mirror must re-export the candidate TTL rather than restate a duration',
  );
  assert.ok(!/24 \* 60 \* 60 \* 1000/.test(contract), 'a hard-coded 24-hour TTL was introduced');
});

// ── telemetry privacy ───────────────────────────────────────────────────────

test('MIRROR-TELEMETRY-CONTAINS-NO-URI and MIRROR-TELEMETRY-CONTAINS-NO-COORDINATES', async () => {
  const h = harness();
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });
  const snapshot = controller.getSnapshot();
  await controller.acceptSelection();

  assert.ok(h.events.length >= 4, 'the pipeline should have emitted its lifecycle events');

  const serialized = JSON.stringify(h.events);
  for (const forbidden of ['file://', 'content://', 'IMG_4821', '.jpg', 'kscan_mirror_sessions']) {
    assert.ok(!serialized.includes(forbidden), `telemetry leaked ${forbidden}`);
  }
  // No session id, no crop key, no actor id.
  assert.ok(!serialized.includes(snapshot.extractionSessionId));
  for (const crop of snapshot.crops) assert.ok(!serialized.includes(crop.cropKey));
  assert.ok(!serialized.includes('actor-1'));

  // No coordinate or dimension survives: every numeric property is a count.
  for (const { payload } of h.events) {
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== 'number') continue;
      assert.ok(Number.isInteger(value), `${key} carried a non-integer (${value})`);
      assert.ok(value >= 0 && value <= 64, `${key} carried an unbounded number (${value})`);
    }
  }
});

test('open-ended buckets survive the telemetry scrub (a "9+" would be dropped silently)', () => {
  const h = harness();
  const mirrorTelemetry = (() => {
    // Loaded through the same shim graph so it uses the real sink.
    return h.session; // sessions emit through mirrorTelemetry already
  })();
  h.events.length = 0;
  h.telemetry.emitClosetCandidateEvent('mirror_selfie_extraction_completed', {
    cropCountBucket: '9_plus',
    personCountBucket: '2_plus',
    durationBucket: 'over_60s',
  });
  const payload = h.events[0].payload;
  assert.equal(payload.cropCountBucket, '9_plus');
  assert.equal(payload.personCountBucket, '2_plus');
  assert.equal(payload.durationBucket, 'over_60s');

  // The trap this guards: `+` is not in the scrub's allowlist.
  h.events.length = 0;
  h.telemetry.emitClosetCandidateEvent('mirror_selfie_extraction_completed', {
    cropCountBucket: '9+',
  });
  assert.equal(h.events[0].payload.cropCountBucket, undefined);
});

// ── the master gate ─────────────────────────────────────────────────────────

test('MIRROR-UI-UNREACHABLE-WHEN-FLAG-FALSE: the session refuses to run', async () => {
  const h = harness({ active: false });
  const controller = h.session.createMirrorExtractionSession({
    adapter: controlled(h, { persons: [FULL_PERSON] }),
    actorRequest: h.actor,
  });
  await controller.extractFromSource({ sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 });

  assert.equal(controller.getSnapshot().errorCode, 'mirror_extraction_unsupported');
  assert.equal(controller.getSnapshot().cropCount, 0);
  // No file was read, written, or copied.
  assert.equal(h.manip.calls.length, 0);
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
});
