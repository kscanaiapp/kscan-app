// iOS extraction pipeline: privacy and stale-result containment (Build 2.5 Step 3B).
//
// Runs the REAL shared pipeline against an adapter shaped like the ACTUAL iOS
// native payload — including `maskCoverage`, which Android never sends, and
// which is therefore the one field these tests can exercise that the Android
// suite structurally cannot.
//
// ── EVIDENCE BOUNDARY ───────────────────────────────────────────────────────
//
// What is proved here is the pipeline's behaviour ON the iOS payload shape:
// metadata is inspected and enforced, the external file is untouched, filenames
// never reach a crop, and a late native result cannot revive a cancelled
// session.
//
// What is NOT proved, and is not claimed: that Apple Vision produces that
// payload correctly on hardware. Real native inspection is DEFERRED — see the
// Step 3B report. A green run here is not device evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CACHE = 'file:///app-cache/';
const SOURCE = 'file:///picker/IMG_4821.HEIC.jpg';

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

function memfs() {
  const files = new Map();
  const dirs = new Set();
  return {
    cacheDirectory: CACHE,
    documentDirectory: 'file:///doc/',
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    async makeDirectoryAsync(dir) {
      dirs.add(dir);
    },
    async getInfoAsync(uri) {
      if (files.has(uri)) return { exists: true, size: files.get(uri).length, modificationTime: 1000 };
      if (dirs.has(uri) || [...files.keys()].some((f) => f.startsWith(uri))) {
        return { exists: true, isDirectory: true, modificationTime: 1000 };
      }
      return { exists: false };
    },
    async readDirectoryAsync(dir) {
      const names = new Set();
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(dir)) {
          const head = key.slice(dir.length).split('/')[0];
          if (head) names.add(head);
        }
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
      for (const k of [...files.keys()]) if (k.startsWith(uri)) files.delete(k);
      for (const k of [...dirs]) if (k.startsWith(uri)) dirs.delete(k);
    },
    __write: (uri, buf) => files.set(uri, buf),
    __has: (uri) => files.has(uri),
    __read: (uri) => files.get(uri),
    __count: (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)).length,
  };
}

/** Metadata-free JPEG: SOI + JFIF APP0 + SOS + EOI. */
function cleanJpeg() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x0c]),
    Buffer.from('JFIF\0\0\0\0\0\0', 'latin1'),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
  ]);
}

/** JPEG whose Exif APP1 declares a GPS IFD pointer — what a real selfie carries. */
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

function manipulator(memory, { dirty = false } = {}) {
  let n = 0;
  const calls = [];
  return {
    SaveFormat: { JPEG: 'jpeg' },
    calls,
    async manipulateAsync(uri, ops, opts) {
      calls.push({ uri, ops, opts });
      n += 1;
      const out = `file:///os-cache/tmp-${n}.jpg`;
      memory.__write(out, dirty ? gpsJpeg() : cleanJpeg());
      const crop = ops.find((o) => o.crop)?.crop;
      const resize = ops.find((o) => o.resize)?.resize;
      let width = crop ? crop.width : 1080;
      let height = crop ? crop.height : 1440;
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

function harness({ dirty = false } = {}) {
  const memory = memfs();
  memory.__write(SOURCE, gpsJpeg());
  const manip = manipulator(memory, { dirty });
  const actor = { actorId: 'actor-1', epoch: 1, requestId: 'req-1' };
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
    const req = (request) => {
      if (shims[request]) return shims[request];
      if (request.includes('constants/featureFlags')) return { MIRROR_SELFIE_V1_ACTIVE: true };
      if (request.endsWith('actorContext')) {
        return { isActorRequestCurrent: () => true, createActorRequest: () => actor };
      }
      if (request.startsWith('.')) {
        const resolved = path
          .relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), request))
          .split(path.sep)
          .join('/');
        for (const c of [`${resolved}.ts`, `${resolved}.js`]) {
          if (fs.existsSync(path.join(ROOT, c))) return load(c);
        }
      }
      throw new Error(`Unexpected require: ${request}`);
    };
    vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
      filename: rel,
    })(mod.exports, mod, req);
    cache.set(rel, mod.exports);
    return mod.exports;
  }
  const telemetry = load('services/closetTelemetry.ts');
  const events = [];
  telemetry.setClosetTelemetrySink((event, payload) => events.push({ event, payload }));
  return {
    memory,
    manip,
    events,
    actor,
    session: load('services/mirror/mirrorExtractionSession.ts'),
    adapter: load('services/mirror/mirrorExtractionAdapter.ts'),
  };
}

/**
 * A person exactly as the iOS native layer emits one.
 *
 * `maskCoverage` is present and numeric — Android sends the key absent — so
 * these tests exercise the one field shape the Android suite cannot reach.
 * `rankingExtent === bounds` because Vision enumerates people directly.
 */
const IOS_PERSON = {
  bounds: { x: 0.28, y: 0.06, width: 0.44, height: 0.9 },
  rankingExtent: { x: 0.28, y: 0.06, width: 0.44, height: 0.9 },
  confidence: 0.92,
  maskCoverage: 0.71,
  landmarks: [
    { type: 'nose', x: 0.5, y: 0.11, confidence: 0.93 },
    { type: 'left_shoulder', x: 0.4, y: 0.21, confidence: 0.91 },
    { type: 'right_shoulder', x: 0.6, y: 0.21, confidence: 0.9 },
    { type: 'left_hip', x: 0.43, y: 0.51, confidence: 0.88 },
    { type: 'right_hip', x: 0.57, y: 0.51, confidence: 0.87 },
    { type: 'left_knee', x: 0.44, y: 0.71, confidence: 0.83 },
    { type: 'right_knee', x: 0.56, y: 0.71, confidence: 0.82 },
    { type: 'left_ankle', x: 0.43, y: 0.91, confidence: 0.78 },
    { type: 'right_ankle', x: 0.57, y: 0.91, confidence: 0.77 },
  ],
};

function start(h, config) {
  return h.session.createMirrorExtractionSession({
    adapter: h.adapter.createControlledMirrorExtractionAdapter(config),
    actorRequest: h.actor,
  });
}

const RUN = { sourceUri: SOURCE, sourceType: 'gallery', sourceWidth: 1080, sourceHeight: 1440 };

// ── privacy ─────────────────────────────────────────────────────────────────

test('MIRROR-IOS-NORMALIZED-SOURCE-CONTAINS-NO-EXIF', async () => {
  const h = harness();
  const controller = start(h, { persons: [IOS_PERSON] });
  await controller.extractFromSource(RUN);

  const id = controller.getSnapshot().extractionSessionId;
  const sourceDir = `${CACHE}kscan_mirror_sessions/${id}/normalized_source/`;
  const copies = [...Array(64).keys()]
    .map((i) => `${sourceDir}id-${i}.jpg`)
    .filter((uri) => h.memory.__has(uri));
  assert.ok(copies.length > 0, 'no app-owned normalized copy was produced');

  for (const uri of copies) {
    const bytes = h.memory.__read(uri);
    // No Exif APP1 marker anywhere in the segment chain.
    assert.equal(bytes.includes(Buffer.from('Exif\0\0', 'latin1')), false, `${uri} carries Exif`);
    assert.equal(bytes[2] === 0xff && bytes[3] === 0xe1, false, `${uri} begins with an APP1 segment`);
  }
});

test('MIRROR-IOS-CROP-CONTAINS-NO-EXIF', async () => {
  const h = harness();
  const controller = start(h, { persons: [IOS_PERSON] });
  await controller.extractFromSource(RUN);

  const crops = controller.getSnapshot().crops;
  assert.ok(crops.length > 0);
  for (const crop of crops) {
    const bytes = h.memory.__read(crop.cropUri);
    assert.ok(bytes, `${crop.cropKey} has no file`);
    assert.equal(bytes.includes(Buffer.from('Exif\0\0', 'latin1')), false);
  }
});

test('MIRROR-IOS-CROP-CONTAINS-NO-EXIF: a crop that DOES carry metadata is destroyed', async () => {
  // The gate is fail-closed, and this is the case that proves it is a gate at
  // all rather than a description of what the manipulator happens to do.
  const h = harness({ dirty: true });
  const controller = start(h, { persons: [IOS_PERSON] });
  await controller.extractFromSource(RUN);

  assert.equal(controller.getSnapshot().cropCount, 0);
  assert.equal(h.memory.__count(`${CACHE}kscan_mirror_sessions`), 0);
});

test('MIRROR-IOS-CROP-CONTAINS-NO-SOURCE-FILENAME', async () => {
  const h = harness();
  const controller = start(h, { persons: [IOS_PERSON] });
  await controller.extractFromSource(RUN);

  // The picker filename here is deliberately distinctive, including the HEIC
  // stem an iOS gallery pick routinely carries.
  for (const crop of controller.getSnapshot().crops) {
    assert.ok(!crop.cropUri.includes('IMG_4821'), 'the crop path carries the source filename');
    assert.ok(!crop.cropUri.toUpperCase().includes('HEIC'));
    assert.ok(!crop.cropKey.includes('IMG_4821'));
    const bytes = h.memory.__read(crop.cropUri);
    assert.equal(bytes.includes(Buffer.from('IMG_4821', 'latin1')), false);
  }
});

test('MIRROR-IOS-EXTERNAL-FILE-REMAINS-UNMODIFIED', async () => {
  const h = harness();
  const before = Buffer.from(h.memory.__read(SOURCE));
  const controller = start(h, { persons: [IOS_PERSON] });
  await controller.extractFromSource(RUN);
  await controller.acceptSelection();

  assert.ok(h.memory.__has(SOURCE), 'the picker-owned file was consumed');
  assert.deepEqual(h.memory.__read(SOURCE), before, 'the picker-owned file was rewritten');
  // Still carrying its original GPS — we never touched it, we just never used it.
  assert.ok(h.memory.__read(SOURCE).includes(Buffer.from('Exif\0\0', 'latin1')));

  // The manipulator opened it exactly once, to produce the normalized copy.
  const reads = h.manip.calls.filter((c) => c.uri === SOURCE);
  assert.equal(reads.length, 1, `the external file was decoded ${reads.length} times`);
});

// ── stale-result containment ────────────────────────────────────────────────

test('MIRROR-IOS-LATE-NATIVE-RESULT-CANNOT-REVIVE-CANCELLED-SESSION', async () => {
  // Vision cannot be interrupted mid-request, so a cancel during inference is
  // ALWAYS followed by a native completion. This is that sequence.
  const h = harness();
  const deferred = h.adapter.createControlledMirrorExtractionAdapter({
    persons: [IOS_PERSON],
    deferred: true,
  });
  const controller = h.session.createMirrorExtractionSession({
    adapter: deferred,
    actorRequest: h.actor,
  });

  const running = controller.extractFromSource(RUN);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(deferred.callCount(), 1, 'detection should be in flight before the cancel');

  await controller.cancel();
  assert.equal(controller.getSnapshot().status, 'cancelled');

  // Vision finishes AFTER the user already moved on.
  deferred.release();
  await running;

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, 'cancelled', 'a late native result revived a cancelled session');
  assert.equal(snapshot.cropCount, 0);
  assert.equal(snapshot.personChoices, null);
  assert.equal(
    h.memory.__count(`${CACHE}kscan_mirror_sessions`),
    0,
    'a late native run left files behind',
  );
});

test('a late native result cannot resurrect a session the user replaced', async () => {
  const h = harness();
  const slow = h.adapter.createControlledMirrorExtractionAdapter({
    persons: [IOS_PERSON],
    deferred: true,
  });
  const first = h.session.createMirrorExtractionSession({ adapter: slow, actorRequest: h.actor });
  const firstRun = first.extractFromSource(RUN);
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The user backs out and starts again with a different photo.
  await first.cancel();
  const second = start(h, { persons: [IOS_PERSON] });
  await second.extractFromSource(RUN);
  const liveCount = second.getSnapshot().cropCount;
  assert.ok(liveCount > 0);

  slow.release();
  await firstRun;

  // The abandoned session contributed nothing and left nothing.
  assert.equal(first.getSnapshot().cropCount, 0);
  assert.equal(second.getSnapshot().cropCount, liveCount);
  for (const crop of second.getSnapshot().crops) {
    assert.ok(h.memory.__has(crop.cropUri), 'the live session lost a crop');
  }
});

// ── the iOS-only payload field ──────────────────────────────────────────────

test('maskCoverage may only DEMOTE confidence — it never changes which regions exist', async () => {
  const good = harness();
  const goodController = start(good, { persons: [{ ...IOS_PERSON, maskCoverage: 0.8 }] });
  await goodController.extractFromSource(RUN);

  const poor = harness();
  const poorController = start(poor, { persons: [{ ...IOS_PERSON, maskCoverage: 0.05 }] });
  await poorController.extractFromSource(RUN);

  const absent = harness();
  const absentController = start(absent, { persons: [{ ...IOS_PERSON, maskCoverage: null }] });
  await absentController.extractFromSource(RUN);

  const classes = (c) => c.getSnapshot().crops.map((x) => x.regionClass);
  // Same regions, same order, on all three — this is the Android/iOS parity
  // guarantee: a platform without a mask emits the same crop set.
  assert.deepEqual(classes(goodController), classes(poorController));
  assert.deepEqual(classes(goodController), classes(absentController));

  const buckets = (c) => c.getSnapshot().crops.map((x) => x.localConfidenceBucket);
  // Absence is neutral: it must match the GOOD-mask result, not the poor one.
  assert.deepEqual(buckets(absentController), buckets(goodController));
  // And a poor mask only ever moves a bucket toward review.
  const poorBuckets = buckets(poorController);
  buckets(goodController).forEach((bucket, i) => {
    if (bucket === 'high') assert.ok(['high', 'review'].includes(poorBuckets[i]));
  });
  assert.ok(poorBuckets.some((b) => b === 'review'), 'a poor mask demoted nothing');
});

test('no mask, coordinate or raw native output reaches telemetry', async () => {
  const h = harness();
  const controller = start(h, { persons: [IOS_PERSON] });
  await controller.extractFromSource(RUN);
  const snapshot = controller.getSnapshot();
  await controller.acceptSelection();

  const serialized = JSON.stringify(h.events);
  for (const forbidden of ['file://', 'IMG_4821', '.jpg', 'maskCoverage', 'rankingExtent', 'landmark']) {
    assert.ok(!serialized.includes(forbidden), `telemetry leaked ${forbidden}`);
  }
  assert.ok(!serialized.includes(snapshot.extractionSessionId));
  for (const crop of snapshot.crops) assert.ok(!serialized.includes(crop.cropKey));
  // The mask value itself, and every coordinate, must be absent as a NUMBER too.
  for (const { payload } of h.events) {
    for (const value of Object.values(payload)) {
      if (typeof value !== 'number') continue;
      assert.ok(Number.isInteger(value), `a non-integer (${value}) reached telemetry`);
    }
  }
});
