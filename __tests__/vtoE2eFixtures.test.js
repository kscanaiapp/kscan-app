#!/usr/bin/env node
'use strict';

/**
 * VTO E2E harness — fixture generator contract (spec Phase 4.2 `contract`
 * mode / Phase 7). No live staging mutation: these fixtures are pure,
 * deterministic, local functions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadFixtures() {
  return import('../scripts/vto-e2e/lib/fixtures.mjs');
}

test('person fixture is approximately 400x600, garment approximately 300x300', async () => {
  const { buildVtoFixtures } = await loadFixtures();
  const { person, garment } = buildVtoFixtures('contract-test');
  assert.equal(person.width, 400);
  assert.equal(person.height, 600);
  assert.equal(garment.width, 300);
  assert.equal(garment.height, 300);
});

test('fixtures are valid, well-above-floor, well-below-ceiling PNGs with no EXIF/XMP chunks', async () => {
  const { buildVtoFixtures } = await loadFixtures();
  const { person, garment } = buildVtoFixtures('contract-test');
  for (const fixture of [person, garment]) {
    // PNG signature.
    assert.deepEqual(Array.from(fixture.buffer.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Only IHDR, IDAT, IEND chunks — no eXIf, no tEXt/iTXt/zTXt, no ancillary
    // metadata of any kind, by construction of the encoder.
    const chunkTypes = [];
    let offset = 8;
    while (offset < fixture.buffer.length) {
      const length = fixture.buffer.readUInt32BE(offset);
      const type = fixture.buffer.toString('ascii', offset + 4, offset + 8);
      chunkTypes.push(type);
      offset += 8 + length + 4;
    }
    assert.deepEqual(chunkTypes, ['IHDR', 'IDAT', 'IEND']);
    // Comfortably above the provider's previously-proven 5KB floor.
    assert.ok(fixture.byteLength > 5 * 1024, `fixture too small: ${fixture.byteLength}`);
    // Well below VTO_PERSON_PAYLOAD_MAX_CHARS (2,000,000) as a data URI, and
    // far below the provider's documented upstream limits.
    assert.ok(fixture.dataUri.length < 2_000_000, `data URI too large: ${fixture.dataUri.length}`);
  }
});

test('fixture generation is fully deterministic from its seed — same seed, same bytes, same hash', async () => {
  const { buildVtoFixtures } = await loadFixtures();
  const a = buildVtoFixtures('determinism-check');
  const b = buildVtoFixtures('determinism-check');
  assert.equal(a.person.sha256, b.person.sha256);
  assert.equal(a.garment.sha256, b.garment.sha256);
  assert.deepEqual(a.person.buffer, b.person.buffer);
});

test('different run tags produce different fixtures (no cross-run identity collision)', async () => {
  const { buildVtoFixtures } = await loadFixtures();
  const a = buildVtoFixtures('run-a');
  const b = buildVtoFixtures('run-b');
  assert.notEqual(a.person.sha256, b.person.sha256);
  assert.notEqual(a.garment.sha256, b.garment.sha256);
});

test('fixtureEvidence never carries raw bytes or the data URI — hashes/sizes/dimensions only', async () => {
  const { buildVtoFixtures, fixtureEvidence } = await loadFixtures();
  const { person } = buildVtoFixtures('evidence-check');
  const evidence = fixtureEvidence(person);
  assert.deepEqual(Object.keys(evidence).sort(), ['byteLength', 'height', 'seedLabel', 'sha256', 'width']);
  assert.equal(JSON.stringify(evidence).includes('data:image'), false);
});

test('the committed garment asset used by staging-full-certification matches its recorded evidence sidecar', () => {
  const evidencePath = path.join(__dirname, '..', 'scripts', 'vto-e2e', 'fixtures', 'garment.fixture.json');
  const assetPath = path.join(__dirname, '..', 'scripts', 'vto-e2e', 'fixtures', 'garment.png');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const bytes = fs.readFileSync(assetPath);
  const crypto = require('node:crypto');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), evidence.sha256);
  assert.equal(bytes.byteLength, evidence.byteLength);
  assert.equal(evidence.width, 300);
  assert.equal(evidence.height, 300);
  assert.ok(evidence.byteLength > 5 * 1024);
});
