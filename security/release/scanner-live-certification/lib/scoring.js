'use strict';

/**
 * Scoring against the predeclared ground truth (corpus.json). Pure functions, no
 * I/O, so every rule is unit-testable offline.
 *
 * Identification is scored from what the app DISPLAYS (the mapped analysis) as well
 * as from what the server returned, because a correct server answer shown against
 * the wrong garment is still a customer-visible failure.
 */

const FAMILIES = [
  ['dress', ['dress', 'gown', 'jumpsuit', 'romper']],
  ['footwear', ['shoe', 'sneaker', 'trainer', 'boot', 'heel', 'sandal', 'loafer', 'footwear', 'pump']],
  ['bag', ['bag', 'handbag', 'satchel', 'purse', 'backpack', 'tote', 'crossbody', 'clutch']],
  ['eyewear', ['sunglass', 'glasses', 'eyewear', 'aviator']],
  ['bottoms', ['jeans', 'pants', 'trouser', 'skirt', 'shorts', 'leggings', 'bottoms']],
  ['outerwear', ['jacket', 'coat', 'blazer', 'parka', 'bomber', 'outerwear', 'cardigan', 'vest']],
  ['tops', ['hoodie', 'sweatshirt', 'sweater', 'knitwear', 'shirt', 'tee', 'top', 'blouse', 'tank', 'pullover']],
  ['accessory', ['hat', 'scarf', 'belt', 'jewelry', 'watch', 'accessory', 'accessories']],
];

const norm = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function hasAny(text, tokens) {
  const haystack = norm(text);
  return (tokens ?? []).some((token) => token && haystack.includes(norm(token)));
}

function familyOf(text) {
  const haystack = norm(text);
  for (const [family, tokens] of FAMILIES) {
    if (tokens.some((token) => haystack.includes(token))) return family;
  }
  return null;
}

function truthFamily(garment) {
  return familyOf((garment.categoryAny ?? []).join(' '))
    ?? familyOf((garment.subtypeAny ?? []).join(' '));
}

const UNKNOWN_BRAND = /^(unknown|none|n\/a|null|undefined|unbranded|no brand|not visible|-)$/i;

function brandClaims(...values) {
  return values
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v && !UNKNOWN_BRAND.test(v));
}

/** Text a user would read for one candidate: label, category, subtype. */
function candidateText(candidate) {
  return `${candidate?.label ?? ''} ${candidate?.category ?? ''} ${candidate?.subtype ?? ''}`;
}

function fit(candidate, garment) {
  const categoryOk = hasAny(`${candidate?.category ?? ''} ${candidate?.label ?? ''}`, garment.categoryAny);
  const subtypeOk = hasAny(`${candidate?.subtype ?? ''} ${candidate?.label ?? ''}`, garment.subtypeAny);
  return { categoryOk, subtypeOk, score: (categoryOk ? 2 : 0) + (subtypeOk ? 2 : 0) };
}

/** Greedy best-fit assignment of returned candidates to ground-truth garments. */
function assignCandidates(candidates, garments) {
  const pairs = [];
  candidates.forEach((candidate, ci) => {
    garments.forEach((garment, gi) => {
      const f = fit(candidate, garment);
      if (f.score > 0) pairs.push({ ci, gi, ...f });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.ci - b.ci);
  const takenC = new Set();
  const takenG = new Set();
  const assignments = [];
  for (const pair of pairs) {
    if (takenC.has(pair.ci) || takenG.has(pair.gi)) continue;
    takenC.add(pair.ci);
    takenG.add(pair.gi);
    assignments.push(pair);
  }
  return {
    assignments,
    unmatchedCandidates: candidates.map((_, ci) => ci).filter((ci) => !takenC.has(ci)),
    missedGarments: garments.map((_, gi) => gi).filter((gi) => !takenG.has(gi)),
  };
}

/**
 * Score DETECTION for one photo.
 * @param image corpus image
 * @param detected [{candidateId,label,category,subtype}] returned for that photo
 */
function scoreDetection(image, detected) {
  const garments = image.expectedGarments ?? [];
  const candidates = detected ?? [];
  const { assignments, unmatchedCandidates, missedGarments } = assignCandidates(candidates, garments);
  const required = garments.map((g, gi) => ({ g, gi })).filter(({ g }) => g.required);
  const requiredHit = required.filter(({ gi }) => assignments.some((a) => a.gi === gi)).length;

  const distractors = image.distractors ?? [];
  const distractorHits = unmatchedCandidates.filter((ci) => distractors.some(
    (d) => hasAny(candidateText(candidates[ci]), d.forbiddenTokens),
  ));
  const extra = unmatchedCandidates.filter((ci) => !distractorHits.includes(ci));

  return {
    imageId: image.id,
    nonFashion: image.nonFashion === true,
    candidatesReturned: candidates.length,
    required: required.length,
    requiredDetected: requiredHit,
    missedRequired: required.filter(({ gi }) => missedGarments.includes(gi)).map(({ g }) => g.key),
    extraFalseCandidates: image.nonFashion ? candidates.length : extra.length,
    distractorAsGarment: distractorHits.length,
    nonFashionFalseCandidates: image.nonFashion ? candidates.length : 0,
    assignments: assignments.map((a) => ({
      candidateId: candidates[a.ci]?.candidateId ?? null,
      garment: garments[a.gi].key,
      categoryOk: a.categoryOk,
      subtypeOk: a.subtypeOk,
    })),
  };
}

/**
 * Score one IDENTIFIED item (a selected-item answer) against the truth garment it
 * is bound to. `bound` is the garment assigned to this item's candidate at detection;
 * when unbound the best fit over the identification text is used.
 */
function scoreIdentification(image, garment, item) {
  const ident = item?.identification ?? {};
  const attrs = item?.attributes ?? {};
  const shown = item?.displayed ?? {};
  const text = [ident.item_type, ident.subtype, attrs.itemType, attrs.category, shown.title, shown.result].filter(Boolean).join(' ');
  const categoryText = [ident.item_type, attrs.category, attrs.itemType, shown.title].filter(Boolean).join(' ');
  const subtypeText = [ident.subtype, ident.item_type, attrs.itemType, shown.title, shown.result].filter(Boolean).join(' ');
  const colorText = [ident.primary_color, ...(ident.secondary_colors ?? []), ...(attrs.colorPalette ?? []), shown.color]
    .filter(Boolean).join(' ');
  const materialText = [ident.material_estimate, attrs.materialEstimate, shown.material].filter(Boolean).join(' ');

  const categoryCorrect = hasAny(categoryText, garment.categoryAny) || hasAny(text, garment.categoryAny);
  const subtypeAcceptable = hasAny(subtypeText, garment.subtypeAny);
  const colorAcceptable = hasAny(colorText, garment.colorAny);
  const materialPlausible = garment.materialAny?.length ? hasAny(materialText, garment.materialAny) : null;

  const expectedFamily = truthFamily(garment);
  const returnedFamily = familyOf(categoryText) ?? familyOf(text);
  const critical = !categoryCorrect && !subtypeAcceptable
    && returnedFamily !== null && expectedFamily !== null && returnedFamily !== expectedFamily;

  const claims = brandClaims(ident.brand_guess, ident.visible_brand_text, shown.brand);
  const ungroundedBrandClaims = claims.filter(
    (claim) => !(garment.brandGrounded ?? []).some((b) => norm(claim).includes(norm(b))),
  );

  const confidence = typeof ident.confidence_score === 'number'
    ? ident.confidence_score
    : (typeof attrs.confidenceScore === 'number' ? attrs.confidenceScore : null);
  const overconfidentWrong = critical && confidence !== null && confidence >= 0.85;

  return {
    imageId: image.id,
    garment: garment.key,
    categoryCorrect,
    subtypeAcceptable,
    colorAcceptable,
    materialPlausible,
    expectedFamily,
    returnedFamily,
    critical,
    ungroundedBrandClaims,
    confidence,
    overconfidentWrong,
  };
}

/**
 * Candidate/identity drift: the detection candidate and the identification that
 * came back for it must describe the same kind of garment. This is the class of
 * defect where garment N inherits garment 1's label.
 */
function candidateIdentityDrift(candidate, item) {
  const detectedFamily = familyOf(candidateText(candidate));
  const ident = item?.identification ?? {};
  const attrs = item?.attributes ?? {};
  const returnedFamily = familyOf([ident.item_type, ident.subtype, attrs.category, attrs.itemType, item?.displayed?.title].filter(Boolean).join(' '));
  if (!detectedFamily || !returnedFamily) return { drift: false, detectedFamily, returnedFamily };
  return { drift: detectedFamily !== returnedFamily, detectedFamily, returnedFamily };
}

/** Automatic keyword PRE-CHECK for an offer. It flags; it never assigns a rubric score. */
function offerPrecheck(garment, offer) {
  const title = offer?.title ?? '';
  const matches = hasAny(title, garment.offerTitleAny);
  const rejected = hasAny(title, garment.offerTitleReject) && !matches;
  return { titleMatchesCategory: matches, titleIncompatible: rejected };
}

function destinationValid(offer) {
  const d = offer?.destination;
  return Boolean(d && d.https && d.host && d.host.includes('.'));
}

function priceSane(offer) {
  if (offer?.price === null || offer?.price === undefined || offer.price === '') return true;
  const value = typeof offer.price === 'number' ? offer.price : Number(String(offer.price).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(value) || value <= 0 || value > 100000) return false;
  return Boolean(offer.currency) || typeof offer.price === 'string';
}

/**
 * Aggregate graded commerce results.
 * @param graded [{ garmentKey, scores: number[] }]  rubric scores 0..3 in returned order
 */
function commerceMetrics(graded) {
  const rows = graded.filter((g) => Array.isArray(g.scores) && g.scores.length > 0);
  const top = (scores, n) => scores.slice(0, n);
  const precision = (scores, n) => {
    const slice = top(scores, n);
    return slice.length ? slice.filter((s) => s >= 2).length / slice.length : null;
  };
  const withThree = rows.filter((r) => r.scores.length >= 3);
  const withFive = rows.filter((r) => r.scores.length >= 5);
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  return {
    garmentsGraded: rows.length,
    hitAt3: rows.length ? rows.filter((r) => top(r.scores, 3).some((s) => s >= 2)).length / rows.length : null,
    meanTop3Precision: mean(withThree.map((r) => precision(r.scores, 3))),
    meanTop5Precision: mean(withFive.map((r) => precision(r.scores, 5))),
    top1Unrelated: rows.filter((r) => r.scores[0] === 0).map((r) => r.garmentKey),
    top1UnrelatedShare: rows.length ? rows.filter((r) => r.scores[0] === 0).length / rows.length : null,
  };
}

module.exports = {
  FAMILIES,
  assignCandidates,
  brandClaims,
  candidateIdentityDrift,
  commerceMetrics,
  destinationValid,
  familyOf,
  hasAny,
  norm,
  offerPrecheck,
  priceSane,
  scoreDetection,
  scoreIdentification,
};
