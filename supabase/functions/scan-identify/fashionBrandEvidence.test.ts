/**
 * Phase 7.2 fashion + brand visual evidence — local architecture proof.
 *
 * No provider calls, no network, no staging, no production, no holdout data.
 *
 * WHAT THESE TESTS DO AND DO NOT PROVE — stated plainly, because the difference
 * matters for how the results are read:
 *
 *   PROVEN HERE: the plumbing. That the discriminator packs name the evidence
 *   that actually separates similar members of a family; that the prompt carries
 *   the cues; that a fixture representing "wide-leg evidence" survives
 *   normalization coherently; that brand gating suppresses every disqualified
 *   evidence class; that no additional provider call, HTTP request or budget
 *   increase was introduced.
 *
 *   NOT PROVEN HERE: that the model actually discriminates better. Whether
 *   pointing the vision model at leg geometry makes it pick wide_leg over
 *   straight_leg is a question about the model, and only the staging accuracy
 *   run can answer it. A fixture asserting "wide-leg evidence produces
 *   wide_leg_jeans" is testing the fixture, not the scanner, and is labelled as
 *   a plumbing test throughout.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildDiscriminatorFocus,
  DISCRIMINATOR_FAMILIES,
  getDiscriminatorPack,
  resolveDiscriminatorFamily,
} from './fashionDiscriminatorPacks.ts';
import {
  applyBrandEvidenceGate,
  BRAND_EVIDENCE_LEVELS,
  BRAND_EVIDENCE_TYPES,
  brandProvenanceFromEvidence,
  decideBrandEvidence,
  isNonBrandText,
  isPartialBrandText,
} from './brandEvidence.ts';
import {
  buildRecheckPrompt,
  parseRecheckPayload,
  recheckBrandArtifact,
  shouldAdoptRecheckBrand,
} from './identificationRecheck.ts';
import { normalizeToV2, projectV2ToLegacy } from '../_shared/fashionIdentificationV2.ts';
import { evaluateIdentificationGate } from './identificationRecheckGate.ts';

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const INDEX_SOURCE = Deno.readTextFileSync(`${ROOT}/supabase/functions/scan-identify/index.ts`);

/** Extracts a template-literal constant from index.ts for prompt assertions. */
function promptConst(name: string): string {
  const marker = `const ${name} = \``;
  const start = INDEX_SOURCE.indexOf(marker);
  if (start === -1) throw new Error(`prompt ${name} not found`);
  const bodyStart = start + marker.length;
  let i = bodyStart;
  while (i < INDEX_SOURCE.length) {
    if (INDEX_SOURCE[i] === '\\') {
      i += 2;
      continue;
    }
    if (INDEX_SOURCE[i] === '`') break;
    i += 1;
  }
  return INDEX_SOURCE.slice(bodyStart, i);
}

const IDENTIFY_PROMPT = promptConst('IDENTIFY_PROMPT');

/**
 * Source with ALL comments removed.
 *
 * These "must not reference X" assertions are about executable code. Prose
 * explaining WHY a brand must not come from Product Match is exactly the
 * documentation that should exist, so matching on it would punish the comment
 * rather than the coupling. Stripping comments first keeps the assertion aimed
 * at what it is actually about.
 */
function executableSource(relativePath: string): string {
  const raw = Deno.readTextFileSync(`${ROOT}/${relativePath}`);
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '') // block and doc comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, sparing "://"
}

/** Normalizes a provider-shaped identification fixture the way the scan does. */
function normalizeFixture(identification: Record<string, unknown>) {
  return normalizeToV2({
    requestId: 'req-test',
    outcome: 'classified',
    evidenceIds: ['evidence-0001'],
    identification,
    attributes: {},
  });
}

// ══════════════════════════════════════════════════════════════════════════
// FASHION IDENTIFICATION  (§18 A–E)
// ══════════════════════════════════════════════════════════════════════════

Deno.test('A: the pants pack names the geometry separating wide-leg from straight', () => {
  const pack = getDiscriminatorPack('pants');
  assert(pack);
  for (const cue of ['leg width', 'taper', 'flare', 'rise', 'hem']) {
    assert(pack.includes(cue), `pants pack must direct attention to ${cue}`);
  }
});

Deno.test('A: wide-leg evidence normalizes to a coherent three-tier identity (plumbing)', () => {
  const v2 = normalizeFixture({
    item_type: 'pants',
    clothing_type: 'jeans',
    subtype: 'wide_leg_jeans',
    silhouette: 'wide',
    material_estimate: 'denim',
    confidence_score: 0.88,
  });
  assertEquals(v2.item.category, 'pants');
  assertEquals(v2.item.clothingType, 'jeans');
  assertEquals(v2.item.subtype, 'wide_leg_jeans');
  // Coherent, so no recheck is spent on it.
  const gate = evaluateIdentificationGate({
    identity: {
      category: v2.item.category,
      clothingType: v2.item.clothingType,
      subtype: v2.item.subtype,
    },
    globalConfidence: 0.88,
    consistencyConflictCodes: [],
    qualityBand: 'high',
    visualObservations: ['Wide straight leg, high rise, denim.'],
    identityBearing: true,
  });
  assertEquals(gate.decision, 'CLEAR');
});

Deno.test('B: bomber vs blazer resolve to DIFFERENT families with different packs', () => {
  // This is the whole point of family resolution: the two are visually similar
  // but their discriminating evidence is not the same, so a recheck must not be
  // handed the wrong one.
  const bomber = resolveDiscriminatorFamily({
    category: 'outerwear',
    clothingType: 'bomber jacket',
    subtype: null,
  });
  const blazer = resolveDiscriminatorFamily({
    category: 'blazer',
    clothingType: 'blazer',
    subtype: 'double-breasted blazer',
  });
  assertEquals(bomber, 'outerwear');
  assertEquals(blazer, 'blazer');

  const bomberPack = getDiscriminatorPack(bomber)!;
  const blazerPack = getDiscriminatorPack(blazer)!;
  assert(bomberPack !== blazerPack, 'the two families must not share one pack');
  // The blazer pack asks the tailoring questions a bomber has no answer to.
  for (const cue of ['lapel', 'breasted', 'vent']) {
    assert(blazerPack.includes(cue), `blazer pack must ask about ${cue}`);
  }
  // The outerwear pack asks about closure and insulation instead.
  for (const cue of ['closure', 'quilting', 'hood']) {
    assert(bomberPack.includes(cue), `outerwear pack must ask about ${cue}`);
  }
});

Deno.test('C: the outerwear pack carries the puffer-vs-plain-jacket cues', () => {
  const pack = getDiscriminatorPack('outerwear')!;
  for (const cue of ['insulation', 'quilting', 'body length']) {
    assert(pack.includes(cue), `outerwear pack must direct attention to ${cue}`);
  }
});

Deno.test('D: the footwear pack carries the sneaker-vs-loafer construction cues', () => {
  const pack = getDiscriminatorPack('footwear')!;
  for (const cue of ['toe shape', 'sole', 'lacing', 'upper construction']) {
    assert(pack.includes(cue), `footwear pack must direct attention to ${cue}`);
  }
  assert(
    pack.includes('sneaker') && pack.includes('loafer'),
    'the pack should name the silhouettes it is separating',
  );
});

Deno.test('E: unsupported subtype stays unknown — no tier is manufactured', () => {
  const v2 = normalizeFixture({
    item_type: 'outerwear',
    clothing_type: 'jacket',
    // The image supported the family but not the variant.
    subtype: '',
    confidence_score: 0.72,
  });
  assertEquals(v2.item.category, 'outerwear');
  assertEquals(v2.item.clothingType, 'jacket');
  assertEquals(v2.item.subtype, null);
  // And nothing copied a neighbouring tier in to fill it.
  assert(v2.item.subtype !== v2.item.clothingType);
  assert(v2.item.subtype !== v2.item.category);
});

Deno.test('every level-1 family the taxonomy can return has a pack', () => {
  // A family without a pack is a family whose recheck silently gets no focus.
  for (const family of DISCRIMINATOR_FAMILIES) {
    const pack = getDiscriminatorPack(family);
    assert(pack && pack.length > 20, `family ${family} must have a usable pack`);
  }
});

Deno.test('an unmappable identity yields NO pack rather than a wrong one', () => {
  assertEquals(
    resolveDiscriminatorFamily({ category: 'sculpture', clothingType: null, subtype: null }),
    null,
  );
  assertEquals(
    buildDiscriminatorFocus({ category: null, clothingType: null, subtype: null }),
    null,
  );
});

Deno.test('family resolution reads broad→narrow and tolerates a null category', () => {
  const focus = buildDiscriminatorFocus({
    category: null,
    clothingType: 'chelsea boot',
    subtype: null,
  });
  assertEquals(focus?.family, 'footwear');
});

// ══════════════════════════════════════════════════════════════════════════
// BRAND IDENTIFICATION  (§19 F–N)
// ══════════════════════════════════════════════════════════════════════════

Deno.test('F: a clear wordmark establishes the brand', () => {
  const decision = decideBrandEvidence({
    brandGuess: "Levi's",
    visibleBrandText: "LEVI'S",
    logoDetected: false,
    reportedLevel: 'direct',
    reportedType: 'wordmark',
    evidenceOnItem: true,
  });
  assertEquals(decision.level, 'direct');
  assertEquals(decision.type, 'wordmark');
  assertEquals(decision.brandEstablished, true);
  assertEquals(brandProvenanceFromEvidence(decision), 'visible_text');
});

Deno.test('G: a recognizable logo on the item may establish the brand', () => {
  const decision = decideBrandEvidence({
    brandGuess: 'Nike',
    visibleBrandText: null,
    logoDetected: true,
    reportedLevel: 'direct',
    reportedType: 'logo',
    evidenceOnItem: true,
  });
  assertEquals(decision.level, 'direct');
  assertEquals(decision.brandEstablished, true);
  assertEquals(brandProvenanceFromEvidence(decision), 'logo_shape');
});

Deno.test('H: style resemblance alone NEVER establishes a brand', () => {
  const decision = decideBrandEvidence({
    brandGuess: 'Chanel',
    visibleBrandText: null,
    logoDetected: false,
    // Even when the model insists.
    reportedLevel: 'direct',
    reportedType: 'wordmark',
    evidenceOnItem: true,
  });
  assertEquals(decision.level, 'style_only');
  assertEquals(decision.brandEstablished, false);
  assert(decision.reasons.includes('style_resemblance_only'));
  assertEquals(brandProvenanceFromEvidence(decision), 'unknown');
});

Deno.test('H: the gate strips a style-only brand from the identification', () => {
  const { identification, brandSuppressed } = applyBrandEvidenceGate({
    item_type: 'blazer',
    brand_guess: 'Chanel',
    visible_brand_text: null,
    logo_detected: false,
    brand_evidence_level: 'style_only',
    brand_evidence_type: 'none',
    brand_evidence_on_item: true,
  });
  assertEquals(brandSuppressed, true);
  assertEquals(identification.brand_guess, null);
  assertEquals(identification.brand_evidence_level, 'style_only');
  // The garment itself is untouched: brand gating never edits taxonomy (§13).
  assertEquals(identification.item_type, 'blazer');
});

Deno.test('I: partial or obscured text never becomes a brand', () => {
  assertEquals(isPartialBrandText('NI...'), true);
  assertEquals(isPartialBrandText('AD—'), true);
  assertEquals(isPartialBrandText('GU'), true);
  assertEquals(isPartialBrandText('…KE'), true);
  assertEquals(isPartialBrandText("LEVI'S"), false);

  const decision = decideBrandEvidence({
    brandGuess: 'Nike',
    visibleBrandText: 'NI...',
    logoDetected: false,
    reportedLevel: 'direct',
    reportedType: 'wordmark',
    evidenceOnItem: true,
  });
  assert(decision.reasons.includes('text_partial_or_illegible'));
  assertEquals(decision.brandEstablished, false);
});

Deno.test('J: care, size and composition text never becomes a brand', () => {
  for (
    const text of [
      '100% COTTON',
      'Machine wash cold',
      'DO NOT BLEACH',
      'Made in Portugal',
      '80% WOOL 20% NYLON',
      'XL',
      'Size M',
    ]
  ) {
    assertEquals(isNonBrandText(text), true, `must be recognised as non-brand: ${text}`);
  }
  assertEquals(isNonBrandText("LEVI'S"), false);

  const decision = decideBrandEvidence({
    brandGuess: 'Cotton',
    visibleBrandText: '100% COTTON',
    logoDetected: false,
    reportedLevel: 'direct',
    reportedType: 'label',
    evidenceOnItem: true,
  });
  assert(decision.reasons.includes('text_is_care_or_size'));
  assertEquals(decision.brandEstablished, false);
});

Deno.test('J: disqualified text is CLEARED, not left for a downstream consumer', () => {
  // scanCommerceRouter reads visible_brand_text directly, so leaving "100%
  // COTTON" behind would simply move the false brand one stage downstream.
  const { identification } = applyBrandEvidenceGate({
    brand_guess: 'Cotton',
    visible_brand_text: '100% COTTON',
    logo_detected: false,
  });
  assertEquals(identification.brand_guess, null);
  assertEquals(identification.visible_brand_text, null);
});

Deno.test('K: a brand mark NOT on the item is ignored entirely', () => {
  // Background signage, a poster, a screen, a watermark, a shopping bag.
  const decision = decideBrandEvidence({
    brandGuess: 'Nike',
    visibleBrandText: 'NIKE',
    logoDetected: true,
    reportedLevel: 'direct',
    reportedType: 'wordmark',
    evidenceOnItem: false,
  });
  assert(decision.reasons.includes('evidence_not_on_item'));
  assertEquals(decision.brandEstablished, false);

  const { identification } = applyBrandEvidenceGate({
    brand_guess: 'Nike',
    visible_brand_text: 'NIKE',
    logo_detected: true,
    brand_evidence_on_item: false,
  });
  assertEquals(identification.brand_guess, null);
  assertEquals(identification.visible_brand_text, null);
  assertEquals(identification.logo_detected, false);
});

Deno.test('K: an UNSTATED attribution is not treated as confirmation', () => {
  // The dangerous default. If the model does not say the mark was on the item,
  // assuming it was is exactly how background logos get through.
  const decision = decideBrandEvidence({
    brandGuess: 'Gucci',
    visibleBrandText: null,
    logoDetected: false,
    reportedLevel: 'distinctive',
    reportedType: 'hardware',
    evidenceOnItem: null,
  });
  // Tier B is still reachable without an explicit attestation, but Tier C
  // material cannot sneak up to it.
  assertEquals(decision.level, 'distinctive');
  const styleOnly = decideBrandEvidence({
    brandGuess: 'Gucci',
    visibleBrandText: null,
    logoDetected: false,
    reportedLevel: 'style_only',
    reportedType: 'none',
    evidenceOnItem: null,
  });
  assertEquals(styleOnly.brandEstablished, false);
});

Deno.test('L: a logo on a second garment cannot reach the resolved item', () => {
  // The multi-item case: the model must attribute the mark, and when it says
  // the mark is not on the selected garment the brand is dropped.
  const { identification, brandSuppressed } = applyBrandEvidenceGate({
    item_type: 'pants',
    clothing_type: 'jeans',
    brand_guess: 'Nike',
    visible_brand_text: 'NIKE',
    logo_detected: true,
    // The logo was on the shoes, not the selected jeans.
    brand_evidence_on_item: false,
  });
  assertEquals(brandSuppressed, true);
  assertEquals(identification.brand_guess, null);
  // The garment identity is completely unaffected by the brand decision.
  assertEquals(identification.item_type, 'pants');
  assertEquals(identification.clothing_type, 'jeans');
});

Deno.test('M: Product Match cannot supply or alter a brand', () => {
  // Structural: the gate is a pure function of the identification. It has no
  // commerce parameter, so there is no channel through which retailer results
  // could reach it.
  const source = executableSource('supabase/functions/scan-identify/brandEvidence.ts');
  for (const forbidden of ['product', 'commerce', 'retailer', 'catalog', 'shopping', 'merchant']) {
    const re = new RegExp(`\\b${forbidden}`, 'i');
    const offending = source.split('\n').filter((l) => re.test(l));
    assertEquals(offending, [], `brand gate must not reference ${forbidden} in executable code`);
  }

  // And ordering: the brand gate runs before any commerce decision exists.
  const gateIndex = INDEX_SOURCE.indexOf('const brandGate = applyBrandEvidenceGate(identification);');
  const commerceDecision = INDEX_SOURCE.indexOf('const commerceDecision = resolveCommerceDecision({');
  const commerceCall = INDEX_SOURCE.indexOf('getScanCommerceResults({');
  assert(gateIndex > 0, 'the brand gate must be wired in');
  assert(gateIndex < commerceDecision, 'brand must be decided before commerce is decided');
  assert(gateIndex < commerceCall, 'brand must be decided before any commerce call');
});

Deno.test('N: distinctive-but-insufficient evidence records the tier without a brand', () => {
  // Tier B requires BOTH a distinctive evidence type AND a distinctive rating.
  // Either alone is reachable from styling, so neither alone is enough.
  const typeOnly = decideBrandEvidence({
    brandGuess: 'Bottega Veneta',
    visibleBrandText: null,
    logoDetected: false,
    reportedLevel: 'style_only',
    reportedType: 'distinctive_construction',
    evidenceOnItem: true,
  });
  assertEquals(typeOnly.level, 'style_only');
  assertEquals(typeOnly.brandEstablished, false);

  const both = decideBrandEvidence({
    brandGuess: 'Bottega Veneta',
    visibleBrandText: null,
    logoDetected: false,
    reportedLevel: 'distinctive',
    reportedType: 'distinctive_construction',
    evidenceOnItem: true,
  });
  assertEquals(both.level, 'distinctive');
  assertEquals(both.brandEstablished, true);
  // Tier B is provenance `visual` — it is not a read mark.
  assertEquals(brandProvenanceFromEvidence(both), 'visual');
});

Deno.test('no brand proposed at all is a clean unknown, not a suppression', () => {
  const decision = decideBrandEvidence({
    brandGuess: null,
    visibleBrandText: null,
    logoDetected: false,
    reportedLevel: null,
    reportedType: null,
    evidenceOnItem: null,
  });
  assertEquals(decision.level, 'none');
  assertEquals(decision.type, 'none');
  assertEquals(decision.brandEstablished, false);
  assert(decision.reasons.includes('no_brand_evidence'));
  assert(!decision.reasons.includes('brand_suppressed'));
});

Deno.test('a style_only tier blocks the brand from reaching V2', () => {
  const v2 = normalizeFixture({
    item_type: 'outerwear',
    clothing_type: 'jacket',
    subtype: 'quilted jacket',
    // A brand that the gate refused must not reappear through visible text.
    brand_guess: null,
    visible_brand_text: 'Some Brand',
    brand_evidence_level: 'style_only',
    brand_evidence_type: 'none',
    confidence_score: 0.8,
  });
  assertEquals(v2.item.brand.value, null);
  assertEquals(v2.item.brand.provenance, 'unknown');
  // The legacy projection agrees — one identity, two views.
  assertEquals(projectV2ToLegacy(v2).brand_guess, null);
});

Deno.test('a direct tier carries the brand into V2 with truthful provenance', () => {
  const v2 = normalizeFixture({
    item_type: 'pants',
    clothing_type: 'jeans',
    subtype: 'straight_leg_jeans',
    brand_guess: "Levi's",
    visible_brand_text: "LEVI'S",
    brand_evidence_level: 'direct',
    brand_evidence_type: 'wordmark',
    confidence_score: 0.9,
  });
  assertEquals(v2.item.brand.value, "Levi's");
  assertEquals(v2.item.brand.provenance, 'visible_text');
  assert(
    v2.item.brand.evidence.some((e) => e.type === 'evidence_wordmark'),
    'V2 must record what kind of evidence was accepted',
  );
  assertEquals(projectV2ToLegacy(v2).brand_guess, "Levi's");
});

Deno.test('normalizeToV2 keeps its pre-Phase-7.2 behavior when no tier is present', () => {
  // Backward compatibility: any caller that has not run the gate is unaffected.
  const v2 = normalizeFixture({
    item_type: 'top',
    clothing_type: 'shirt',
    subtype: null,
    brand_guess: 'Acme',
    visible_brand_text: 'ACME',
    confidence_score: 0.8,
  });
  assertEquals(v2.item.brand.value, 'Acme');
  assertEquals(v2.item.brand.provenance, 'visible_text');
});

Deno.test('the vocabularies are closed sets', () => {
  assertEquals([...BRAND_EVIDENCE_LEVELS], ['none', 'style_only', 'distinctive', 'direct']);
  assert(BRAND_EVIDENCE_TYPES.includes('wordmark'));
  assert(BRAND_EVIDENCE_TYPES.includes('none'));
});

// ══════════════════════════════════════════════════════════════════════════
// BRAND ↔ TAXONOMY SEPARATION  (§13)
// ══════════════════════════════════════════════════════════════════════════

Deno.test('a visible brand mark cannot change what the garment is', () => {
  // A Nike logo on a hoodie does not make it a running shoe.
  const before = {
    item_type: 'top',
    clothing_type: 'hoodie',
    subtype: 'pullover_hoodie',
    brand_guess: 'Nike',
    visible_brand_text: 'NIKE',
    logo_detected: true,
    brand_evidence_level: 'direct',
    brand_evidence_type: 'wordmark',
    brand_evidence_on_item: true,
  };
  const { identification } = applyBrandEvidenceGate(before);
  assertEquals(identification.item_type, 'top');
  assertEquals(identification.clothing_type, 'hoodie');
  assertEquals(identification.subtype, 'pullover_hoodie');
  assertEquals(identification.brand_guess, 'Nike');
});

Deno.test('suppressing a brand cannot change what the garment is', () => {
  const { identification } = applyBrandEvidenceGate({
    item_type: 'footwear',
    clothing_type: 'sneaker',
    subtype: 'low_top_sneaker',
    brand_guess: 'Gucci',
    visible_brand_text: null,
    logo_detected: false,
  });
  assertEquals(identification.brand_guess, null);
  assertEquals(identification.item_type, 'footwear');
  assertEquals(identification.clothing_type, 'sneaker');
  assertEquals(identification.subtype, 'low_top_sneaker');
});

// ══════════════════════════════════════════════════════════════════════════
// RECHECK INTEGRATION  (§15)
// ══════════════════════════════════════════════════════════════════════════

Deno.test('the recheck prompt carries the family pack when one resolves', () => {
  const focus = buildDiscriminatorFocus({
    category: 'pants',
    clothingType: 'jeans',
    subtype: null,
  })!;
  const prompt = buildRecheckPrompt({
    primary: { category: 'pants', clothingType: 'jeans', subtype: null },
    primaryConfidence: 0.45,
    reasonCodes: ['AMBIGUOUS_SUBTYPE'],
    garmentContext: null,
    discriminatorFocus: focus,
    primaryBrand: null,
  });
  assert(prompt.includes('This is a pants item'));
  assert(prompt.includes('leg width'));
  assert(prompt.includes('attention cues, not answers'));
});

Deno.test('the recheck prompt omits the pack section when no family resolves', () => {
  const prompt = buildRecheckPrompt({
    primary: { category: null, clothingType: null, subtype: null },
    primaryConfidence: null,
    reasonCodes: ['LOW_IDENTITY_CONFIDENCE'],
    garmentContext: null,
    discriminatorFocus: null,
    primaryBrand: null,
  });
  assert(!prompt.includes('Re-evaluate it using:'));
});

Deno.test('an established brand is not revisited by the recheck', () => {
  const prompt = buildRecheckPrompt({
    primary: { category: 'pants', clothingType: 'jeans', subtype: null },
    primaryConfidence: 0.45,
    reasonCodes: ['AMBIGUOUS_SUBTYPE'],
    garmentContext: null,
    discriminatorFocus: null,
    primaryBrand: "Levi's",
  });
  assert(prompt.includes("already established as Levi's"));
  assert(prompt.includes('Do not revisit it'));
});

Deno.test('the recheck brand instruction forbids every contamination source', () => {
  const prompt = buildRecheckPrompt({
    primary: { category: 'pants', clothingType: 'jeans', subtype: null },
    primaryConfidence: 0.45,
    reasonCodes: ['AMBIGUOUS_SUBTYPE'],
    garmentContext: null,
    discriminatorFocus: null,
    primaryBrand: null,
  });
  for (const guard of ['backgrounds', 'watermarks', 'packaging', 'shopping bags', 'other garment']) {
    assert(prompt.includes(guard), `recheck brand guard missing: ${guard}`);
  }
  assert(prompt.includes('Never complete partially obscured letters'));
  assert(prompt.includes('Unknown brand is a correct answer'));
});

Deno.test('recheck brand is adopted ONLY to fill an unknown, on a direct on-item mark', () => {
  const direct = {
    brand: 'Nike',
    evidenceLevel: 'direct' as const,
    evidenceType: 'wordmark' as const,
    evidenceOnItem: true,
  };
  assertEquals(shouldAdoptRecheckBrand({ primaryBrand: null, finding: direct }), true);
  // Never overwrites an existing brand.
  assertEquals(shouldAdoptRecheckBrand({ primaryBrand: "Levi's", finding: direct }), false);
  // Tier B is not enough for adoption.
  assertEquals(
    shouldAdoptRecheckBrand({
      primaryBrand: null,
      finding: { ...direct, evidenceLevel: 'distinctive' },
    }),
    false,
  );
  // Attribution must be affirmative.
  assertEquals(
    shouldAdoptRecheckBrand({ primaryBrand: null, finding: { ...direct, evidenceOnItem: null } }),
    false,
  );
  assertEquals(
    shouldAdoptRecheckBrand({ primaryBrand: null, finding: { ...direct, evidenceOnItem: false } }),
    false,
  );
  // A direct level with no named mark kind has no artifact to record.
  assertEquals(
    shouldAdoptRecheckBrand({ primaryBrand: null, finding: { ...direct, evidenceType: null } }),
    false,
  );
});

Deno.test('an adopted brand is backed by a real artifact and re-gated', () => {
  const artifact = recheckBrandArtifact({
    brand: 'Nike',
    evidenceLevel: 'direct',
    evidenceType: 'wordmark',
    evidenceOnItem: true,
  });
  assertEquals(artifact.visibleBrandText, 'Nike');
  assertEquals(artifact.logoDetected, false);

  const logo = recheckBrandArtifact({
    brand: 'Nike',
    evidenceLevel: 'direct',
    evidenceType: 'logo',
    evidenceOnItem: true,
  });
  assertEquals(logo.visibleBrandText, null);
  assertEquals(logo.logoDetected, true);

  // Wired: index.ts re-gates rather than trusting the adopted brand.
  const adoptIndex = INDEX_SOURCE.indexOf('shouldAdoptRecheckBrand({');
  const regateIndex = INDEX_SOURCE.indexOf('const regated = applyBrandEvidenceGate(identification);');
  assert(adoptIndex > 0 && regateIndex > adoptIndex, 'adopted brand must be re-gated');
});

Deno.test('brand uncertainty alone still never triggers a recheck', () => {
  // §3: unknown brand must not spend a provider call. Phase 7.1 made the brand
  // reason corroborating-only; Phase 7.2 must not have quietly promoted it.
  const gate = evaluateIdentificationGate({
    identity: { category: 'pants', clothingType: 'jeans', subtype: 'wide_leg_jeans' },
    globalConfidence: 0.91,
    consistencyConflictCodes: ['unsupported_brand'],
    qualityBand: 'high',
    visualObservations: ['Wide leg denim.'],
    identityBearing: true,
  });
  assertEquals(gate.decision, 'CLEAR');
  assert(gate.reasonCodes.includes('BRAND_IDENTITY_CONFLICT'));
  assertEquals(gate.triggeringReasonCodes, []);
});

Deno.test('parse: brand keys are optional and absent brand parses cleanly', () => {
  const taxonomyOnly = parseRecheckPayload(
    '{"category":"pants","clothing_type":"jeans","subtype":"wide_leg_jeans","confidence":0.9}',
  );
  assert(taxonomyOnly);
  assertEquals(taxonomyOnly.brand.brand, null);
  assertEquals(taxonomyOnly.brand.evidenceLevel, null);
  assertEquals(taxonomyOnly.brand.evidenceOnItem, null);

  const withBrand = parseRecheckPayload(
    '{"category":"pants","clothing_type":"jeans","subtype":"wide_leg_jeans","confidence":0.9,' +
      '"brand":"Levi\'s","brand_evidence_level":"direct","brand_evidence_type":"wordmark","brand_evidence_on_item":true}',
  );
  assertEquals(withBrand?.brand.brand, "Levi's");
  assertEquals(withBrand?.brand.evidenceLevel, 'direct');
  assertEquals(withBrand?.brand.evidenceType, 'wordmark');
  assertEquals(withBrand?.brand.evidenceOnItem, true);
});

// ══════════════════════════════════════════════════════════════════════════
// PRIMARY PROMPT CONTENT
// ══════════════════════════════════════════════════════════════════════════

Deno.test('the primary prompt directs attention at construction evidence', () => {
  for (
    const cue of [
      'Silhouette:',
      'Construction:',
      'Material surface:',
      'Pattern:',
      'leg width',
      'lapel or collar',
      'neckline, collar, sleeve',
      'toe shape',
      'attention cues, not answers',
    ]
  ) {
    assert(IDENTIFY_PROMPT.includes(cue), `primary prompt must carry: ${cue}`);
  }
});

Deno.test('the primary prompt states the brand evidence hierarchy and its guards', () => {
  for (
    const rule of [
      'Tier A may establish a brand',
      'Tier B may support a brand only when genuinely distinctive',
      'Tier C never establishes a brand',
      'Brand evidence must be ON the item you identified',
      'background signage',
      'watermarks',
      'shopping bags',
      'any other garment',
      '"100% COTTON" is not a brand',
      '"NI..." is not Nike',
      'Unknown brand is a correct answer',
    ]
  ) {
    assert(IDENTIFY_PROMPT.includes(rule), `primary prompt must carry brand rule: ${rule}`);
  }
});

Deno.test('the primary prompt still forbids identifying people', () => {
  // The refactor must not have dropped a safety instruction.
  assert(IDENTIFY_PROMPT.includes('Do not identify people.'));
  assert(
    IDENTIFY_PROMPT.includes(
      'Do not infer age, race, gender identity, body type, health, religion, income, or any protected trait.',
    ),
  );
});

Deno.test('the primary prompt keeps its taxonomy-tier separation rule', () => {
  assert(IDENTIFY_PROMPT.includes('The three taxonomy levels are distinct and must not repeat each other'));
  assert(IDENTIFY_PROMPT.includes('rather than repeating another level'));
});

Deno.test('the primary prompt still fully specifies the response shape', () => {
  // The few-shot examples were removed; the canonical shape block must remain,
  // because the legacy single-item path sends NO responseSchema.
  assert(IDENTIFY_PROMPT.includes('Return strict JSON only, matching exactly this shape:'));
  assert(IDENTIFY_PROMPT.includes('"identification": {'));
  assert(IDENTIFY_PROMPT.includes('"recommendedProducts": []'));
  // And the non-fashion shape, which cannot be inferred from the completed one.
  assert(IDENTIFY_PROMPT.includes('"status": "non_fashion"'));
  assert(IDENTIFY_PROMPT.includes('"non_fashion": true'));
});

Deno.test('TEXT_IDENTIFY_PROMPT did NOT gain image-evidence fields', () => {
  // A text query has no image, so brand-evidence attribution is meaningless
  // there and would only invite fabrication.
  const textPrompt = promptConst('TEXT_IDENTIFY_PROMPT');
  assert(!textPrompt.includes('brand_evidence_level'));
  assert(!textPrompt.includes('brand_evidence_on_item'));
});

// ══════════════════════════════════════════════════════════════════════════
// NO-LATENCY-REGRESSION  (§20)
// ══════════════════════════════════════════════════════════════════════════

Deno.test('§20: no additional provider call site was introduced', () => {
  const urlCallers = (INDEX_SOURCE.match(/buildGeminiUrl\(([^)]*)\)/g) || [])
    .filter((c) => !c.includes('model: string'));
  // Exactly the Phase 7.1 set: the primary attempt loop, plus the one recheck.
  assertEquals(urlCallers.sort(), [
    'buildGeminiUrl(attemptModel)',
    'buildGeminiUrl(routePlan.primaryModel)',
  ]);
});

Deno.test('§20: no OCR, logo API, or other new network dependency', () => {
  for (
    const forbidden of [
      'vision.googleapis',
      'ocr',
      'tesseract',
      'cloudmersive',
      'logo-recognition',
      'clarifai',
      'rekognition',
    ]
  ) {
    const re = new RegExp(forbidden, 'i');
    const offending = INDEX_SOURCE
      .split('\n')
      .filter((l) => re.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
    assertEquals(offending, [], `no new dependency on ${forbidden}`);
  }
});

Deno.test('§20: reasoning latency is bounded while output and timeout budgets stay unchanged', () => {
  assert(INDEX_SOURCE.includes('const MAX_OUTPUT_TOKENS = 2048;'), 'output ceiling unchanged');
  assert(
    INDEX_SOURCE.includes('const DEFAULT_GEMINI_TIMEOUT_MS = 14_000;'),
    'primary timeout unchanged',
  );
  // The primary generationConfig still uses the same ceiling, not a new one.
  const configs = INDEX_SOURCE.match(/maxOutputTokens: MAX_OUTPUT_TOKENS/g) || [];
  assertEquals(configs.length, 2, 'both primary paths still use the shared ceiling');
  assert(
    INDEX_SOURCE.includes("const GEMINI_THINKING_LEVEL = 'minimal';"),
    'classification explicitly avoids the provider medium-thinking default',
  );
  const thinkingConfigs = INDEX_SOURCE.match(
    /thinkingConfig: \{ thinkingLevel: GEMINI_THINKING_LEVEL \}/g,
  ) || [];
  assertEquals(thinkingConfigs.length, 3, 'both primary paths and the one recheck pin minimal thinking');
  assert(!/thinkingBudget|reasoningEffort/i.test(INDEX_SOURCE), 'no token budget or reasoning override');
});

Deno.test('§20: the image is transmitted exactly as before', () => {
  // One inline_data part per provider call, and no resolution change.
  const inlineParts = INDEX_SOURCE.match(/inline_data:/g) || [];
  // Primary image call, primary selected-item path share one construction; the
  // recheck adds exactly one more. Anything beyond that is a second upload.
  assertEquals(inlineParts.length, 2, 'exactly two inline_data constructions');
  assert(
    !/maxWidth|resize|scaleImage|upscale/i.test(INDEX_SOURCE),
    'no image resizing was introduced',
  );
});

Deno.test('§20: the brand gate performs no I/O', () => {
  const source = executableSource('supabase/functions/scan-identify/brandEvidence.ts');
  for (const io of ['fetch(', 'await ', 'Deno.', 'import(']) {
    assert(!source.includes(io), `brand gate must be pure and synchronous (found ${io})`);
  }
});

Deno.test('§20: the discriminator packs perform no I/O and hold no brand list', () => {
  const source = executableSource('supabase/functions/scan-identify/fashionDiscriminatorPacks.ts');
  for (const io of ['fetch(', 'await ', 'import(']) {
    assert(!source.includes(io), `packs must be pure (found ${io})`);
  }
  // §24: no hard-coded brand-by-style rules anywhere in the packs.
  for (const brand of ['nike', 'gucci', 'adidas', 'levi', 'chanel', 'zara', 'prada']) {
    assert(!source.toLowerCase().includes(brand), `packs must not name brands (${brand})`);
  }
});

Deno.test('§24: the brand gate contains no brand catalog', () => {
  // Tiering is about the KIND of evidence, never about which brand was guessed.
  // A brand name appearing in EXECUTABLE code would be a brand-by-style rule;
  // one appearing in a comment is documentation of why such a rule is banned.
  const source = executableSource('supabase/functions/scan-identify/brandEvidence.ts')
    .toLowerCase();
  for (const brand of ['nike', 'gucci', 'adidas', 'chanel', 'zara', 'prada', 'balenciaga']) {
    assert(!source.includes(brand), `brand gate must not name brands in code (${brand})`);
  }
});
