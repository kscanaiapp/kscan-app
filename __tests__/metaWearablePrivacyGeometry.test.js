'use strict';

// Regression coverage for services/metaWearablePrivacyGeometry.ts — the pure,
// native-module-free bounds-checking and mask-geometry math extracted from
// services/metaWearablePrivacy.ts (the Meta phone-owned capture path's
// fail-closed sanitizer). The rest of that sanitizer (decode, ML-Kit face
// detection, Skia rendering) touches native RN packages and can only be
// meaningfully exercised on a device/emulator — this file covers the part
// that can regress silently in plain Node: a malformed or adversarial
// detector-reported face frame must never produce a mask outside the image,
// or slip through validation as if it were a real face.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'services', 'metaWearablePrivacyGeometry.ts');

function loadGeometry() {
  const source = fs.readFileSync(SRC, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    require: (id) => {
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename: SRC });
  return mod.exports;
}

const { isLocalUri, validateFrame, computeMaskRect } = loadGeometry();

// ── isLocalUri ──────────────────────────────────────────────────────────────

test('isLocalUri accepts file:// and content:// URIs', () => {
  assert.equal(isLocalUri('file:///data/user/0/com.kscanai.app/cache/a.jpg'), true);
  assert.equal(isLocalUri('content://media/external/images/media/1'), true);
});

test('isLocalUri rejects remote and non-URI input, including a raw https upload attempt', () => {
  assert.equal(isLocalUri('https://example.com/a.jpg'), false);
  assert.equal(isLocalUri('data:image/jpeg;base64,AAAA'), false);
  assert.equal(isLocalUri(''), false);
  assert.equal(isLocalUri(null), false);
  assert.equal(isLocalUri(undefined), false);
  assert.equal(isLocalUri(42), false);
});

// ── validateFrame ────────────────────────────────────────────────────────────

test('validateFrame accepts a well-formed in-bounds face frame', () => {
  // Field-by-field, not deepEqual: validateFrame's return value is a plain
  // object created inside the vm sandbox's own realm, so it has a different
  // Object prototype than this test file's literals — deepStrictEqual would
  // report them unequal even with identical own properties.
  const frame = validateFrame({ left: 10, top: 20, width: 100, height: 120 }, 400, 400);
  assert.notEqual(frame, null);
  assert.equal(frame.left, 10);
  assert.equal(frame.top, 20);
  assert.equal(frame.width, 100);
  assert.equal(frame.height, 120);
});

test('validateFrame rejects a non-object value', () => {
  assert.equal(validateFrame(null, 400, 400), null);
  assert.equal(validateFrame('not-a-frame', 400, 400), null);
  assert.equal(validateFrame(42, 400, 400), null);
});

test('validateFrame rejects non-finite or missing coordinates', () => {
  assert.equal(validateFrame({ left: NaN, top: 0, width: 10, height: 10 }, 400, 400), null);
  assert.equal(validateFrame({ left: 0, top: 0, width: 10 }, 400, 400), null);
  assert.equal(validateFrame({}, 400, 400), null);
});

test('validateFrame rejects zero or negative width/height (a degenerate "face")', () => {
  assert.equal(validateFrame({ left: 0, top: 0, width: 0, height: 10 }, 400, 400), null);
  assert.equal(validateFrame({ left: 0, top: 0, width: 10, height: -5 }, 400, 400), null);
});

test('validateFrame rejects a frame that extends meaningfully outside the image bounds', () => {
  // A detector reporting a face box larger than the photo itself must not
  // silently pass through and produce a mask drawn partly off-canvas.
  assert.equal(validateFrame({ left: 350, top: 0, width: 100, height: 50 }, 400, 400), null);
  assert.equal(validateFrame({ left: -50, top: 0, width: 100, height: 50 }, 400, 400), null);
});

test('validateFrame tolerates a 1px rounding slop at the image edge', () => {
  const frame = validateFrame({ left: 0, top: 0, width: 400, height: 400 }, 400, 400);
  assert.notEqual(frame, null);
  const edge = validateFrame({ left: -1, top: -1, width: 401, height: 401 }, 400, 400);
  assert.notEqual(edge, null);
});

// ── computeMaskRect ──────────────────────────────────────────────────────────

test('computeMaskRect expands the face box by the documented asymmetric margins', () => {
  const rect = computeMaskRect({ left: 100, top: 100, width: 100, height: 100 }, 1000, 1000);
  // MASK_MARGIN_X=0.16, MASK_MARGIN_UP=0.2, MASK_MARGIN_DOWN=0.1 — matches
  // computeMaskRect's own x/right/y/bottom formula exactly, not an
  // independently-derived approximation.
  const x = 100 - 100 * 0.16;
  const y = 100 - 100 * 0.2;
  const right = 100 + 100 * (1 + 0.16);
  const bottom = 100 + 100 * (1 + 0.1);
  assert.equal(rect.x, x);
  assert.equal(rect.y, y);
  assert.equal(rect.width, right - x);
  assert.equal(rect.height, bottom - y);
});

test('computeMaskRect clamps to the image bounds rather than drawing off-canvas', () => {
  const rect = computeMaskRect({ left: 0, top: 0, width: 50, height: 50 }, 1000, 1000);
  assert.equal(rect.x, 0, 'left margin cannot go negative');
  assert.equal(rect.y, 0, 'top margin cannot go negative');

  const bottomRight = computeMaskRect({ left: 950, top: 950, width: 50, height: 50 }, 1000, 1000);
  assert.ok(bottomRight.x + bottomRight.width <= 1000, 'right edge must not exceed image width');
  assert.ok(bottomRight.y + bottomRight.height <= 1000, 'bottom edge must not exceed image height');
});

test('computeMaskRect never returns a zero-area rectangle (a mask must always cover something)', () => {
  const rect = computeMaskRect({ left: 0, top: 0, width: 1, height: 1 }, 1, 1);
  assert.ok(rect.width >= 1);
  assert.ok(rect.height >= 1);
});
