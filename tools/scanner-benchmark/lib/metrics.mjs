// Benchmark metrics. Pure: (manifest cases, result records, pricing) -> report.
//
// No targets or pass/fail thresholds live here. Every metric reports its
// numerator, denominator and the reason it is null when it cannot be computed.

import { classifyDestination } from './destination.mjs';
import { brandClaimSupported, categoryCorrect, gradeAlternative, judgeExactProduct } from './judge.mjs';

const ratio = (num, den, note) => ({ value: den > 0 ? num / den : null, numerator: num, denominator: den, ...(den > 0 ? {} : { note: note ?? 'no eligible observations' }) });

export function percentile(values, p) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length, Math.max(1, rank)) - 1];
}

/** The confidence claim an offer makes, from the newest contract the response carries. */
export function offerClaim(offer) {
  const cls = offer?.matchConfidence?.class;
  if (cls) return cls; // B42 match confidence v1
  const tier = offer?.matchMetadata?.tier;
  if (tier === 'exact') return 'verified_exact';
  if (tier === 'same_brand') return 'same_brand';
  if (tier === 'similar') return 'similar';
  return 'unlabelled';
}

const isExactClaim = (offer) => offerClaim(offer) === 'verified_exact';

/**
 * @param {Array} cases   manifest cases ({ caseId, stratum, labels })
 * @param {Array} results result records ({ caseId, identification, offers, timings, cost })
 * @param {object} pricing { geminiInputPerMTok, geminiOutputPerMTok, commercePerCall: {provider: usd} }
 */
export function computeMetrics(cases, results, pricing = null) {
  const byId = new Map(cases.map((c) => [c.caseId, c]));
  const scored = results.filter((r) => byId.has(r.caseId));
  const unknownCaseIds = results.filter((r) => !byId.has(r.caseId)).map((r) => r.caseId);

  let exactClaims = 0, exactClaimsCorrect = 0, casesWithWrongExact = 0, casesWithExactClaim = 0;
  let probableClaims = 0, probableCorrect = 0;
  let knowable = 0, knowableTop1 = 0, knowableTop3 = 0, knowableTop10 = 0;
  const altGrades = []; let altHit3 = 0, altCases = 0;
  let offers = 0; const dest = { direct: 0, search_handoff: 0, invalid: 0 };
  const actionable = []; let noActionable = 0, commerceAttempted = 0;
  let idEligible = 0, idCategoryCorrect = 0, nonFashionCases = 0, nonFashionRejected = 0;
  let brandClaims = 0, unsupportedBrandClaims = 0;
  const cost = { geminiInputTokens: 0, geminiOutputTokens: 0, commerceCalls: {}, measuredCases: 0, estimatedCases: 0 };
  const strata = {};
  const stratum = (s) => (strata[s] ??= { cases: 0, exactClaims: 0, wrongExactCases: 0, knowable: 0, knowableTop3: 0, altGradeSum: 0, altGradeN: 0, offers: 0, direct: 0 });

  for (const r of scored) {
    const c = byId.get(r.caseId);
    const L = c.labels;
    const st = stratum(c.stratum);
    st.cases++;
    const list = Array.isArray(r.offers) ? r.offers : [];

    // Identification
    if (L.nonFashion) {
      nonFashionCases++;
      if (r.identification?.status === 'non_fashion') nonFashionRejected++;
    } else if (r.identification) {
      idEligible++;
      if (categoryCorrect(r.identification.category, L)) idCategoryCorrect++;
    }
    const claimed = r.identification?.brand?.value ?? null;
    // brand.visible === null: legibility unknown (derived variants) -> not scored.
    if (claimed && L.brand?.visible !== null) {
      brandClaims++;
      if (!brandClaimSupported(claimed, L)) unsupportedBrandClaims++;
    }

    // Exact claims and exact-product retrieval
    let caseHasExact = false, caseWrongExact = false;
    list.forEach((o, i) => {
      const verdict = judgeExactProduct(o, L.exactProduct);
      if (isExactClaim(o)) {
        exactClaims++; st.exactClaims++; caseHasExact = true;
        if (verdict === 'exact_product') exactClaimsCorrect++; else caseWrongExact = true;
      }
      if (offerClaim(o) === 'probable') {
        probableClaims++;
        if (verdict === 'exact_product') probableCorrect++;
      }
      offers++; st.offers++;
      const d = classifyDestination(o.productUrl ?? o.destination ?? o.url ?? o.link);
      dest[d]++; if (d === 'direct') st.direct++;
      if (i === 0 && verdict === 'exact_product') knowableTop1++;
    });
    if (caseHasExact) casesWithExactClaim++;
    if (caseWrongExact) { casesWithWrongExact++; st.wrongExactCases++; }
    if (L.exactProduct?.knowable) {
      knowable++; st.knowable++;
      const ranks = list.map((o, i) => (judgeExactProduct(o, L.exactProduct) === 'exact_product' ? i : -1)).filter((i) => i >= 0);
      const best = ranks.length ? Math.min(...ranks) : Infinity;
      if (best < 3) { knowableTop3++; st.knowableTop3++; }
      if (best < 10) knowableTop10++;
    }

    // Alternative relevance: offers that are not correct exact-product listings
    if (!L.nonFashion && list.length > 0) {
      const alts = list.filter((o) => judgeExactProduct(o, L.exactProduct) !== 'exact_product').slice(0, 3);
      if (alts.length > 0) {
        altCases++;
        const g = alts.map((o) => gradeAlternative(o, L));
        g.forEach((x) => { altGrades.push(x); st.altGradeSum += x; st.altGradeN++; });
        if (g.some((x) => x >= 2)) altHit3++;
      }
    }

    // Latency to first actionable result (machine time; user selection time excluded)
    if (!L.nonFashion && r.commerceAttempted !== false) {
      commerceAttempted++;
      const t = r.timings ?? {};
      if (list.length > 0 && typeof t.commerceMs === 'number') {
        actionable.push((t.detectionMs ?? 0) + (t.selectedMs ?? 0) + t.commerceMs);
      } else {
        noActionable++;
      }
    }

    // Cost inputs
    if (r.cost) {
      if (r.cost.source === 'measured') cost.measuredCases++; else cost.estimatedCases++;
      cost.geminiInputTokens += r.cost.geminiInputTokens ?? 0;
      cost.geminiOutputTokens += r.cost.geminiOutputTokens ?? 0;
      for (const [p, n] of Object.entries(r.cost.commerceCalls ?? {})) cost.commerceCalls[p] = (cost.commerceCalls[p] ?? 0) + n;
    }
  }

  let providerCostUsd = null;
  if (pricing && (cost.measuredCases + cost.estimatedCases) > 0) {
    const gem = (cost.geminiInputTokens / 1e6) * pricing.geminiInputPerMTok + (cost.geminiOutputTokens / 1e6) * pricing.geminiOutputPerMTok;
    const com = Object.entries(cost.commerceCalls).reduce((s, [p, n]) => s + n * (pricing.commercePerCall?.[p] ?? 0), 0);
    providerCostUsd = { total: gem + com, gemini: gem, commerce: com, perCase: (gem + com) / scored.length, basis: cost.estimatedCases > 0 ? 'includes_estimates' : 'measured' };
  }

  return {
    casesScored: scored.length,
    unknownCaseIds,
    exactMatchPrecision: ratio(exactClaimsCorrect, exactClaims, 'no exact-match claims were made'),
    falseExactMatchRate: ratio(casesWithWrongExact, scored.length),
    casesWithExactClaim,
    probablePrecision: ratio(probableCorrect, probableClaims, 'no probable claims were made'),
    exactProductRecall: { top1: ratio(knowableTop1, knowable), top3: ratio(knowableTop3, knowable), top10: ratio(knowableTop10, knowable) },
    alternativeRelevance: {
      meanGradeTop3: altGrades.length ? altGrades.reduce((a, b) => a + b, 0) / altGrades.length : null,
      hitAt3: ratio(altHit3, altCases),
      gradeCounts: [0, 1, 2, 3].map((g) => altGrades.filter((x) => x === g).length),
      judge: 'title-only (see lib/judge.mjs)',
    },
    merchantLinkValidity: { direct: ratio(dest.direct, offers), searchHandoff: ratio(dest.search_handoff, offers), invalid: ratio(dest.invalid, offers), offers },
    actionableLatencyMs: { n: actionable.length, p50: percentile(actionable, 50), p95: percentile(actionable, 95), noActionableResult: ratio(noActionable, commerceAttempted) },
    identification: {
      categoryAccuracy: ratio(idCategoryCorrect, idEligible),
      nonFashionRejection: ratio(nonFashionRejected, nonFashionCases),
      unsupportedBrandClaimRate: ratio(unsupportedBrandClaims, brandClaims, 'no brand claims were made'),
    },
    providerCost: { ...cost, usd: providerCostUsd },
    strata,
  };
}
