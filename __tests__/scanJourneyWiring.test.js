// Wiring gates for the Checkpoint 3 contract.
//
// WHY THIS FILE EXISTS
//
// Hostile validation found `validateSelectedItemRequest` fully implemented,
// fully unit-tested, and NEVER CALLED. Every one of its tests passed, and the
// guarantee it was written to provide — that a selection token cannot be
// swapped across request lineages — was false in the running system.
//
// A unit test proves a function behaves. It cannot prove the function runs.
// These tests assert the wiring: that each safety-critical helper is reachable
// from the request path, in the right order, and that nothing important is
// dead code. They are deliberately structural rather than behavioural, because
// the failure mode they catch is structural.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIR = path.join(ROOT, 'supabase', 'functions', 'scan-identify');

function read(file) {
  return fs.readFileSync(path.join(SCAN_DIR, file), 'utf8');
}

const INDEX = read('index.ts');
const CONTRACT = read('scanJourneyContract.ts');

test('THE LESSON: every exported safety helper is actually called somewhere', () => {
  // Enumerate the helpers whose whole purpose is to prevent something, and
  // require each to have a caller outside its own module and its own tests.
  const safetyHelpers = {
    'multiItemSelectionContract.ts': [
      'buildSelectionRequiredPayload',
      'suppressGuessedPrimary',
      'suppressV2GuessedIdentity',
      'validateSelectedItemRequest',
    ],
    'productMatchBridge.ts': ['requestProductMatch', 'projectIdentificationToQuery'],
    'existingItemCandidates.ts': ['sanitizeExistingItemCandidates'],
  };

  const productionSources = fs
    .readdirSync(SCAN_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

  const uncalled = [];
  for (const [owner, helpers] of Object.entries(safetyHelpers)) {
    for (const helper of helpers) {
      const callers = productionSources.filter((name) => {
        if (name === owner) return false;
        return new RegExp(`\\b${helper}\\s*\\(`).test(read(name));
      });
      if (callers.length === 0) uncalled.push(`${owner}:${helper}`);
    }
  }

  assert.deepEqual(
    uncalled,
    [],
    `these helpers are dead code — their unit tests pass while the guarantee is absent: ${uncalled.join(', ')}`,
  );
});

test('the selection-token check runs on the selected-item request path', () => {
  assert.match(INDEX, /validateSelectedItemRequest\(/, 'index.ts must call the validator');

  // It must be gated, or flag-off behaviour is not byte-identical.
  const callAt = INDEX.indexOf('validateSelectedItemRequest(');
  const window = INDEX.slice(Math.max(0, callAt - 800), callAt);
  assert.match(window, /isSelectionContractEnabled\(\)/, 'the check must be flag-gated');
  assert.match(window, /useSelectedItemProvider/, 'the check must be scoped to selected-item requests');
});

test('the token check runs after the image digest is computed', () => {
  // Validating against an uncomputed digest would compare a client value to an
  // empty string and pass everything.
  const digestAt = INDEX.indexOf('imageDigestPrefix = (await sha256Hex(');
  const checkAt = INDEX.indexOf('validateSelectedItemRequest(');
  assert.ok(digestAt > -1 && checkAt > -1);
  assert.ok(checkAt > digestAt, 'the token check must run after imageDigestPrefix is derived');
});

test('a rejected token fails the request instead of continuing', () => {
  const checkAt = INDEX.indexOf('validateSelectedItemRequest(');
  const window = INDEX.slice(checkAt, checkAt + 1400);
  assert.match(window, /if \(!tokenCheck\.ok\)/);
  assert.match(window, /return json\(/, 'a mismatch must terminate the request, never be repaired');
});

test('the journey contract runs after the legacy response is assembled', () => {
  // Running it earlier would make the legacy answer conditional on the new
  // code, which is exactly what the rollback path must not be.
  const assembleAt = INDEX.indexOf('const legacyFinalResponse = withSafeImageArrays(');
  const contractAt = INDEX.indexOf('applyScanJourneyContract({');
  assert.ok(assembleAt > -1 && contractAt > -1);
  assert.ok(contractAt > assembleAt);
});

test('the V2 guess suppression is reachable from the selection branch', () => {
  const selectionAt = CONTRACT.indexOf('buildSelectionRequiredPayload({');
  const v2At = CONTRACT.indexOf('suppressV2GuessedIdentity(');
  assert.ok(selectionAt > -1 && v2At > -1);
  assert.ok(v2At > selectionAt, 'V2 suppression must happen inside the selection branch');
});

test('the contract layer cannot throw away a scan result', () => {
  // Its own catch must return the untouched input, not a partial object.
  assert.match(CONTRACT, /catch \(error\) \{[\s\S]*?return input\.finalResponse;/);
});

test('no flag reads default to enabled', () => {
  // A `?? true` or a truthy-by-default read would silently switch a checkpoint
  // feature on in production.
  for (const file of ['multiItemSelectionContract.ts', 'productMatchBridge.ts', 'scanJourneyContract.ts']) {
    const source = read(file);
    const defaults = [...source.matchAll(/return\s+([A-Z_]+_DEFAULT_ENABLED);/g)].map((m) => m[1]);
    assert.ok(defaults.length > 0, `${file} must resolve its flag through a named default`);
    for (const name of defaults) {
      assert.match(
        source,
        new RegExp(`${name}\\s*=\\s*false`),
        `${name} in ${file} must default to false`,
      );
    }
  }
});
