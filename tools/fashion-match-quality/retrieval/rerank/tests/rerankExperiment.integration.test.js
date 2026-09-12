'use strict';

/**
 * End-to-end: the paired experiment over the real FMQ corpus.
 *
 * The control arm shells out to the real production L1 module via Deno. Where
 * `deno` is not on PATH these are SKIPPED, honestly and visibly, exactly as
 * FMQ's own l1/runL1.test.js already does - never silently passed by
 * substituting a fake control ordering, which would make the comparison
 * meaningless while still printing green.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runRerankExperiment, selectEmbedder, IMAGE_SOURCE_ATTRIBUTE } = require('../rerankExperiment');
const { isDenoAvailable } = require('../../controlArm');
const { censusCorpus } = require('../runRerankExperiment');
const { loadFullCorpus } = require('../../../corpus/corpusLoader');

const denoMissing = !isDenoAvailable();
const skipReason = { skip: denoMissing ? 'DENO_UNAVAILABLE: the real production L1 control arm cannot run here' : false };

function tmpCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-rerank-it-'));
}

test('EXPERIMENT: control and challenger score the identical candidate universe', skipReason, () => {
  const result = runRerankExperiment({ cacheDir: tmpCache(), imageSource: IMAGE_SOURCE_ATTRIBUTE });
  assert.ok(result.counts.scored > 0, 'at least one case must be scored');
  assert.strictEqual(result.counts.invalid, 0, 'no case may have a mismatched candidate universe');
  assert.strictEqual(result.universeIdentical, true);
  for (const c of result.cases.filter((x) => x.status === 'OK')) {
    assert.strictEqual(c.universe.controlHash, c.universe.challengerHash, `${c.fixtureId} universes must match`);
    assert.deepStrictEqual([...c.control.order].sort(), [...c.challenger.order].sort(), `${c.fixtureId} must be a permutation`);
  }
});

test('EXPERIMENT: both arms are scored by the same evaluator version', skipReason, () => {
  const result = runRerankExperiment({ cacheDir: tmpCache() });
  assert.ok(result.evaluator.rubricVersion);
  assert.match(result.evaluator.componentFieldResolutionVersion, /color-family-repair/);
});

test('EXPERIMENT: no run in this environment may claim real FashionCLIP execution', skipReason, () => {
  const result = runRerankExperiment({ cacheDir: tmpCache() });
  const availability = selectEmbedder({}).availability;
  if (!availability.available) {
    assert.strictEqual(result.executionIdentity.REAL_FASHIONCLIP_EXECUTED, false);
    assert.ok(result.executionIdentity.unmetPreconditions.length > 0);
    assert.notStrictEqual(result.embedder.provider, 'FASHIONCLIP');
  }
});

test('EXPERIMENT: re-running over a warm cache produces an identical ranking', skipReason, () => {
  const cacheDir = tmpCache();
  const cold = runRerankExperiment({ cacheDir });
  const warm = runRerankExperiment({ cacheDir });
  assert.deepStrictEqual(
    cold.cases.map((c) => c.challenger && c.challenger.order),
    warm.cases.map((c) => c.challenger && c.challenger.order),
    'a cached embedding must produce the same ranking as a freshly computed one',
  );
  const warmHits = warm.cases.filter((c) => c.status === 'OK').reduce((s, c) => s + c.embedding.cacheHits, 0);
  assert.ok(warmHits > 0, 'the second pass must actually be served from cache');
});

test('EXPERIMENT: the re-ranker responds to visual evidence (degraded-order mechanism probe)', skipReason, () => {
  const result = runRerankExperiment({ cacheDir: tmpCache() });
  const probe = result.mechanismProbe.results.filter((p) => p.status === 'OK');
  assert.ok(probe.length > 0);
  assert.strictEqual(result.mechanismProbe.label, 'MECHANISM_CHECK_NOT_QUALITY_EVIDENCE');
  const recovered = probe.reduce((s, p) => s + p.ranksRecovered, 0);
  assert.ok(recovered > 0, 'from a deliberately reversed ordering the re-ranker must pull the correct product upward');
});

test('CORPUS CENSUS: synthetic fixtures are never counted as real', () => {
  const { census, coverage } = censusCorpus(loadFullCorpus());
  assert.strictEqual(census.REAL, 0, 'this checkout has no approved real fixtures');
  assert.strictEqual(census.SANITIZED_REAL, 0);
  assert.ok(census.SYNTHETIC > 0);
  assert.strictEqual(census.UNKNOWN, 0);
  // A dimension with one value corpus-wide cannot separate two rankings; the
  // census must say so rather than implying coverage it does not have.
  assert.strictEqual(coverage.pattern.discriminative, false, 'pattern is solid-only in this corpus');
  assert.strictEqual(coverage.color.discriminative, true);
});
