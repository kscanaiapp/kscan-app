/**
 * Canonical fashion identification v2 contract parity (Phase 2B).
 *
 * WHY THIS EXISTS: the contract has to be usable from three runtimes — Deno
 * Edge Functions, the React Native client, and plain Node tests. Deno modules
 * use explicit `.ts` import specifiers the RN bundler cannot resolve, so a
 * single imported module is not possible without adding build tooling. The
 * vocabularies are therefore mirrored deliberately, and held identical HERE
 * rather than by convention.
 *
 * If someone adds a status to the backend and forgets the client (or the
 * schema), this test fails. That is the entire point: Phase 2A found paths that
 * had silently drifted into different visual taxonomies, and a mirrored
 * contract without a parity gate would reintroduce exactly that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'contracts', 'fashion-identification-v2.schema.json');
const BACKEND_MIRROR = path.join(
  ROOT, 'supabase', 'functions', '_shared', 'fashionIdentificationV2.ts',
);
const CLIENT_MIRROR = path.join(ROOT, 'types', 'fashionIdentificationV2.ts');

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const backendSource = fs.readFileSync(BACKEND_MIRROR, 'utf8');
const clientSource = fs.readFileSync(CLIENT_MIRROR, 'utf8');

/**
 * Extracts `export const NAME = ['a', 'b'] as const;` from a TS mirror.
 * Intentionally a literal-only reader: if a mirror ever computes its vocabulary
 * at runtime the extraction fails loudly instead of silently passing.
 */
function extractVocabulary(source, name) {
  const pattern = new RegExp(
    `export const ${name} = \\[([\\s\\S]*?)\\] as const;`,
  );
  const match = source.match(pattern);
  assert.ok(match, `Vocabulary ${name} not found as a literal array`);
  const body = match[1];
  const values = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(values.length > 0, `Vocabulary ${name} extracted empty`);
  return values;
}

/** The schema enum each mirrored vocabulary must equal, exactly and in order. */
const VOCABULARIES = [
  ['FASHION_IDENTIFICATION_INTENTS', 'intent'],
  ['FASHION_IDENTIFICATION_MODES', 'mode'],
  ['FASHION_IDENTIFICATION_ENTRY_PATHS', 'entryPath'],
  ['FASHION_IDENTIFICATION_PLATFORMS', 'platform'],
  ['FASHION_IDENTIFICATION_ANGLE_HINTS', 'angleHint'],
  ['FASHION_IDENTIFICATION_STATUSES', 'status'],
  ['FASHION_IDENTIFICATION_RESOLUTION_LEVELS', 'resolutionLevel'],
  ['FASHION_IDENTIFICATION_BRAND_PROVENANCES', 'brandProvenance'],
];

for (const [constName, definition] of VOCABULARIES) {
  test(`${definition} vocabulary is identical in schema, backend, and client`, () => {
    const schemaEnum = schema.definitions[definition].enum;
    assert.ok(Array.isArray(schemaEnum), `schema.definitions.${definition}.enum missing`);

    assert.deepEqual(
      extractVocabulary(backendSource, constName),
      schemaEnum,
      `backend mirror drifted from schema for ${definition}`,
    );
    assert.deepEqual(
      extractVocabulary(clientSource, constName),
      schemaEnum,
      `client mirror drifted from schema for ${definition}`,
    );
  });
}

test('contract version string is identical across schema and both mirrors', () => {
  assert.equal(schema['x-contract-version'], 'fashion-identification-v2');
  assert.deepEqual(schema.definitions.contractVersion.enum, ['fashion-identification-v2']);
  for (const [label, source] of [['backend', backendSource], ['client', clientSource]]) {
    const match = source.match(
      /export const FASHION_IDENTIFICATION_CONTRACT_V2 = '([^']+)' as const;/,
    );
    assert.ok(match, `${label} mirror does not declare the contract version literal`);
    assert.equal(match[1], 'fashion-identification-v2', `${label} mirror version drifted`);
  }
});

test('identify_only is absent from every layer', () => {
  // Phase 2B addendum 2: exactly two active intents. An unused branch would be
  // untested surface area that later reads as supported.
  assert.ok(!schema.definitions.intent.enum.includes('identify_only'));
  assert.ok(!/identify_only/.test(backendSource), 'backend mirror references identify_only');
  assert.ok(!/identify_only/.test(clientSource), 'client mirror references identify_only');
});

test('privacy attestation is pinned to false in schema and both mirrors', () => {
  // Face/plate masking is deferred, so the contract must make a true value
  // unrepresentable rather than merely discouraged.
  const privacy = schema.definitions.privacy.properties;
  for (const field of ['localFaceMaskApplied', 'localPlateMaskApplied', 'rawExifTransmitted']) {
    assert.deepEqual(privacy[field].enum, [false], `${field} is not pinned false in schema`);
  }
  assert.deepEqual(
    schema.definitions.privacy.required,
    ['localFaceMaskApplied', 'localPlateMaskApplied', 'rawExifTransmitted'],
  );
  for (const [label, source] of [['backend', backendSource], ['client', clientSource]]) {
    const block = source.match(
      /export type FashionIdentificationPrivacyV2 = \{([\s\S]*?)\};/,
    );
    assert.ok(block, `${label} mirror is missing FashionIdentificationPrivacyV2`);
    assert.match(block[1], /localFaceMaskApplied: false;/, `${label}: face flag not literal false`);
    assert.match(block[1], /localPlateMaskApplied: false;/, `${label}: plate flag not literal false`);
    assert.match(block[1], /rawExifTransmitted: false;/, `${label}: exif flag not literal false`);
  }
});

test('schema pins the Phase 2B one-evidence-per-request transport boundary', () => {
  // The domain contract stays array-based for Phase 2D, but a single HTTP
  // invocation must not carry a multi-image Base64 body.
  const evidence = schema.definitions.request.properties.evidence;
  assert.equal(evidence.type, 'array');
  assert.equal(evidence.minItems, 1);
  assert.equal(evidence.maxItems, 1);
});

test('entry paths are specific and never collapse to a generic camera/upload', () => {
  const paths = schema.definitions.entryPath.enum;
  for (const required of [
    'scanner_camera',
    'scanner_gallery',
    'elise_camera',
    'elise_gallery',
    'elise_header_gallery',
    'scanner_handoff',
  ]) {
    assert.ok(paths.includes(required), `entryPath is missing ${required}`);
  }
  assert.ok(!paths.includes('camera'), 'entryPath must not contain a generic camera');
  assert.ok(!paths.includes('upload'), 'entryPath must not contain a generic upload');
});

test('every confidence dimension is independently nullable', () => {
  // The provider supplies one broad score. The contract must be able to say
  // "not supported" per dimension rather than forcing a copied number.
  const confidence = schema.definitions.result.properties.confidence.properties;
  for (const field of ['category', 'subtype', 'brand', 'modelFamily', 'exactProduct']) {
    assert.deepEqual(
      confidence[field].type,
      ['number', 'null'],
      `confidence.${field} must be nullable`,
    );
  }
  // The single broad score is retained truthfully in its own place.
  assert.deepEqual(
    schema.definitions.result.properties.compatibility.properties.globalConfidence.type,
    ['number', 'null'],
  );
});

test('visual uncertainty and technical failure are distinct statuses', () => {
  const statuses = schema.definitions.status.enum;
  assert.ok(statuses.includes('insufficient_visual_evidence'));
  assert.ok(statuses.includes('technical_failure'));
  assert.notEqual(
    statuses.indexOf('insufficient_visual_evidence'),
    statuses.indexOf('technical_failure'),
  );
});

test('evidence transport is exactly one of base64 or authorized reference', () => {
  const transport = schema.definitions.transport;
  assert.ok(Array.isArray(transport.oneOf), 'transport must be a oneOf');
  assert.equal(transport.oneOf.length, 2);
  const types = transport.oneOf.map((entry) => entry.properties.type.enum[0]);
  assert.deepEqual(types.sort(), ['authorized_image_reference', 'jpeg_base64']);
  for (const entry of transport.oneOf) {
    assert.equal(entry.additionalProperties, false, 'transport variants must be closed');
  }
});

test('raw EXIF cannot be carried as an open-ended metadata object', () => {
  const metadata = schema.definitions.imageMetadata;
  assert.equal(metadata.additionalProperties, false);
  assert.deepEqual(metadata.properties.schemaVersion.enum, ['image-metadata-v1']);
  assert.ok(!Object.keys(metadata.properties).some((key) => /exif/i.test(key)));
});
