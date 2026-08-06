// THUMBNAIL DERIVATIVE QUALITY (Build 25 Phase 2, BUG-05).
//
// Patterned garments were unrecognisable in every card because the thumbnail
// derivative was generated at 160px while the card that renders it is ~176dp
// wide — between 450 and 620 DEVICE pixels once Android's pixel ratio is
// applied. The bitmap was being upscaled 3-4x, and stripes, plaid and small
// repeating prints are exactly the content that cannot survive that: the detail
// is aliased away at encode time and no upscale restores it. q0.8 then applied
// JPEG quantization at a scale where one block covers ~5% of the frame.
//
// These assert the CONFIGURATION the pipeline runs with, by observing the real
// manipulateAsync calls the real media modules make. There is no image decoder
// in this environment, so "the stripes survived" is a runtime/visual check —
// what is provable here is that the derivative is large enough and encoded well
// enough for them to survive, which is precisely what regressed.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

// The smallest derivative that still covers the widest card on the densest
// shipping Android device: 176dp (a Library grid card on a 412dp screen) x 3.5.
const MIN_THUMB_WIDTH = 616;
// Below this, quantization artifacts become visible on woven and printed fabric
// at thumbnail scale.
const MIN_THUMB_COMPRESS = 0.85;

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

function runModule(rel, requireShim) {
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {\n${transpile(rel)}\n})`, {
    filename: rel,
  })(mod.exports, mod, requireShim);
  return mod.exports;
}

function memfs() {
  const files = new Map();
  return {
    files,
    api: {
      documentDirectory: '/doc/',
      EncodingType: { UTF8: 'utf8', Base64: 'base64' },
      async makeDirectoryAsync() {},
      async getInfoAsync(p) {
        if (!files.has(p)) return { exists: false };
        return {
          exists: true,
          size: Buffer.from(String(files.get(p)), 'utf8').length,
          modificationTime: 0,
        };
      },
      async readAsStringAsync(p) {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      async writeAsStringAsync(p, c) {
        files.set(p, c);
      },
      async moveAsync({ from, to }) {
        if (!files.has(from)) throw new Error('ENOENT');
        files.set(to, files.get(from));
        files.delete(from);
      },
      async copyAsync({ from, to }) {
        files.set(to, files.get(from));
      },
      async deleteAsync(p) {
        files.delete(p);
      },
      async readDirectoryAsync() {
        return [];
      },
      async getFreeDiskStorageAsync() {
        return 10 * 1024 * 1024 * 1024;
      },
    },
  };
}

/** Records every derivative the pipeline asks for. */
function recordingManipulator(m) {
  const calls = [];
  let n = 0;
  return {
    calls,
    api: {
      SaveFormat: { JPEG: 'jpeg' },
      manipulateAsync: async (uri, actions, options) => {
        const out = `/cache/derivative-${++n}.jpg`;
        m.files.set(out, Buffer.from(`derived(${uri})`).toString('base64'));
        calls.push({
          uri,
          width: actions?.[0]?.resize?.width ?? null,
          compress: options?.compress ?? null,
          format: options?.format ?? null,
        });
        return { uri: out };
      },
    },
  };
}

function load() {
  const m = memfs();
  const manip = recordingManipulator(m);
  const actorContext = runModule('services/actorContext.js', () => ({}));
  const shim = (spec) => {
    if (spec === 'expo-file-system/legacy') return m.api;
    if (spec === 'expo-image-manipulator') return manip.api;
    if (spec === 'react-native') return { Platform: { OS: 'android' } };
    if (spec === './actorContext') return actorContext;
    // Local save commits before this runs and must never be rolled back by it,
    // but an unstubbed module throws into saveScan's own catch and looks like a
    // failed save.
    if (spec === './savedScansCloud') {
      return { saveScanToCloud: async () => null, softDeleteCloudSavedScan: async () => null };
    }
    if (spec === './identificationSnapshot') return { hydrateScanHistory: (rows) => rows };
    if (spec === './purchaseOptions') {
      return { isPurchaseOptionsSnapshot: () => false, normalizePurchaseOptions: () => [] };
    }
    return {};
  };
  const library = runModule('services/library.js', shim);
  const closetLibrary = runModule('services/closetLibrary.js', (spec) =>
    spec === './library' ? library : shim(spec),
  );
  return { m, manip, actorContext, library, closetLibrary };
}

/** The derivative a card renders, i.e. the smallest one produced. */
function thumbnailCall(calls) {
  assert.ok(calls.length >= 2, 'expected a full image and a thumbnail derivative');
  return calls.reduce((min, call) => (call.width < min.width ? call : min));
}

// ── The committed Closet ─────────────────────────────────────────────────────

test('a Closet item thumbnail is generated large enough for the card that renders it', async () => {
  const env = load();
  env.m.files.set('/picked/plaid.jpg', Buffer.from('plaid').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');

  const result = await env.closetLibrary.createClosetItem({
    sourceUri: '/picked/plaid.jpg',
    draft: { title: 'Plaid Shirt', category: 'Tops' },
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  assert.equal(result.ok, true);

  const thumb = thumbnailCall(env.manip.calls);
  assert.ok(
    thumb.width >= MIN_THUMB_WIDTH,
    `thumbnail width ${thumb.width} upscales on a real card; need >= ${MIN_THUMB_WIDTH}`,
  );
  assert.ok(
    thumb.compress >= MIN_THUMB_COMPRESS,
    `thumbnail compress ${thumb.compress} blocks patterned fabric; need >= ${MIN_THUMB_COMPRESS}`,
  );
});

test('the full image is still the larger derivative and is not degraded', async () => {
  const env = load();
  env.m.files.set('/picked/plaid.jpg', Buffer.from('plaid').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');
  await env.closetLibrary.createClosetItem({
    sourceUri: '/picked/plaid.jpg',
    draft: { title: 'Plaid Shirt', category: 'Tops' },
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });

  const full = env.manip.calls.reduce((max, c) => (c.width > max.width ? c : max));
  assert.equal(full.width, 1440, 'the source-quality derivative is unchanged');
  assert.ok(full.compress >= 0.9);
  assert.ok(
    full.width > thumbnailCall(env.manip.calls).width,
    'the thumbnail must stay a thumbnail, not become a second full image',
  );
});

test('every derivative is produced from the ORIGINAL, never from another derivative', async () => {
  const env = load();
  env.m.files.set('/picked/plaid.jpg', Buffer.from('plaid').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');
  await env.closetLibrary.createClosetItem({
    sourceUri: '/picked/plaid.jpg',
    draft: { title: 'Plaid Shirt', category: 'Tops' },
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });

  for (const call of env.manip.calls) {
    assert.equal(
      call.uri,
      '/picked/plaid.jpg',
      'a derivative of a derivative would compound the loss it exists to avoid',
    );
  }
});

// ── Recent Scans ─────────────────────────────────────────────────────────────

test('a Recent Scan thumbnail uses the same contract as the Closet', async () => {
  const env = load();
  env.m.files.set('/picked/stripes.jpg', Buffer.from('stripes').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');

  const saved = await env.library.saveScan({
    photoUri: '/picked/stripes.jpg',
    analysis: { result: 'A striped shirt', metadata: {}, products: [] },
    source: 'camera',
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });
  assert.ok(saved, 'the scan saved');

  const thumb = thumbnailCall(env.manip.calls);
  assert.ok(thumb.width >= MIN_THUMB_WIDTH);
  assert.ok(thumb.compress >= MIN_THUMB_COMPRESS);
});

// ── The three stores must not drift apart ────────────────────────────────────

test('all three media stores declare the same thumbnail contract', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const widths = new Set();
  const compressions = new Set();

  for (const rel of [
    'services/library.js',
    'services/closetLibrary.js',
    'services/closetCandidateMedia.js',
  ]) {
    const source = read(rel);
    const width = source.match(/const THUMB_WIDTH\s*=\s*(\d+)/);
    const compress = source.match(/const THUMB_COMPRESS\s*=\s*([\d.]+)/);
    assert.ok(width, `${rel} must declare THUMB_WIDTH`);
    assert.ok(compress, `${rel} must declare THUMB_COMPRESS`);
    widths.add(width[1]);
    compressions.add(compress[1]);
  }

  // A candidate derivative smaller than the Closet's would silently downgrade
  // every promoted item, which is why these are pinned together.
  assert.equal(widths.size, 1, `thumbnail widths drifted apart: ${[...widths].join(', ')}`);
  assert.equal(compressions.size, 1, `thumbnail quality drifted: ${[...compressions].join(', ')}`);
  assert.ok(Number([...widths][0]) >= MIN_THUMB_WIDTH);
  assert.ok(Number([...compressions][0]) >= MIN_THUMB_COMPRESS);
});

test('a thumbnail failure is survivable and does not lose the item', async () => {
  const env = load();
  env.m.files.set('/picked/plaid.jpg', Buffer.from('plaid').toString('base64'));
  env.actorContext.advanceActorEpoch('user-a');

  let call = 0;
  const inner = env.manip.api.manipulateAsync;
  env.manip.api.manipulateAsync = async (uri, actions, options) => {
    call += 1;
    // Fail only the smaller (thumbnail) derivative.
    if (actions?.[0]?.resize?.width < 1440) throw new Error('decode failed');
    return inner(uri, actions, options);
  };

  const result = await env.closetLibrary.createClosetItem({
    sourceUri: '/picked/plaid.jpg',
    draft: { title: 'Plaid Shirt', category: 'Tops' },
    actorRequest: env.actorContext.createActorRequest(),
    ownerId: 'user-a',
  });

  assert.equal(result.ok, true, 'the item survives a thumbnail failure');
  assert.equal(result.item.thumbnailUri, null, 'and reports honestly that it has none');
  assert.ok(result.item.imageUri, 'the full image is what the card falls back to');
  assert.ok(call > 1);
});

// ── Negative control ─────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: the pre-repair 160px / q0.8 configuration fails these gates', () => {
  // The exact values Phase 1 shipped. If someone restores them — in any one of
  // the three stores — the assertions above are what catches it.
  const PRE_REPAIR_WIDTH = 160;
  const PRE_REPAIR_COMPRESS = 0.8;

  assert.equal(
    PRE_REPAIR_WIDTH >= MIN_THUMB_WIDTH,
    false,
    'a 160px derivative must not satisfy the width gate',
  );
  assert.equal(
    PRE_REPAIR_COMPRESS >= MIN_THUMB_COMPRESS,
    false,
    'q0.8 must not satisfy the quality gate',
  );

  // And it really was 3-4x too small for the surface that renders it.
  const CARD_DP = 176; // floor((412 - 24*2 - 12) / 2)
  for (const dpr of [2.625, 3.0, 3.5]) {
    assert.ok(
      CARD_DP * dpr > PRE_REPAIR_WIDTH * 2,
      `at ${dpr}x the old thumbnail was upscaled more than 2x`,
    );
  }
});
