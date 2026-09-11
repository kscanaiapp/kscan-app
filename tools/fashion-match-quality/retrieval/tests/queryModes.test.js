'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildRetrievalIndex, selectEmbedder } = require('../buildIndex');
const { imageToImageQuery, textToImageQuery, CANONICAL_TEXT_QUERIES } = require('../queryModes');

function tempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-querymodes-test-'));
}

test('QUERY MODES: image->image returns Top-1/5/10-shaped ranked results with all required fields', () => {
  const cacheDir = tempCacheDir();
  try {
    const built = buildRetrievalIndex({ cacheDir });
    const embedderChoice = selectEmbedder();
    const result = imageToImageQuery(built.index, 'query-garment-A', embedderChoice, { cacheDir, topK: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'image_to_image');
    assert.equal(result.results.length, 5);
    for (const r of result.results) {
      assert.equal(typeof r.candidateId, 'string');
      assert.equal(typeof r.rank, 'number');
      assert.equal(typeof r.similarityScore, 'number');
      assert.equal(typeof r.modelRevision, 'string');
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('QUERY MODES: image->image is deterministic - the same query image id returns identical ranked output on repeat', () => {
  const cacheDir = tempCacheDir();
  try {
    const built = buildRetrievalIndex({ cacheDir });
    const embedderChoice = selectEmbedder();
    const first = imageToImageQuery(built.index, 'query-garment-B', embedderChoice, { cacheDir, topK: 5 });
    const second = imageToImageQuery(built.index, 'query-garment-B', embedderChoice, { cacheDir, topK: 5 });
    assert.deepEqual(first.results, second.results);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('QUERY MODES: text->image uses only verified canonical-ontology-term queries (no free-form text)', () => {
  const { CANONICAL_CATEGORIES } = require('../../../fashion-ontology/categories');
  const { CANONICAL_COLORS } = require('../../../fashion-ontology/colors');
  const { CANONICAL_MATERIALS } = require('../../../fashion-ontology/materials');
  const { SUBTYPES } = require('../../../fashion-ontology/categories');

  const colorValues = new Set(CANONICAL_COLORS.map((c) => c.value));
  const materialValues = new Set(CANONICAL_MATERIALS.map((m) => m.value));
  const subtypeAliases = new Set(SUBTYPES.flatMap((s) => s.aliases));

  for (const q of CANONICAL_TEXT_QUERIES) {
    const words = q.split(' ');
    assert.ok(colorValues.has(words[0]), `${q}: expected ${words[0]} to be a canonical color value`);
    assert.ok(materialValues.has(words[1]), `${q}: expected ${words[1]} to be a canonical material value`);
    const subtypePhrase = words.slice(2).join(' ');
    assert.ok(subtypeAliases.has(subtypePhrase), `${q}: expected "${subtypePhrase}" to be a canonical subtype alias`);
  }
  assert.ok(CANONICAL_CATEGORIES.length > 0); // sanity: the ontology package actually loaded
});

test('QUERY MODES: text->image returns Top-K ranked results and echoes the query text', () => {
  const cacheDir = tempCacheDir();
  try {
    const built = buildRetrievalIndex({ cacheDir });
    const embedderChoice = selectEmbedder();
    const result = textToImageQuery(built.index, CANONICAL_TEXT_QUERIES[0], embedderChoice, { cacheDir, topK: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'text_to_image');
    assert.equal(result.query, CANONICAL_TEXT_QUERIES[0]);
    assert.equal(result.results.length, 3);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('QUERY MODES: text->image is deterministic - the same query text returns identical ranked output on repeat', () => {
  const cacheDir = tempCacheDir();
  try {
    const built = buildRetrievalIndex({ cacheDir });
    const embedderChoice = selectEmbedder();
    const first = textToImageQuery(built.index, CANONICAL_TEXT_QUERIES[1], embedderChoice, { cacheDir, topK: 5 });
    const second = textToImageQuery(built.index, CANONICAL_TEXT_QUERIES[1], embedderChoice, { cacheDir, topK: 5 });
    assert.deepEqual(first.results, second.results);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
