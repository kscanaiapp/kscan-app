'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { archiveRows, destinationFacts, loadProductionReplay, replayArchives, titleCategoryProxy } = require('../security/release/scanner-live-certification/lib/archivedReplay');
const { assertEvidencePrivacy } = require('../security/release/scanner-live-certification/lib/report');
const corpus = require('../security/release/scanner-live-certification/corpus.json');
const root = path.resolve(__dirname, '..');
const reports = ['P1', 'P2', 'R1'].map(p => JSON.parse(fs.readFileSync(path.join(root, `docs/build35/scanner/evidence/${p}-report.json`), 'utf8')));

test('archived retrieval pairs R1 to actual recorded identification without new image/model work', () => {
  const rows = archiveRows(reports);
  assert.equal(rows.length, 21);
  assert.equal(rows.reduce((n, row) => n + row.offers.length, 0), 110);
  const original = rows.find(r => r.phase === 'P1' && r.key === 'T:hoodie');
  const replay = rows.find(r => r.phase === 'R1' && r.key === 'T:hoodie');
  assert.deepEqual(replay.identification, original.identification);
  assert.equal(original.offers.length, 0);
  assert.equal(replay.offers.length, 8);
  assert.equal(rows.find(r => r.phase === 'P1' && r.key === 'O:unbound').boundGarmentKey, null);
});

test('existing category precheck remains a proxy, and scrubbed destinations cannot prove invalid links or duplicate products', () => {
  const expected = corpus.images.find(i => i.id === 'A').expectedGarments.find(g => g.key === 'aviators');
  const proxy = titleCategoryProxy([{ title: 'Optical Eyeglasses Frames' }], expected);
  assert.equal(proxy.matching, 1); // Existing broad eyewear category behavior, not visual proof.
  const facts = destinationFacts([
    { destination: { https: true, host: 'www.google.com', path: '/search' } },
    { destination: { https: true, host: 'www.google.com', path: '/search' } },
  ]);
  assert.equal(facts.repeatedHostPathSummaries, 1);
  assert.equal(facts.aggregatorSearchSummaries, 2);
  assert.equal(facts.actualDuplicateListingRate, null);
  assert.equal(facts.actualInvalidOrUnusableDestinationRate, null);
});

test('actual production scoring and diversity run on archives with missing inputs intact and bounded evidence report', () => {
  const production = loadProductionReplay(root);
  let calls = 0;
  const original = production.agreement.scoreProductAgreement;
  production.agreement.scoreProductAgreement = (product, ...args) => {
    calls++;
    assert.equal(product.imageUrl, undefined);
    assert.equal(product.productUrl, undefined);
    assert.equal(product.brand, undefined);
    return original(product, ...args);
  };
  const report = replayArchives({ reports, corpus, production });
  assert.equal(calls, 110);
  assert.equal(report.summary.queries, 21);
  assert.equal(report.summary.currencyMissing, 110);
  assert.equal(report.summary.before.visualPrecisionAt3, null);
  assert.equal(report.summary.after.certifiedHitAt3, null);
  assert.equal(report.summary.after.wrongBrandTopThreeRate, null);
  assert.equal(report.thresholds.appliedForCertification, false);
  assert.equal(report.summary.byPhase.R1.historicalCommerceLatencyMs.p95, 3113);
  assert(Object.keys(production.provenance.modules).includes('supabase/functions/scan-identify/commerceRelevanceAgreement.ts'));
  assert.match(production.provenance.closureDigest, /^[a-f0-9]{64}$/);
  assertEvidencePrivacy(report);
});
