#!/usr/bin/env node
'use strict';

/**
 * Tier A stratum coverage and pilot-freeze eligibility.
 *
 * Reads the curation decisions and reports which strata are satisfied. The two
 * AUTHORISED targets for this acquisition round are the only hard gates:
 *
 *   brand-evidenced cases        >= 10
 *   true same-item image sets    >= 10
 *
 * Everything else is reported as a gap, NOT treated as a blocker, because the
 * owner explicitly scoped this round to the two strata above and forbade adding
 * generic images to inflate the total.
 *
 * A set counts only when it has >= 2 members whose shared object identity was
 * CONFIRMED visually. Crops, masks, recompressions and alternate framings of one
 * source image never count.
 *
 * A brand-evidenced case counts only with direct evidence: a legible logo,
 * label or tag, or documented museum/catalog attribution naming a maker.
 * Design resemblance never counts.
 */

const fs = require('fs');
const path = require('path');

const CURATION = path.join(
  __dirname, '..', '..', 'evals', 'scanner-accuracy', 'curation', 'tier-a-curation.v0.1.0.json'
);

const TARGETS = Object.freeze({ brandEvidenced: 10, sameItemSets: 10 });

/** Evidence kinds that satisfy the brand requirement. */
const VALID_BRAND_EVIDENCE = new Set([
  'legible_logo_on_product',
  'legible_label_or_tag',
  'packaging_text',
  'documented_museum_attribution',
]);

function load() {
  return JSON.parse(fs.readFileSync(CURATION, 'utf8'));
}

function report() {
  const c = load();
  const decisions = Object.entries(c.decisions || {});
  const kept = decisions.filter(([, d]) => d.keep);

  // ── Brand-evidenced ──
  const brandCases = kept.filter(([, d]) => d.brandVisible === true && VALID_BRAND_EVIDENCE.has(d.brandEvidenceKind));
  const brandClaimedButUnevidenced = kept.filter(
    ([, d]) => d.brandVisible === true && !VALID_BRAND_EVIDENCE.has(d.brandEvidenceKind)
  );

  // ── Same-item sets ──
  const sets = Object.entries(c.sameItemSets || {});
  const validSets = sets.filter(([, s]) => {
    const members = s.members || [];
    return s.trueMultiImage === true && s.identityConfirmed !== false && members.length >= 2;
  });
  const invalidSets = sets.filter(([id]) => !validSets.find(([vid]) => vid === id));

  // ── Other strata, reported not gated ──
  const tally = {};
  for (const [, d] of kept) {
    for (const t of [...(d.sceneTags || []), ...(d.difficultyTags || [])]) tally[t] = (tally[t] || 0) + 1;
  }

  const licence = {};
  for (const [, d] of kept) {
    const l = d.licenceId ? `${d.licenceId}${d.licenceVersion ? ` ${d.licenceVersion}` : ''}` : 'recorded_in_acquisition_report';
    licence[l] = (licence[l] || 0) + 1;
  }

  const brandOk = brandCases.length >= TARGETS.brandEvidenced;
  const setsOk = validSets.length >= TARGETS.sameItemSets;

  return {
    benchmarkKind: 'licensed_web_image_pilot_benchmark',
    notARealWorldSmartGlassesBenchmark: true,
    curated: decisions.length,
    kept: kept.length,
    rejected: decisions.length - kept.length,
    authorisedTargets: {
      brandEvidenced: { have: brandCases.length, need: TARGETS.brandEvidenced, met: brandOk },
      sameItemSets: { have: validSets.length, need: TARGETS.sameItemSets, met: setsOk },
    },
    brandEvidencedCases: brandCases.map(([id, d]) => ({
      caseId: id, brand: d.brand, evidence: d.brandEvidenceKind, evidenceSource: d.brandEvidenceSource || null,
    })),
    brandClaimedButUnevidenced: brandClaimedButUnevidenced.map(([id]) => id),
    validSets: validSets.map(([id, s]) => ({ setId: id, members: s.members.length, identityEvidence: s.identityEvidence || null })),
    invalidSets: invalidSets.map(([id, s]) => ({ setId: id, reason: s.setNote || 'fewer than 2 confirmed members' })),
    otherStrata: tally,
    licenceBreakdown: licence,
    pilotFreezeEligible: brandOk && setsOk,
    freezeVerdict:
      brandOk && setsOk
        ? 'BOTH AUTHORISED TARGETS MET — eligible for pilot freeze'
        : `NOT eligible: ${[
            brandOk ? null : `brand-evidenced ${brandCases.length}/${TARGETS.brandEvidenced}`,
            setsOk ? null : `same-item sets ${validSets.length}/${TARGETS.sameItemSets}`,
          ].filter(Boolean).join('; ')}`,
  };
}

if (require.main === module) {
  const r = report();
  console.log(JSON.stringify(r, null, 2));
  if (!r.pilotFreezeEligible) process.exitCode = 1;
}

module.exports = { report, TARGETS, VALID_BRAND_EVIDENCE };
