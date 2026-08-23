'use strict';

// Coverage for services/metaWearableSessionClock.ts and the screen wiring that
// consumes it.
//
// WHY THIS FILE EXISTS. wearable-bridge issues wearable sessions with a
// 15-minute TTL and refuses every protected call past it
// (`Date.parse(session.expires_at) <= Date.now()` -> SESSION_EXPIRED). The
// companion screen read `sessionExpiresAt` once, at pair time, and then never
// consulted it: the UI kept reporting "Paired." and kept the Capture button
// enabled indefinitely. Pressing it opened the camera, took a real photo, ran
// the full on-device privacy pipeline and compressed the image, and only then
// discovered from the server that the session was gone — a protected capability
// offered, and a real photograph taken, on authority the app no longer had.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'services', 'metaWearableSessionClock.ts');
const SCREEN = path.join(__dirname, '..', 'app', 'wearables', 'meta.tsx');

function loadModule() {
  const output = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
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
    Number,
    Math,
    require: (id) => {
      throw new Error(`Unexpected runtime require in metaWearableSessionClock.ts: ${id}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(output, sandbox, { filename: 'metaWearableSessionClock.ts' });
  return mod.exports;
}

const M = loadModule();

const CLAIMED = 1_700_000_000_000;
const EXPIRES = CLAIMED + M.WEARABLE_SESSION_TTL_MS;

test('the client TTL mirrors the deployed bridge SESSION_TTL_MS (15 minutes)', () => {
  assert.equal(M.WEARABLE_SESSION_TTL_MS, 15 * 60 * 1000);
});

test('before expiry the session is usable', () => {
  assert.equal(M.isWearableSessionExpired(EXPIRES, CLAIMED, CLAIMED), false);
  assert.equal(M.isWearableSessionExpired(EXPIRES, CLAIMED, EXPIRES - 1), false);
});

test('AT the expiry instant the session is already refused, so the client agrees', () => {
  // The bridge uses `expires_at <= now`, so the exact instant is expired
  // server-side. A client using `>` would offer one last capture the server
  // has already stopped honouring.
  assert.equal(M.isWearableSessionExpired(EXPIRES, CLAIMED, EXPIRES), true);
});

test('after expiry the session is expired', () => {
  assert.equal(M.isWearableSessionExpired(EXPIRES, CLAIMED, EXPIRES + 1), true);
  assert.equal(M.isWearableSessionExpired(EXPIRES, CLAIMED, EXPIRES + 60_000), true);
});

test('THE DEFECT: an unknown expiry fails closed at the protocol TTL, not never', () => {
  // Treating a missing sessionExpiresAt as "no expiry" is precisely how the UI
  // stayed READY forever.
  for (const unknown of [undefined, null, '', 'soon', NaN, Infinity, {}]) {
    assert.equal(
      M.isWearableSessionExpired(unknown, CLAIMED, CLAIMED + M.WEARABLE_SESSION_TTL_MS),
      true,
      `unknown expiry ${JSON.stringify(unknown)} never expired`,
    );
    assert.equal(M.isWearableSessionExpired(unknown, CLAIMED, CLAIMED), false);
  }
});

test('a re-pair resets the clock', () => {
  const rePairedAt = EXPIRES + 5_000;
  assert.equal(M.isWearableSessionExpired(undefined, rePairedAt, rePairedAt + 1_000), false);
});

test('seconds remaining counts down and floors at zero', () => {
  assert.equal(M.wearableSessionSecondsRemaining(EXPIRES, CLAIMED, CLAIMED), 900);
  assert.equal(M.wearableSessionSecondsRemaining(EXPIRES, CLAIMED, EXPIRES - 30_000), 30);
  assert.equal(M.wearableSessionSecondsRemaining(EXPIRES, CLAIMED, EXPIRES), 0);
  assert.equal(M.wearableSessionSecondsRemaining(EXPIRES, CLAIMED, EXPIRES + 999_999), 0);
});

// ---------------------------------------------------------------------------
// Screen wiring. Source-level, because the screen cannot be rendered off-device.
// ---------------------------------------------------------------------------

const screen = fs.readFileSync(SCREEN, 'utf8');

test('the screen re-evaluates expiry on a timer, not only at pair time', () => {
  assert.match(screen, /isWearableSessionExpired\(session\.sessionExpiresAt, sessionClaimedAt, Date\.now\(\)\)/);
  assert.match(screen, /setInterval\(evaluate/);
});

test('capture, save and open are all refused once the session has expired', () => {
  for (const guard of [
    /const capture = useCallback\(async \(\) => \{\s*\n\s*if \(!session \|\| busy \|\| sessionExpired\) return;/,
    /const saveResult = useCallback\(async \(\) => \{\s*\n\s*if \(!session \|\| !result \|\| sessionExpired\) return;/,
    /const openOnPhone = useCallback\(async \(\) => \{\s*\n\s*if \(!session \|\| !result \|\| sessionExpired\) return;/,
  ]) {
    assert.match(screen, guard);
  }
});

test('the expired state is visible, not just internally enforced', () => {
  // A silently dead button is its own false state; the screen must say why.
  assert.match(screen, /SESSION EXPIRED/);
  assert.match(screen, /disabled=\{busy \|\| sessionExpired\}/);
});
