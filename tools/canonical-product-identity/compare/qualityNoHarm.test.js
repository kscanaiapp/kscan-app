'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runQualityNoHarmCheck } = require('./qualityNoHarm');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');

// spec section 43#21: Fashion Match Quality [no-harm] comparison runs (spec section 28).
test('QUALITY NO-HARM: runs end-to-end on the real corpus and produces a per-window identity/substitute verdict', () => {
  const corpus = loadSyntheticCorpus();
  const result = runQualityNoHarmCheck(corpus, { kSizes: [10] });
  assert.ok(result.perWindow.length > 0);
  for (const w of result.perWindow) {
    assert.ok(['SAFE', 'HARM'].includes(w.identityQuality.verdict));
    assert.ok(['SAFE', 'TRADEOFF'].includes(w.substituteQuality.verdict));
  }
  assert.ok(['SAFE', 'TRADEOFF', 'HARM'].includes(result.summary.overallVerdict));
});

test('QUALITY NO-HARM: is explicitly labeled as a proxy, never presented as the Fashion Match Quality Lab\'s own rubric output', () => {
  const corpus = loadSyntheticCorpus();
  const result = runQualityNoHarmCheck(corpus, { kSizes: [10] });
  assert.match(result.measurementBasis, /PROXY/);
});

test('QUALITY NO-HARM: on the real corpus at the shipped default operating point, identity quality is SAFE everywhere (zero silent product collapses)', () => {
  const corpus = loadSyntheticCorpus();
  const result = runQualityNoHarmCheck(corpus);
  assert.equal(result.summary.identityHarmWindowCount, 0);
});
