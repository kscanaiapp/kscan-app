'use strict';

// Replay extension to the existing corpus/scoring authority. Never calls a provider.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const scoring = require('./scoring');
const { summarize } = require('./report');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Load the actual pure production TS modules, with no network or secret access. */
function loadProductionReplay(backendRoot) {
  const root = fs.realpathSync(backendRoot);
  const functionsRoot = path.join(root, 'supabase/functions');
  const files = new Map();
  const cache = new Map();
  const denied = () => { throw new Error('Archived replay cannot access a network/provider'); };
  function load(filename) {
    const resolved = fs.realpathSync(filename);
    if (!resolved.startsWith(functionsRoot + path.sep)) throw new Error('Replay module escaped backend function closure');
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const source = fs.readFileSync(resolved, 'utf8');
    files.set(path.relative(root, resolved).replace(/\\/g, '/'), sha256(source));
    const mod = { exports: {} };
    cache.set(resolved, mod);
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const context = { module: mod, exports: mod.exports, URL, console: { log() {}, warn() {}, error() {} }, fetch: denied, Deno: { env: { get: () => undefined } }, require: (id) => {
      if (!id.startsWith('.') || !id.endsWith('.ts')) throw new Error(`Replay refuses runtime dependency ${id}`);
      return load(path.resolve(path.dirname(resolved), id));
    } };
    vm.runInNewContext(js, context, { filename: resolved, timeout: 5000 });
    return mod.exports;
  }
  const agreement = load(path.join(functionsRoot, 'scan-identify/commerceRelevanceAgreement.ts'));
  const diversity = load(path.join(functionsRoot, 'scan-identify/commerceRelevanceDiversity.ts'));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sorted = [...files].sort(([a], [b]) => a.localeCompare(b));
  const moduleMatchesHead = Object.fromEntries(sorted.map(([file, hash]) => {
    const original = spawnSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' });
    return [file, original.status === 0 ? sha256(original.stdout) === hash : null];
  }));
  return { agreement, diversity, provenance: { head: git.status === 0 ? git.stdout.trim() : null, modules: Object.fromEntries(sorted), moduleMatchesHead, closureDigest: sha256(JSON.stringify(sorted)), environmentRead: false, replayIdentityFlag: false } };
}

function archiveRows(reports) {
  const originals = new Map();
  const rows = [];
  for (const report of reports) {
    for (const flow of report.results ?? []) {
      for (const item of flow.items ?? []) {
        const key = `${item.imageId}:${item.boundGarmentKey ?? 'unbound'}`;
        const row = { phase: report.phase, key, imageId: item.imageId, boundGarmentKey: item.boundGarmentKey, identification: item.selected?.response?.identification ?? null, offers: item.offers ?? [], latencyMs: item.commerce?.latencyMs ?? null, errorType: item.commerce?.errorType ?? null, providers: item.commerce?.providers ?? [], outcome: item.commerce?.uiStatus ?? null };
        rows.push(row);
        if (report.phase === 'P1') originals.set(key, row);
      }
      for (const item of flow.replayed ?? []) {
        const original = originals.get(item.key);
        rows.push({ phase: report.phase, key: item.key, imageId: original?.imageId ?? item.key.split(':')[0], boundGarmentKey: original?.boundGarmentKey ?? null, identification: original?.identification ?? null, offers: item.offers ?? [], latencyMs: item.latencyMs ?? null, errorType: item.errorType ?? null, providers: item.providers ?? [], outcome: item.outcome ?? null });
      }
    }
  }
  return rows;
}

function destinationKey(offer) {
  const d = offer?.destination;
  return d && typeof d.host === 'string' && typeof d.path === 'string' ? `${d.host.toLowerCase()}${d.path.replace(/\/$/, '')}` : null;
}
function destinationFacts(offers) {
  const keys = offers.map(destinationKey).filter(Boolean);
  return {
    offers: offers.length,
    missingDestinationSummary: offers.filter(o => !destinationKey(o)).length,
    summaryFailsExistingShapeCheck: offers.filter(o => !scoring.destinationValid(o)).length,
    repeatedHostPathSummaries: keys.length - new Set(keys).size,
    aggregatorSearchSummaries: offers.filter(o => /(^|\.)google\./i.test(o.destination?.host ?? '') && o.destination?.path === '/search').length,
    // Queries, redirects and product ids were scrubbed: neither a duplicate
    // listing nor an actionable destination is established by these summaries.
    actualDuplicateListingRate: null,
    actualInvalidOrUnusableDestinationRate: null,
  };
}
function titleCategoryProxy(offers, expected) {
  if (!expected) return { scored: false, denominator: 0, matching: null, incompatible: null, hit: null };
  const top = offers.slice(0, 3).map(o => scoring.offerPrecheck(expected, o));
  return { scored: true, denominator: top.length, matching: top.filter(p => p.titleMatchesCategory).length, incompatible: top.filter(p => p.titleIncompatible).length, hit: top.some(p => p.titleMatchesCategory) };
}
function proxySummary(rows, side) {
  const eligible = rows.filter(r => r[side].scored);
  const returned = eligible.filter(r => r[side].denominator > 0);
  const count = returned.reduce((n, r) => n + r[side].denominator, 0);
  return {
    corpusBoundQueries: eligible.length,
    queriesReturningAnyOffer: returned.length,
    topThreeOffersInspected: count,
    titleCategoryMatchShareAmongReturnedTopThree: count ? returned.reduce((n, r) => n + r[side].matching, 0) / count : null,
    titleIncompatibilityShareAmongReturnedTopThree: count ? returned.reduce((n, r) => n + r[side].incompatible, 0) / count : null,
    titleCategoryHitShareIncludingEmptyQueries: eligible.length ? eligible.filter(r => r[side].hit).length / eligible.length : null,
    visualPrecisionAt3: null,
    certifiedHitAt3: null,
    wrongBrandTopThreeRate: null,
  };
}

function replayArchives({ reports, corpus, production, historicalVersionNotes = {} }) {
  const rows = archiveRows(reports).map(row => {
    const expected = corpus.images.find(i => i.id === row.imageId)?.expectedGarments.find(g => g.key === row.boundGarmentKey);
    // The report deliberately removed full URLs/images/brands. Keep those
    // fields missing; do not invent a destination or image to pass a filter.
    const scored = row.identification ? row.offers.map((offer, originalIndex) => {
      const product = { title: offer.title, source: offer.retailer, price: offer.price, currency: offer.currency, archiveRank: offer.rank ?? originalIndex + 1 };
      const result = production.agreement.scoreProductAgreement(product, row.identification, null, null);
      return { product, agreementScore: result.score, agreementBand: result.band, clearCategoryConflict: result.clearCategoryConflict, originalIndex };
    }) : [];
    const selected = production.diversity.selectByAgreementCoverage(scored);
    const order = production.diversity.applySoftDiversityRerank(selected);
    const reordered = order.map(p => row.offers[(p.archiveRank ?? 1) - 1]).filter(Boolean);
    return {
      ...row,
      expectedCorpusKey: expected ? `${row.imageId}:${expected.key}` : null,
      before: titleCategoryProxy(row.offers, expected),
      after: titleCategoryProxy(reordered, expected),
      archiveFacts: destinationFacts(row.offers),
      replay: {
        mode: 'metadata_only_production_agreement_coverage_and_diversity',
        // Neither provider/URL validation nor the complete retrieval path ran.
        returnedArchiveRanks: order.map(p => p.archiveRank),
        scored: scored.map(s => ({ archiveRank: s.product.archiveRank, score: s.agreementScore, band: s.agreementBand, categoryConflict: s.clearCategoryConflict })),
        rerankedTitleSample: reordered.slice(0, 3).map(o => o.title),
      },
      observability: { imagesAvailable: 0, fullDestinationsAvailable: 0, providerBrandsAvailable: 0, currencyMissing: row.offers.filter(o => !o.currency).length, modelsIndependentlyKnown: 0, wrongBrandRate: null, wrongModelFamilyRate: null },
    };
  });
  const archiveOffers = rows.flatMap(r => r.offers);
  const byPhase = Object.fromEntries(reports.map(report => {
    const subset = rows.filter(r => r.phase === report.phase);
    return [report.phase, { queries: subset.length, emptyQueries: subset.filter(r => !r.offers.length).length, providerOrTimeoutErrors: subset.filter(r => r.errorType).map(r => ({ key: r.key, errorType: r.errorType })), historicalCommerceLatencyMs: summarize(subset.map(r => r.latencyMs).filter(Number.isFinite)), before: proxySummary(subset, 'before'), after: proxySummary(subset, 'after') }];
  }));
  return {
    schema: 'scanner-archived-retailer-metadata-replay-1',
    executionMode: 'OFFLINE_REPLAY_NO_PROVIDER_CALLS',
    productionSource: production.provenance,
    thresholds: { source: 'security/release/scanner-live-certification/corpus.json', changed: false, appliedForCertification: false },
    archives: reports.map(r => ({ phase: r.phase, generatedAt: r.generatedAt, historicalRunMode: r.runMode, harnessSource: r.source, configuredProvidersObserved: [...new Set(rows.filter(row => row.phase === r.phase).flatMap(row => row.providers))], backendVersionInReport: null, historicalVersionNote: historicalVersionNotes[r.phase] ?? null, backendBundleHashInReport: null, effectiveFlagsInReport: null, historicalLatencyMs: r.summary?.latencyMs ?? null })),
    summary: { queries: rows.length, offers: archiveOffers.length, emptyQueries: rows.filter(r => !r.offers.length).length, currencyMissing: archiveOffers.filter(o => !o.currency).length, before: proxySummary(rows, 'before'), after: proxySummary(rows, 'after'), destinations: destinationFacts(archiveOffers), byPhase },
    limitations: [
      'Historical real Staging retailer responses only; no current provider retrieval or deployed end-to-end test.',
      'Uses existing offerPrecheck category-word proxy, not visual or manually rubric-graded precision@3; pinned certification thresholds are unchanged and not certified.',
      'The existing broad category-word proxy may accept optical glasses for sunglasses or a different same-category shape; it cannot establish subtype, material, model or visual similarity.',
      'No archive has product images, provider-declared manufacturer brands, model authority or complete purchase URLs; currency is missing on the returned offers.',
      'Full URLs, queries and redirects were scrubbed. Repeated host/path is not a proven duplicate listing; google.com/search is an aggregator summary, not proof that its original product destination was unusable.',
      'Production agreement code sees missing image/URL fields and applies its normal missing-data penalties. Full candidate validation is not replayed; no fields are fabricated to pass it.',
      'Original identifications are replayed unchanged, so historical category/subtype mistakes remain. This does not measure repaired vision accuracy.',
      'Historical latency is reported separately. Offline scoring runtime is not a new scan latency, first-useful-result measurement or five-second certification.',
      'No owner reference photograph, paid model/provider call, Staging mutation or device certification was used.',
    ],
    rows,
  };
}

module.exports = { archiveRows, destinationFacts, loadProductionReplay, replayArchives, titleCategoryProxy };
