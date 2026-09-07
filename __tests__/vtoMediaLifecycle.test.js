/**
 * RP-107 -- shipping VTO photo media lifecycle.
 *
 * Four defects, one theme: a derivative that was bigger than it claimed to be,
 * or that outlived the operation that made it.
 *
 *   C1/C2  a "max dimension" that only bounded the WIDTH, so a tall portrait
 *          came back far over the bound and a small photo was upscaled.
 *   C3     an oversized base64 rejected the payload and returned WITHOUT
 *          deleting the compressed file it had just written.
 *   C4     module-memory ownership, so a process death orphaned the cache file.
 *
 * Everything here runs against the shipping TypeScript through the same vm
 * sandbox the other VTO suites use. No filesystem, no network, no timers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(absPath) {
  return ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function loadModule(relPath, requireMap = {}) {
  const absPath = path.join(ROOT, relPath);
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    Set,
    Map,
    Math,
    Date,
    Number,
    RegExp,
    Promise,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(absPath)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(transpile(absPath), { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/**
 * Values that cross the vm boundary carry the SANDBOX's Object/Array
 * prototypes, and node:assert/strict compares prototypes -- so a structurally
 * identical result fails deepEqual with "same structure but not
 * reference-equal". Re-hydrating through JSON puts the value back in this
 * realm so the assertion is about the shape, which is what is under test.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// -- The privacy-image bound -------------------------------------------------

/** Loads privacyImageUpload with a manipulator that RECORDS the actions it was
 *  handed and reports output dimensions derived from them, the way the real
 *  one does. Nothing is written. */
function privacyHarness(source = { width: 4000, height: 3000 }) {
  const calls = [];
  const deleted = [];
  const mod = loadModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': {
      SaveFormat: { JPEG: 'jpeg' },
      manipulateAsync: async (uri, actions, options) => {
        calls.push({ uri, actions, options });
        const resize = actions && actions[0] ? actions[0].resize : null;
        let width = source.width;
        let height = source.height;
        if (resize && resize.width) {
          height = Math.round((source.height / source.width) * resize.width);
          width = resize.width;
        } else if (resize && resize.height) {
          width = Math.round((source.width / source.height) * resize.height);
          height = resize.height;
        }
        return {
          uri: `${uri}.out.jpg`,
          width,
          height,
          base64: options && options.base64 ? 'AAAA' : undefined,
        };
      },
    },
    'expo-file-system/legacy': {
      deleteAsync: async (uri) => {
        deleted.push(uri);
      },
    },
  });
  return { mod, calls, deleted };
}

test('C1: a PORTRAIT source is bounded on its longest edge, not its width', async () => {
  const { mod, calls } = privacyHarness({ width: 800, height: 2400 });
  const out = await mod.prepareImageForPrivacyUpload('file:///p.jpg', {
    maxDimension: 1024,
    sourceWidth: 800,
    sourceHeight: 2400,
  });
  assert.deepEqual(plain(calls[0].actions), [{ resize: { height: 1024 } }], 'the LONG edge is the one pinned');
  assert.ok(out.width <= 1024 && out.height <= 1024, `got ${out.width}x${out.height}`);
  assert.equal(out.height, 1024);
  // The pre-repair behaviour, stated so the regression is unmistakable.
  assert.notDeepEqual(plain(calls[0].actions), [{ resize: { width: 1024 } }]);
});

test('C2: a LANDSCAPE source is bounded on its longest edge', async () => {
  const { mod, calls } = privacyHarness({ width: 4000, height: 1000 });
  const out = await mod.prepareImageForPrivacyUpload('file:///p.jpg', {
    maxDimension: 1024,
    sourceWidth: 4000,
    sourceHeight: 1000,
  });
  assert.deepEqual(plain(calls[0].actions), [{ resize: { width: 1024 } }]);
  assert.ok(out.width <= 1024 && out.height <= 1024, `got ${out.width}x${out.height}`);
  assert.equal(out.width, 1024);
});

test('C3: an image already inside the bound is NOT upscaled', async () => {
  const { mod, calls } = privacyHarness({ width: 400, height: 600 });
  const out = await mod.prepareImageForPrivacyUpload('file:///p.jpg', {
    maxDimension: 1024,
    sourceWidth: 400,
    sourceHeight: 600,
  });
  assert.deepEqual(plain(calls[0].actions), [], 're-encode only: no resize action at all');
  assert.equal(out.width, 400);
  assert.equal(out.height, 600);
});

test('C4: aspect ratio is preserved -- exactly one axis is ever pinned', () => {
  const { mod } = privacyHarness();
  const cases = [
    [800, 2400], [2400, 800], [4000, 4000], [1025, 1024], [1024, 1025], [3, 5000],
  ];
  for (const [w, h] of cases) {
    const actions = mod.boundedResizeActions(w, h, 1024);
    for (const action of actions) {
      const axes = Object.keys(action.resize);
      assert.equal(axes.length, 1, `${w}x${h} pinned ${axes.join('+')} -- that distorts`);
    }
  }
  // A square is landscape-or-equal, so it takes the width branch. Either is
  // correct; what matters is that it is ONE axis and the bound holds.
  assert.deepEqual(plain(mod.boundedResizeActions(4000, 4000, 1024)), [{ resize: { width: 1024 } }]);
});

test('C4b: the bound degrades to the legacy width action when dimensions are unknown', () => {
  const { mod } = privacyHarness();
  const legacy = [{ resize: { width: 1024 } }];
  assert.deepEqual(plain(mod.boundedResizeActions(null, null, 1024)), legacy);
  assert.deepEqual(plain(mod.boundedResizeActions(undefined, 900, 1024)), legacy);
  assert.deepEqual(plain(mod.boundedResizeActions(0, 900, 1024)), legacy, 'a zero edge is not a measurement');
  assert.deepEqual(plain(mod.boundedResizeActions(NaN, 900, 1024)), legacy);
  assert.deepEqual(plain(mod.boundedResizeActions(-10, 900, 1024)), legacy);
  // Callers with no dimensions therefore behave EXACTLY as before this repair:
  // Scanner and Elise are outside the VTO lane and take no perf or behaviour change.
});

test('C5: the metadata-stripping re-encode contract is intact on every branch', async () => {
  for (const source of [{ width: 400, height: 600 }, { width: 800, height: 2400 }]) {
    const { mod, calls } = privacyHarness(source);
    const out = await mod.prepareImageForPrivacyUpload('file:///p.jpg', {
      maxDimension: 1024,
      quality: 0.82,
      sourceWidth: source.width,
      sourceHeight: source.height,
    });
    assert.equal(calls[0].options.format, 'jpeg', 'still a fresh JPEG re-encode');
    assert.equal(calls[0].options.base64, false);
    assert.equal(calls[0].options.compress, 0.82);
    assert.equal(out.policy.metadataStripped, true);
    assert.equal(out.policy.mode, 'metadata-stripped-reencode');
    // The honest policy must not have grown a claim this path does not earn.
    assert.equal(out.policy.faceMaskApplied, false);
    assert.equal(out.policy.plateMaskApplied, false);
    assert.equal(out.policy.faceDetectionAvailable, false);
    assert.equal(out.policy.plateDetectionAvailable, false);
  }
});

test('C5b: the analysis derivative is bounded on its longest edge too', async () => {
  const { mod, calls } = privacyHarness({ width: 768, height: 1024 });
  const out = await mod.compressSanitizedImageForAnalysis('file:///s.jpg', {
    width: 896,
    sourceWidth: 768,
    sourceHeight: 1024,
  });
  assert.deepEqual(plain(calls[0].actions), [{ resize: { height: 896 } }]);
  assert.equal(calls[0].options.base64, true, 'still base64 for transport');
  assert.equal(calls[0].options.format, 'jpeg');
  assert.ok(out.base64.startsWith('data:image/jpeg;base64,'));
});

test('C5c: a small sanitized image is not re-inflated for analysis', async () => {
  const { mod, calls } = privacyHarness({ width: 300, height: 300 });
  await mod.compressSanitizedImageForAnalysis('file:///s.jpg', {
    width: 896,
    sourceWidth: 300,
    sourceHeight: 300,
  });
  assert.deepEqual(plain(calls[0].actions), []);
});

// -- The VTO cache namespace -------------------------------------------------

function fakeFileSystem(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const fsMock = {
    cacheDirectory: 'file:///cache/',
    makeDirectoryAsync: async (dir) => {
      dirs.add(dir);
    },
    moveAsync: async ({ from, to }) => {
      if (!files.has(from)) throw new Error(`no such file ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    deleteAsync: async (uri) => {
      files.delete(uri);
    },
    getInfoAsync: async (uri) => {
      if (dirs.has(uri)) return { exists: true, isDirectory: true };
      return { exists: files.has(uri), isDirectory: false };
    },
    readDirectoryAsync: async (dir) => {
      if (!dirs.has(dir)) throw new Error('ENOENT');
      return [...files.keys()].filter((k) => k.startsWith(dir)).map((k) => k.slice(dir.length));
    },
  };
  return { fsMock, files, dirs };
}

function mediaCacheHarness(initial = {}) {
  const { fsMock, files, dirs } = fakeFileSystem(initial);
  let n = 0;
  const mod = loadModule('services/vto/vtoMediaCache.ts', {
    'expo-crypto': {
      randomUUID: () => {
        n += 1;
        return `uuid${n}`;
      },
    },
    'expo-file-system/legacy': fsMock,
  });
  return { mod, files, dirs, fsMock };
}

const NS = 'file:///cache/kscan-vto-media/';

test('C6: a derivative is adopted into the VTO namespace and tracked', async () => {
  const { mod, files } = mediaCacheHarness({ 'file:///cache/ImageManipulator/x.jpg': 'bytes' });
  const adopted = await mod.adoptVtoMediaFile('file:///cache/ImageManipulator/x.jpg', 'person');
  assert.equal(adopted, `${NS}vtoperson-uuid1.jpg`);
  assert.equal(files.has('file:///cache/ImageManipulator/x.jpg'), false, 'moved, not copied');
  assert.equal(files.get(adopted), 'bytes');
  assert.deepEqual(plain(mod.__vtoMediaCacheInternals.getProcessOwned()), [adopted]);
  assert.equal(mod.isOwnedVtoMediaUri(adopted), true);
  assert.equal(mod.isOwnedVtoMediaUri('file:///cache/ImageManipulator/x.jpg'), false);
});

test('C7: adoption fails SOFT -- a failed move returns the original, never throws', async () => {
  const { mod, fsMock } = mediaCacheHarness({ 'file:///cache/ImageManipulator/x.jpg': 'bytes' });
  fsMock.moveAsync = async () => {
    throw new Error('EXDEV');
  };
  const out = await mod.adoptVtoMediaFile('file:///cache/ImageManipulator/x.jpg', 'person');
  assert.equal(out, 'file:///cache/ImageManipulator/x.jpg', 'the try-on still works');
  assert.deepEqual(plain(mod.__vtoMediaCacheInternals.getProcessOwned()), []);
});

test('C8: the startup sweep deletes ONLY orphans inside the VTO namespace', async () => {
  const survivors = [
    'file:///cache/ImageManipulator/scanner.jpg',
    'file:///cache/kscan-stylist-speech/speech-1.mp3',
    'file:///documents/kscan_closet/item.jpg',
    'file:///photos/original.HEIC',
    'file:///cache/kscan-privacy/san-1.jpg',
  ];
  const initial = {
    // Left by a previous process.
    [`${NS}vtoperson-old1.jpg`]: 'orphan',
    [`${NS}vtopayload-old2.jpg`]: 'orphan',
  };
  for (const s of survivors) initial[s] = 'other feature';
  const { mod, files, dirs } = mediaCacheHarness(initial);
  dirs.add(NS);

  const summary = await mod.sweepOrphanedVtoMedia();
  assert.equal(summary.deleted, 2);
  assert.equal(files.has(`${NS}vtoperson-old1.jpg`), false);
  assert.equal(files.has(`${NS}vtopayload-old2.jpg`), false);
  for (const survivor of survivors) {
    assert.equal(files.has(survivor), true, `${survivor} was deleted -- out of scope`);
  }
});

test('C9: the sweep never deletes a derivative THIS process is still using', async () => {
  const { mod, files, dirs } = mediaCacheHarness({
    [`${NS}vtoperson-old1.jpg`]: 'orphan',
    'file:///cache/ImageManipulator/live.jpg': 'live',
  });
  dirs.add(NS);
  const live = await mod.adoptVtoMediaFile('file:///cache/ImageManipulator/live.jpg', 'person');
  const summary = await mod.sweepOrphanedVtoMedia();
  assert.equal(summary.deleted, 1);
  assert.equal(files.has(live), true, 'the in-session person photo survives a re-run');
  assert.equal(files.has(`${NS}vtoperson-old1.jpg`), false);
});

test('C10: the sweep is idempotent and safe on a missing/empty namespace', async () => {
  const { mod, dirs } = mediaCacheHarness({ [`${NS}vtoperson-old1.jpg`]: 'orphan' });
  dirs.add(NS);
  const first = await mod.sweepOrphanedVtoMedia();
  const second = await mod.sweepOrphanedVtoMedia();
  const third = await mod.sweepOrphanedVtoMedia();
  assert.equal(first.deleted, 1);
  assert.equal(second.deleted, 0);
  assert.equal(third.deleted, 0);

  // And with no namespace directory at all.
  const fresh = mediaCacheHarness();
  assert.deepEqual(plain(await fresh.mod.sweepOrphanedVtoMedia()), { scanned: 0, deleted: 0 });
});

test('C11: a sweep whose filesystem is hostile still resolves, never throws', async () => {
  const { mod, fsMock, dirs } = mediaCacheHarness({ [`${NS}a.jpg`]: 'x' });
  dirs.add(NS);
  fsMock.deleteAsync = async () => {
    throw new Error('EBUSY');
  };
  const summary = await mod.sweepOrphanedVtoMedia();
  assert.equal(summary.deleted, 0);
  assert.ok(summary.scanned >= 1);

  fsMock.readDirectoryAsync = async () => {
    throw new Error('EACCES');
  };
  assert.deepEqual(plain(await mod.sweepOrphanedVtoMedia()), { scanned: 0, deleted: 0 });

  // No cache directory on this platform at all.
  const nocache = loadModule('services/vto/vtoMediaCache.ts', {
    'expo-crypto': { randomUUID: () => 'u' },
    'expo-file-system/legacy': { cacheDirectory: null },
  });
  assert.equal(nocache.vtoMediaDirectory(), null);
  assert.deepEqual(plain(await nocache.sweepOrphanedVtoMedia()), { scanned: 0, deleted: 0 });
  assert.equal(await nocache.adoptVtoMediaFile('file:///x.jpg', 'person'), 'file:///x.jpg');
});

test('C12: the sweep is bounded', async () => {
  const many = {};
  for (let i = 0; i < 50; i += 1) many[`${NS}vtoperson-${i}.jpg`] = 'x';
  const { mod, dirs } = mediaCacheHarness(many);
  dirs.add(NS);
  const summary = await mod.sweepOrphanedVtoMedia({ maxDeletions: 10 });
  assert.equal(summary.deleted, 10, 'stops at the cap instead of stalling startup');
});

// -- The VTO person path -----------------------------------------------------

function personHarness(overrides = {}) {
  const cleaned = [];
  const adopted = [];
  const forgotten = [];
  const prepareCalls = [];
  const compressCalls = [];
  const mod = loadModule('services/vto/vtoPersonInput.ts', {
    'expo-image-picker': {},
    '../privacyImageUpload': Object.assign(
      {
        cleanupSanitizedImage: async (uri) => {
          cleaned.push(uri);
        },
        compressSanitizedImageForAnalysis: async (uri, options) => {
          compressCalls.push({ uri, options });
          return { base64: 'data:image/jpeg;base64,AAAA', uri: 'file:///cache/IM/compressed.jpg' };
        },
        prepareImageForPrivacyUpload: async (uri, options) => {
          prepareCalls.push({ uri, options });
          return {
            sanitizedUri: 'file:///cache/IM/sanitized.jpg',
            width: 768,
            height: 1024,
            policy: { metadataStripped: true, sanitizerVersion: 'test-1.0.0' },
          };
        },
        PrivacyPrepareError: class PrivacyPrepareError extends Error {},
      },
      overrides.privacy || {},
    ),
    './vtoMediaCache': Object.assign(
      {
        adoptVtoMediaFile: async (uri, kind) => {
          adopted.push({ uri, kind });
          return `file:///cache/kscan-vto-media/${kind}-adopted.jpg`;
        },
        forgetVtoMediaFile: (uri) => {
          forgotten.push(uri);
        },
      },
      overrides.cache || {},
    ),
    '../../types/vto': {},
  });
  return { mod, cleaned, adopted, forgotten, prepareCalls, compressCalls };
}

test('C13: the picker hands the SOURCE dimensions to the sanitizer', async () => {
  const { mod, prepareCalls, adopted } = personHarness();
  const outcome = await mod.pickVtoPersonInput({
    picker: {
      launchImageLibraryAsync: async () => ({
        canceled: false,
        assets: [{ uri: 'file:///photos/1.jpg', width: 3024, height: 4032 }],
      }),
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(prepareCalls[0].options.sourceWidth, 3024);
  assert.equal(prepareCalls[0].options.sourceHeight, 4032);
  assert.equal(prepareCalls[0].options.maxDimension, 1024);
  // ...and the derivative is adopted into VTO's namespace.
  assert.deepEqual(plain(adopted), [{ uri: 'file:///cache/IM/sanitized.jpg', kind: 'person' }]);
  assert.equal(outcome.person.sanitizedUri, 'file:///cache/kscan-vto-media/person-adopted.jpg');
});

test('C13b: a picker asset with no dimensions still yields a working person input', async () => {
  const { mod, prepareCalls } = personHarness();
  const outcome = await mod.pickVtoPersonInput({
    picker: {
      launchImageLibraryAsync: async () => ({
        canceled: false,
        assets: [{ uri: 'file:///photos/1.jpg' }],
      }),
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(prepareCalls[0].options.sourceWidth, null);
  assert.equal(prepareCalls[0].options.sourceHeight, null);
});

test('C14: an OVERSIZED base64 deletes the transient compressed derivative', async () => {
  const { mod, cleaned, forgotten } = personHarness({
    privacy: {
      compressSanitizedImageForAnalysis: async () => ({
        base64: 'x'.repeat(2000001),
        uri: 'file:///cache/IM/huge.jpg',
      }),
    },
  });
  const outcome = await mod.buildVtoPersonPayload({
    sanitizedUri: 'file:///cache/kscan-vto-media/person-adopted.jpg',
    width: 1024,
    height: 1024,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'invalid_person_input');
  assert.deepEqual(
    cleaned,
    ['file:///cache/kscan-vto-media/payload-adopted.jpg'],
    'the file the rejected payload had already written is deleted',
  );
  assert.deepEqual(forgotten, ['file:///cache/kscan-vto-media/payload-adopted.jpg']);
});

test('C14b: a NON-STRING base64 also deletes the transient derivative', async () => {
  const { mod, cleaned } = personHarness({
    privacy: {
      compressSanitizedImageForAnalysis: async () => ({ base64: null, uri: 'file:///cache/IM/x.jpg' }),
    },
  });
  const outcome = await mod.buildVtoPersonPayload({
    sanitizedUri: 'file:///s.jpg',
    width: 10,
    height: 10,
  });
  assert.equal(outcome.ok, false);
  assert.equal(cleaned.length, 1);
});

test('C15: a VALID payload KEEPS its transient URI for the request to own', async () => {
  const { mod, cleaned, compressCalls } = personHarness();
  const outcome = await mod.buildVtoPersonPayload({
    sanitizedUri: 'file:///cache/kscan-vto-media/person-adopted.jpg',
    width: 768,
    height: 1024,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.transientUri, 'file:///cache/kscan-vto-media/payload-adopted.jpg');
  assert.deepEqual(cleaned, [], 'a good payload deletes nothing');
  // And the compression is bounded on the longest edge, from the person's own dims.
  assert.equal(compressCalls[0].options.sourceWidth, 768);
  assert.equal(compressCalls[0].options.sourceHeight, 1024);
  assert.equal(compressCalls[0].options.width, 1024);
});

test('C16: a cleanup that FAILS never crashes the user flow', async () => {
  const { mod } = personHarness({
    privacy: {
      cleanupSanitizedImage: async () => {
        throw new Error('EBUSY');
      },
      compressSanitizedImageForAnalysis: async () => ({
        base64: 'x'.repeat(2000001),
        uri: 'file:///cache/IM/huge.jpg',
      }),
    },
  });
  // The real cleanupSanitizedImage swallows its own errors; this asserts the
  // caller does not reintroduce a throw around it either way.
  const outcome = await mod.buildVtoPersonPayload({
    sanitizedUri: 'file:///s.jpg',
    width: 1,
    height: 1,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'invalid_person_input');
});

test('C16b: an adoption THROW after a successful compress still fails closed', async () => {
  const { mod } = personHarness({
    cache: {
      adoptVtoMediaFile: async () => {
        throw new Error('boom');
      },
    },
  });
  const outcome = await mod.buildVtoPersonPayload({
    sanitizedUri: 'file:///s.jpg',
    width: 1,
    height: 1,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'invalid_person_input');
});

test('C17: release deletes AND deregisters, so a later sweep is not permanently blinded', async () => {
  const { mod, cleaned, forgotten } = personHarness();
  await mod.releaseVtoPersonInput('file:///a.jpg', null, undefined, 'file:///b.jpg');
  assert.deepEqual(cleaned, ['file:///a.jpg', 'file:///b.jpg']);
  assert.deepEqual(forgotten, ['file:///a.jpg', 'file:///b.jpg']);
});

// -- Session semantics must not regress --------------------------------------

test('C18: leaveVtoSurface still preserves the same-session person photo', () => {
  const source = read('services/vto/vtoRequestStore.ts');
  const fn = source.slice(source.indexOf('export function leaveVtoSurface'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(
    !/releaseOwnedMedia|releaseVtoPersonInput/.test(body),
    'closing the sheet must not delete the photo -- reopening it would ask the user to pick again',
  );
  assert.ok(body.includes("current.person ? 'ready' : 'idle'"), 'the photo still carries the surface');
});

test('C19: the actor boundary still clears VTO media', () => {
  const source = read('services/vto/vtoRequestStore.ts');
  const fn = source.slice(source.indexOf('export function resetVtoRequestState'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(body.includes('releaseOwnedMedia()'), 'a person photo must never survive an actor transition');
  assert.ok(body.includes('invalidate()'));
  assert.ok(body.includes('IDLE_VTO_SNAPSHOT'));
});

test('C20: the startup sweep is wired, once, at the root layout', () => {
  const layout = read('app/_layout.tsx');
  assert.ok(layout.includes("from '../services/vto/vtoMediaCache'"));
  assert.ok(layout.includes('void sweepOrphanedVtoMedia()'), 'fire-and-forget: startup never awaits it');
  assert.equal(
    (layout.match(/sweepOrphanedVtoMedia\(\)/g) || []).length,
    1,
    'exactly one invocation',
  );
});

test('C21: no Live-VTO or Build 35 R&D dependency entered this repair', () => {
  const touched = [
    'services/vto/vtoMediaCache.ts',
    'services/vto/vtoPersonInput.ts',
    'services/privacyImageUpload.ts',
  ];
  const forbidden = [
    /MediaPipe/i, /PoseLandmarker/i, /KScanLiveVto/, /pose_landmarker/i,
    /liveVtoNativeModule/, /vtoLiveSession/, /meshRenderer/i,
  ];
  for (const file of touched) {
    const source = read(file);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${file} must not reference ${pattern}`);
    }
  }
});

test('C22: the media cache writes nothing durable and reaches no network', () => {
  const source = read('services/vto/vtoMediaCache.ts');
  for (const forbidden of [
    /documentDirectory/, /AsyncStorage/, /supabase/i, /fetch\(/, /\.storage\s*\./,
    /addClosetItem/, /saveScan/,
  ]) {
    assert.ok(!forbidden.test(source), `vtoMediaCache must not use ${forbidden}`);
  }
  assert.ok(source.includes('cacheDirectory'), 'cache only -- not backup-eligible, not durable');
});
