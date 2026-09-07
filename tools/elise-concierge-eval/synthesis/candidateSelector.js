'use strict';

/**
 * Harness-owned deterministic candidate selection for the RESPONSE
 * SYNTHESIZER only. This is NOT a reimplementation of production ranking
 * (eliseCompatibilityScoring.ts) and is never used as an evaluation oracle —
 * its only job is to give the synthesizer a plausible, constraint-respecting
 * shortlist to write grounded (or, once a defect script runs, deliberately
 * ungrounded) prose about. Simpler and more transparent than production
 * ranking on purpose: an evaluation instrument's fixtures must be easy for a
 * human reviewer to audit.
 */

const HEEL_SUBCATEGORIES = new Set(['heel', 'pump']);

function violatesNoHeels(item) {
  return HEEL_SUBCATEGORIES.has(item.subcategory);
}

function violatesNoBlack(item) {
  return (item.colors || []).some((c) => c.toLowerCase() === 'black');
}

function violatesBusinessCasual(item) {
  return item.formality === 'casual';
}

/**
 * Parse the scenario's closed-vocabulary hard/soft constraint strings into a
 * structured object the synthesizer and constraint evaluator both understand.
 */
function parseConstraints(constraintStrings) {
  const parsed = {
    closetOnly: false,
    noHeels: false,
    noBlack: false,
    underPrice: null,
    businessCasual: false,
    warmWeather: false,
    noPurchases: false,
    anchorItemId: null,
    exactlyNOptions: null,
  };
  for (const raw of constraintStrings || []) {
    if (raw === 'closet_only') parsed.closetOnly = true;
    else if (raw === 'no_heels') parsed.noHeels = true;
    else if (raw === 'no_black') parsed.noBlack = true;
    else if (raw === 'under_150') parsed.underPrice = 150;
    else if (raw === 'business_casual') parsed.businessCasual = true;
    else if (raw === 'warm_weather') parsed.warmWeather = true;
    else if (raw === 'no_purchases') parsed.noPurchases = true;
    else if (raw.startsWith('anchor_item:')) parsed.anchorItemId = raw.slice('anchor_item:'.length);
    else if (raw.startsWith('exactly_n_options:')) {
      parsed.exactlyNOptions = Number(raw.slice('exactly_n_options:'.length));
    }
  }
  return parsed;
}

/**
 * @param {object} closet - fixture closet
 * @param {object} constraints - parsed constraints (see parseConstraints)
 * @returns {{ anchor: object|null, shortlist: object[], excludedByConstraint: object[] }}
 */
function selectCandidates(closet, constraints) {
  const items = closet.items.slice().sort((a, b) => a.id.localeCompare(b.id));
  const anchor = constraints.anchorItemId
    ? items.find((i) => i.id === constraints.anchorItemId) || null
    : null;

  const excludedByConstraint = [];
  const filtered = items.filter((item) => {
    if (anchor && item.id === anchor.id) return false; // never recommend the anchor alongside itself
    if (constraints.noHeels && violatesNoHeels(item)) {
      excludedByConstraint.push(item);
      return false;
    }
    if (constraints.noBlack && violatesNoBlack(item)) {
      excludedByConstraint.push(item);
      return false;
    }
    if (constraints.businessCasual && violatesBusinessCasual(item)) {
      excludedByConstraint.push(item);
      return false;
    }
    return true;
  });

  const shortlist = filtered.slice(0, constraints.exactlyNOptions || 3);
  return { anchor, shortlist, excludedByConstraint };
}

/** True when the closet has zero items in the given layeringRole. */
function roleAbsent(closet, role) {
  return !closet.items.some((item) => item.layeringRole === role);
}

module.exports = {
  parseConstraints,
  selectCandidates,
  roleAbsent,
  violatesNoHeels,
  violatesNoBlack,
  violatesBusinessCasual,
};
