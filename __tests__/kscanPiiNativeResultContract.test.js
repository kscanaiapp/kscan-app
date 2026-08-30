// Build fix 2 — every NativeFaceMaskResult(...) call must use the full
// canonical label set, in canonical order, with named arguments.
//
// WHY THIS EXISTS: EAS build 3c1e9cae-9f54-4860-8fe4-fa4c62a0d211 (SHA
// 0b9101f) got past the XCTest fix and failed native Swift compilation at
// three call sites in KScanPiiNativeModule.swift — each one missing
// parameters the canonical NativeFaceMaskResult init (NativePrivacyModels.swift)
// requires, or supplying errorCode/failureReason out of order. This parses
// the Swift source directly (rather than counting strings) so a future edit
// that adds/removes/reorders a field is caught locally on Windows, without
// needing an EAS build to discover it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_DIR = path.join(ROOT, 'modules', 'kscan-pii-native', 'ios');
const MODELS_PATH = path.join(MODULE_DIR, 'NativePrivacyModels.swift');
const MODULE_PATH = path.join(MODULE_DIR, 'KScanPiiNativeModule.swift');

// Normalized once, up front: this module's Swift files use CRLF, and every
// regex below assumes LF rather than special-casing \r? at each call site.
const modelsSource = fs.readFileSync(MODELS_PATH, 'utf8').replace(/\r\n/g, '\n');
const moduleSource = fs.readFileSync(MODULE_PATH, 'utf8').replace(/\r\n/g, '\n');

/**
 * Canonical field order, parsed from the struct declaration itself rather
 * than hand-copied — so this test fails loudly (not silently drifts) if the
 * struct's own field order ever changes, instead of asserting call sites
 * against a stale expectation.
 */
function parseCanonicalFieldOrder() {
  const structMatch = modelsSource.match(
    /struct NativeFaceMaskResult \{([\s\S]*?)\n\n {4}func toDictionary/,
  );
  assert.ok(structMatch, 'could not locate the NativeFaceMaskResult struct body');
  const body = structMatch[1];
  const fields = [...body.matchAll(/^\s{4}let (\w+):/gm)].map((m) => m[1]);
  assert.ok(fields.length >= 20, `expected the full field list, got ${fields.length}`);
  return fields;
}

const CANONICAL_ORDER = parseCanonicalFieldOrder();

test('the canonical field order matches the field list this fix was written against', () => {
  // A frozen expectation, not just self-referential: if this struct is ever
  // restructured, this is the line that should force a human to re-read the
  // whole contract rather than only get a passing test from a moved goalpost.
  assert.deepEqual(CANONICAL_ORDER, [
    'status',
    'platform',
    'detectorImplementation',
    'detectorVersion',
    'sanitizerVersion',
    'inputWidth',
    'inputHeight',
    'outputWidth',
    'outputHeight',
    'facesDetected',
    'facesAccepted',
    'facesMasked',
    'regionsChanged',
    'regionsAlreadyRedacted',
    'pixelsChanged',
    'sanitizedUri',
    'inputChecksum',
    'outputChecksum',
    'checksumAlgorithm',
    'detectionDurationMs',
    'maskingDurationMs',
    'encodingDurationMs',
    'verificationDurationMs',
    'totalDurationMs',
    'warnings',
    'errorCode',
    'failureReason',
  ]);
});

/**
 * Finds every `NativeFaceMaskResult(...)` call and returns its raw argument
 * text, tracking paren/bracket depth so a nested call (none currently exist,
 * but the parser must not silently mis-split if one is added) doesn't split
 * the argument list early.
 */
function findResultConstructorCalls(source) {
  const calls = [];
  const marker = 'NativeFaceMaskResult(';
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    const openParenIndex = start + marker.length - 1;
    let depth = 0;
    let end = -1;
    for (let i = openParenIndex; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end !== -1, `unterminated NativeFaceMaskResult( call starting at offset ${start}`);
    calls.push({ start, argsText: source.slice(openParenIndex + 1, end) });
    searchFrom = end + 1;
  }
  return calls;
}

/**
 * Splits a call's argument text into top-level `label: value` pairs, respecting
 * paren/bracket/string nesting so e.g. `["No faces detected."]` or a `.failure`
 * pattern-match binding never gets mis-split on an internal comma.
 */
function splitTopLevelArgs(argsText) {
  const parts = [];
  let depth = 0;
  let current = '';
  let inString = false;
  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i];
    if (ch === '"' && argsText[i - 1] !== '\\') inString = !inString;
    if (!inString) {
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
    }
    if (ch === ',' && depth === 0 && !inString) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(\w+):/);
      assert.ok(m, `argument is not a named "label: value" pair: ${p}`);
      return m[1];
    });
}

const calls = findResultConstructorCalls(moduleSource);

test('KScanPiiNativeModule.swift constructs NativeFaceMaskResult exactly three times', () => {
  // A count guard: the number of call sites this fix repaired. A new call
  // site (a new success/failure path) is fine — but it must be added to this
  // test's expectations deliberately, not discovered by a coincidental pass.
  assert.equal(calls.length, 3, 'expected the noFaces, success, and buildFailureResult call sites');
});

test('every NativeFaceMaskResult call supplies every canonical label exactly once', () => {
  for (const call of calls) {
    const labels = splitTopLevelArgs(call.argsText);
    const seen = new Set();
    for (const label of labels) {
      assert.ok(!seen.has(label), `label "${label}" appears twice in one call`);
      seen.add(label);
    }
    for (const field of CANONICAL_ORDER) {
      assert.ok(seen.has(field), `call at offset ${call.start} is missing "${field}"`);
    }
    assert.equal(
      labels.length,
      CANONICAL_ORDER.length,
      `call at offset ${call.start} has an extra label not in the canonical field list: ${labels
        .filter((l) => !CANONICAL_ORDER.includes(l))
        .join(', ')}`,
    );
  }
});

test('every NativeFaceMaskResult call supplies its labels in canonical order', () => {
  for (const call of calls) {
    const labels = splitTopLevelArgs(call.argsText);
    assert.deepEqual(labels, CANONICAL_ORDER, `call at offset ${call.start} is out of order`);
  }
});

test('the success path never fabricates failure metadata', () => {
  const successCall = calls.find((c) => /status:\s*\.success/.test(c.argsText));
  assert.ok(successCall, 'no call constructs status: .success');
  assert.match(successCall.argsText, /errorCode:\s*nil/);
  assert.match(successCall.argsText, /failureReason:\s*nil/);
  assert.match(successCall.argsText, /warnings:\s*\[\]/);
});

test('the noFaces path still produces a verified, metadata-free artifact', () => {
  // CONTRACT CHANGED IN B2A, DELIBERATELY.
  //
  // This previously asserted the opposite — that noFaces wrote no artifact and
  // returned sanitizedUri: nil. That was unreachable while the plate gate held
  // the whole boundary closed. With plate screening live it became a defect:
  // the privacy boundary requires a sanitized artifact, so a face-free image
  // (i.e. nearly every Closet garment photo) would have been BLOCKED outright.
  //
  // "Sanitized" means decoded and re-encoded from pixels, which is what removes
  // EXIF/GPS/camera metadata; masking is orthogonal and simply has nothing to
  // do here. So the artifact must exist, and it must be verified.
  const noFacesCall = calls.find((c) => /status:\s*\.noFaces/.test(c.argsText));
  assert.ok(noFacesCall, 'no call constructs status: .noFaces');

  assert.match(
    noFacesCall.argsText,
    /sanitizedUri:\s*"file:\/\/\\\(outputFile\.path\)"/,
    'noFaces must return a real sanitized artifact URI',
  );
  // Dimensions and checksum come from the OUTPUT VERIFIER, not from the input:
  // reporting input values for an output nobody verified is exactly the kind of
  // fabricated attestation the failure-result test below also forbids.
  assert.match(noFacesCall.argsText, /outputWidth:\s*outputWidth/);
  assert.match(noFacesCall.argsText, /outputHeight:\s*outputHeight/);
  assert.match(noFacesCall.argsText, /outputChecksum:\s*outputChecksum/);
  assert.match(noFacesCall.argsText, /verificationDurationMs:\s*verificationDurationMs/);

  // Nothing was drawn, so the engine must not claim it changed pixels or
  // masked anything.
  assert.match(noFacesCall.argsText, /pixelsChanged:\s*false/);
  assert.match(noFacesCall.argsText, /facesDetected:\s*0/);
  assert.match(noFacesCall.argsText, /facesMasked:\s*0/);
  assert.match(noFacesCall.argsText, /maskingDurationMs:\s*nil/);
});

test('the shared failure-result call never reports a fabricated output artifact or partial stage timing', () => {
  const failureCall = calls.find((c) => /status:\s*\.failed/.test(c.argsText));
  assert.ok(failureCall, 'no call constructs status: .failed');
  for (const field of [
    'outputWidth',
    'outputHeight',
    'sanitizedUri',
    'outputChecksum',
    'checksumAlgorithm',
    'detectionDurationMs',
    'maskingDurationMs',
    'encodingDurationMs',
    'verificationDurationMs',
  ]) {
    assert.match(
      failureCall.argsText,
      new RegExp(`${field}:\\s*nil`),
      `failure result must not fabricate ${field}`,
    );
  }
});

test('production Swift source under this module contains no XCTest import', () => {
  // Complements the release-target-scope test, at the source-content layer
  // rather than the podspec-glob layer: even if the podspec were somehow
  // bypassed, no file this module actually ships would import XCTest.
  const glob = require('glob');
  const swiftFiles = glob
    .sync('**/*.swift', { cwd: MODULE_DIR, nodir: true })
    .filter((f) => !f.split(path.sep).join('/').startsWith('Tests/'));
  assert.ok(swiftFiles.length > 0);
  for (const file of swiftFiles) {
    const contents = fs.readFileSync(path.join(MODULE_DIR, file), 'utf8');
    assert.doesNotMatch(contents, /^\s*import XCTest/m, `${file} imports XCTest`);
  }
});

test('the podspec still isolates Tests/ from the production glob', () => {
  const podspec = fs.readFileSync(path.join(MODULE_DIR, 'KScanPiiNative.podspec'), 'utf8');
  assert.match(podspec, /s\.exclude_files\s*=\s*"Tests\/\*\*\/\*"/);
  assert.match(podspec, /s\.test_spec\s+'Tests'/);
});
