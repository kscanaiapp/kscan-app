/**
 * Checkpoint 4 — directional validation suite (Deno).
 *
 * THIS IS NOT A STATISTICALLY CERTIFIED BENCHMARK. See
 * `tools/product-match-benchmark` for the same caveat applied to commerce
 * matching — the same rule applies here, for the same reason: every fixture
 * below is hand-written by one team, over one afternoon, against one version
 * of the engine. It proves the pipeline does what it says on cases we wrote.
 * It cannot tell you how often the engine is RIGHT about real scans.
 *
 * Every case is asserted against the engine's ACTUAL behaviour, verified by
 * hand before this file was written — not against what "should" happen in
 * the abstract. Two cases are flagged below as considered trade-offs rather
 * than obviously-correct outcomes; both are called out again in the
 * Checkpoint 4 report's false-alert / missed-alert sections.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { classifyPair, classifySimilarItems } from './closetSimilarity.ts';
import type { ExistingItemCandidate, ProductMatchQuery } from './contracts.ts';
import type { SimilarityScanIdentity } from './contracts.ts';

function existing(overrides: Partial<ExistingItemCandidate> & { id: string }): ExistingItemCandidate {
  return { source: 'closet', ...overrides };
}

type Fixture = {
  name: string;
  query: ProductMatchQuery;
  item: ExistingItemCandidate;
  scanIdentity?: SimilarityScanIdentity;
  expect: 'NO_NOTICE' | 'POTENTIAL_SIMILAR_ITEM' | 'STRONG_SIMILARITY';
  note?: string;
};

// ── 1. same exact product and colour ────────────────────────────────────────

Deno.test('directional: same exact product and colour (Closet) notices', () => {
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing({ id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(result.conflicts, []);
});

// ── 2. same product, different colour ───────────────────────────────────────

Deno.test('directional: same product, different colour still notices, with the difference named', () => {
  // Deliberate design choice: a different colourway of the same product is
  // still worth surfacing ("you scanned the same shoe in black — you have it
  // in white") rather than suppressed as "not the same item". The conflict is
  // reported alongside the agreements so the user can see WHY it looks
  // slightly different, not just that it does.
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'black' },
    existing({ id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(result.conflicts, ['different_colorway']);
});

// ── 3. two intentionally owned identical items (uniforms / basics) ─────────

Deno.test('directional: a plain basic with only moderate evidence does not notice', () => {
  // Two black t-shirts, same brand/colour/category/material, no model name to
  // distinguish them. This is the exact "I own six identical black tees"
  // case the uniform_basic category exists to protect.
  const result = classifyPair(
    { brand: 'Uniqlo', visibleBrandText: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white', material: 'cotton' },
    existing({ id: 'c1', brand: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white', material: 'cotton' }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
  assertEquals(result.categoryFamily, 'uniform_basic');
});

Deno.test('directional: a basic garment CAN notice when a specific model name also matches', () => {
  // The uniform_basic bar is higher, not infinite. A matching product/model
  // name is a genuinely more specific claim than "also a white tee".
  const result = classifyPair(
    { brand: 'Uniqlo', visibleBrandText: 'Uniqlo', model: 'Crew Neck Tee', canonicalCategory: 't-shirt', color: 'white' },
    existing({ id: 'c1', brand: 'Uniqlo', model: 'Crew Neck Tee', canonicalCategory: 't-shirt', color: 'white' }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
});

// ── 4. replacement purchases (Recent Scans) ─────────────────────────────────

Deno.test('directional: a replacement purchase still notices from Recent Scans with enough evidence', () => {
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing({ id: 'r1', source: 'recent_scan', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
});

// ── 5. visually similar products from different brands ─────────────────────

Deno.test('directional: same colour, silhouette and category but a different brand does not notice', () => {
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', canonicalCategory: 'footwear', color: 'white', silhouette: 'low-top' },
    existing({ id: 'c1', brand: 'Adidas', canonicalCategory: 'footwear', color: 'white', silhouette: 'low-top' }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
});

// ── 6. same category, different silhouette ──────────────────────────────────

Deno.test('directional: same brand/colour/category but a conflicting silhouette does not notice', () => {
  // FLAGGED AS A CONSIDERED TRADE-OFF, not an obviously-correct answer — see
  // the Checkpoint 4 report. Brand + colour + category alone (0.42) would
  // clear the Closet/attribute_only floor (0.39); the silhouette conflict
  // pulls it back under (0.32). "Same brand, same colour, a different
  // silhouette" is very plausibly two different products (a low-top and a
  // high-top version) — but it could also be the same product line described
  // inconsistently by two capture passes. This suite records the behaviour
  // rather than asserting it is definitely right.
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', canonicalCategory: 'footwear', color: 'white', silhouette: 'low-top' },
    existing({ id: 'c1', brand: 'Nike', canonicalCategory: 'footwear', color: 'white', silhouette: 'high-top' }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
  assertEquals(result.conflicts, ['different_silhouette']);
});

// ── 7. same colour, unrelated products ──────────────────────────────────────

Deno.test('directional: same colour but a different category never notices, category conflict vetoes', () => {
  const result = classifyPair(
    { canonicalCategory: 'dress', color: 'red' },
    existing({ id: 'c1', canonicalCategory: 'footwear', color: 'red' }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
  assertEquals(result.structuralVeto, 'category_conflict');
});

// ── 8. identifier-backed evidence ────────────────────────────────────────────

Deno.test('directional: an identifier on only one side is not evidence of anything', () => {
  const result = classifyPair(
    { canonicalCategory: 'footwear' },
    existing({ id: 'c1', canonicalCategory: 'footwear' }),
    { authoritativeId: 'SKU-123' },
  );
  assertEquals(result.classification, 'NO_NOTICE');
  assertEquals(result.evidenceMode, 'attribute_only');
});

Deno.test('directional: a matching authoritative identifier notices even with almost nothing else known', () => {
  const result = classifyPair(
    { canonicalCategory: 'footwear' },
    existing({ id: 'c1', canonicalCategory: 'footwear', authoritativeId: 'SKU-123' }),
    { authoritativeId: 'SKU-123' },
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(result.evidenceMode, 'identifier_backed');
  assert(result.reasons.includes('authoritative_identifier_match'));
});

Deno.test('directional: a DISAGREEING identifier vetoes despite otherwise-perfect attribute agreement', () => {
  // FLAGGED AS A KNOWN RISK, not a defect — see the Checkpoint 4 report. This
  // is the intended behaviour (a barcode/SKU disagreement is stronger
  // evidence than four matching attributes), but it means an incorrectly
  // supplied identifier on either side produces a MISSED alert that no
  // amount of attribute evidence can override. The engine has no way to tell
  // "these are different products" apart from "the caller's identifier data
  // is wrong".
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
      authoritativeId: 'SKU-999',
    }),
    { authoritativeId: 'SKU-000' },
  );
  assertEquals(result.classification, 'NO_NOTICE');
  assertEquals(result.structuralVeto, 'identifier_conflict');
  // The attribute evidence was still collected and was strong — proof the
  // veto is a deliberate override, not an accident of scoring.
  assertEquals(result.distinctPositiveClasses, 4);
});

// ── 9. missing / poor-quality images ────────────────────────────────────────

Deno.test('directional: missing images on both sides still notices with strong attribute evidence, capped at POTENTIAL', () => {
  const strongQuery: ProductMatchQuery = {
    brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
  };
  const result = classifyPair(
    strongQuery,
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
      imageQuality: 'missing',
    }),
    { imageQuality: 'missing' },
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(result.imageAvailability, 'none');
});

Deno.test('directional: a poor-quality image is a softer penalty than a missing one', () => {
  const strongQuery: ProductMatchQuery = {
    brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
  };
  const result = classifyPair(
    strongQuery,
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
      imageQuality: 'poor',
    }),
    { imageQuality: 'poor' },
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(result.imageAvailability, 'poor_quality');
});

// ── 10. incomplete metadata ──────────────────────────────────────────────────

Deno.test('directional: a single weak signal never notices', () => {
  const result = classifyPair({ color: 'white' }, existing({ id: 'c1', color: 'white' }));
  assertEquals(result.classification, 'NO_NOTICE');
});

Deno.test('directional: category + colour alone (thin coverage) no longer notices — a real strengthening over Checkpoint 3', () => {
  // Checkpoint 3's flat gate (`reasonsAreSufficient`) would have ADMITTED
  // this: two reasons, one of them (colour) non-weak. Checkpoint 4 correctly
  // withholds it, because with almost nothing else known about either item,
  // "same category, same colour" describes a huge fraction of any wardrobe.
  // This is the concrete false-alert-PREVENTED example for the report.
  const result = classifyPair(
    { canonicalCategory: 'footwear', color: 'white' },
    existing({ id: 'c1', canonicalCategory: 'footwear', color: 'white' }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
  assertEquals(result.coverage, 'thin');
  assertEquals(result.distinctPositiveClasses, 2);
  assert(
    result.distinctPositiveClasses < result.minDistinctPositiveClasses,
    'this case is exactly the one Checkpoint 3 would have flagged and Checkpoint 4 does not',
  );
});

// ── 11. Closet vs Recent Scans, same evidence ───────────────────────────────

Deno.test('directional: identical 3-reason evidence notices from Closet but not from Recent Scans', () => {
  const query: ProductMatchQuery = {
    brand: 'Nike', visibleBrandText: 'Nike', canonicalCategory: 'footwear', color: 'white',
  };
  const closetResult = classifyPair(query, existing({ id: 'c1', brand: 'Nike', canonicalCategory: 'footwear', color: 'white' }));
  const recentResult = classifyPair(
    query,
    existing({ id: 'r1', source: 'recent_scan', brand: 'Nike', canonicalCategory: 'footwear', color: 'white' }),
  );
  assertEquals(closetResult.classification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(recentResult.classification, 'NO_NOTICE');
  assertEquals(recentResult.netScore, closetResult.netScore, 'same inputs must produce the same raw score');
});

// ── 12. candidates present in both sources at once ──────────────────────────

Deno.test('directional: a Closet and a Recent Scans candidate are judged independently in one request', () => {
  const query: ProductMatchQuery = {
    brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
  };
  const { items } = classifySimilarItems({
    query,
    existingItems: [
      existing({ id: 'closet-1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' }),
      existing({
        id: 'recent-1', source: 'recent_scan', brand: 'Nike', canonicalCategory: 'footwear', color: 'white',
      }),
    ],
  });
  // The Closet item (4 reasons) qualifies; the Recent Scans item (3 reasons,
  // needs 4 for that source) does not — same population, different bars.
  assertEquals(items.length, 1);
  assertEquals(items[0].existingItemId, 'closet-1');
  assertEquals(items[0].existingItemSource, 'closet');
});

// ── 13. cases where no notice should appear at all ──────────────────────────

Deno.test('directional: completely unrelated items across every dimension never notice', () => {
  const result = classifyPair(
    { brand: 'Nike', canonicalCategory: 'footwear', color: 'white' },
    existing({ id: 'c1', brand: 'Zara', canonicalCategory: 'dress', color: 'green', material: 'linen' }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
});

Deno.test('directional: no existing items at all produces no notices and no error', () => {
  const { items, classifiedBeforeCap } = classifySimilarItems({
    query: { brand: 'Nike', canonicalCategory: 'footwear' },
    existingItems: [],
  });
  assertEquals(items, []);
  assertEquals(classifiedBeforeCap, 0);
});

// ── 14. STRONG_SIMILARITY is reachable, and by which evidence ──────────────
//
// Answering the taxonomy question directly: STRONG_SIMILARITY is fully
// implemented and reachable. It is NOT collapsed into POTENTIAL, and it is
// NOT unreachable in practice. What it requires is either an identifier plus
// corroboration, or near-total attribute agreement — a bar the everyday
// fixtures above deliberately do not clear.

Deno.test('STRONG: an authoritative identifier plus corroborating attributes reaches STRONG', () => {
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
      authoritativeId: 'CW2288-111',
    }),
    { authoritativeId: 'CW2288-111' },
  );
  assertEquals(result.classification, 'STRONG_SIMILARITY');
  assertEquals(result.evidenceMode, 'identifier_backed');
});

Deno.test('STRONG: a shared canonical product URL plus attributes also reaches STRONG', () => {
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
      productUrl: 'https://nike.com/t/af1',
    }),
    { productUrl: 'https://nike.com/t/af1' },
  );
  assertEquals(result.classification, 'STRONG_SIMILARITY');
  assertEquals(result.evidenceMode, 'identifier_backed');
});

Deno.test('STRONG: near-total attribute agreement reaches STRONG without any identifier', () => {
  const full = {
    brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
    color: 'white', material: 'leather', silhouette: 'low-top', pattern: 'solid',
  };
  const result = classifyPair(
    full,
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
      color: 'white', material: 'leather', silhouette: 'low-top', pattern: 'solid',
    }),
  );
  assertEquals(result.classification, 'STRONG_SIMILARITY');
  assertEquals(result.evidenceMode, 'attribute_only');
  assertEquals(result.distinctPositiveClasses, 7);
});

Deno.test('STRONG is still advisory: it carries the same actions and the same resolution', () => {
  const { items } = classifySimilarItems({
    query: { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existingItems: [existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
      authoritativeId: 'CW2288-111',
    })],
    newScanIdentity: { authoritativeId: 'CW2288-111' },
    debug: true,
  });
  assertEquals(items.length, 1);
  assertEquals(items[0].internal?.classification, 'STRONG_SIMILARITY');
  // The safety properties do not weaken at the higher band.
  assertEquals(items[0].potentialSimilarItem, true);
  assertEquals(items[0].resolution, 'user_required');
  assertEquals(items[0].availableActions.length, 6);
});

// ── 15. the basics evidence ladder ──────────────────────────────────────────
//
// The product question: would a notice help, or would it repeatedly flag
// ordinary basics people intentionally own in multiples? These four cases
// pin the answer as a LADDER rather than a single verdict.

Deno.test('BASICS ladder 1/4: brand + colour + category + material alone stays silent', () => {
  const result = classifyPair(
    { brand: 'Uniqlo', visibleBrandText: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white', material: 'cotton' },
    existing({ id: 'c1', brand: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white', material: 'cotton' }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
});

Deno.test('BASICS ladder 2/4: a matching model/line lifts it to a notice', () => {
  const result = classifyPair(
    { brand: 'Uniqlo', visibleBrandText: 'Uniqlo', model: 'Crew Neck Tee', canonicalCategory: 't-shirt', color: 'white' },
    existing({ id: 'c1', brand: 'Uniqlo', model: 'Crew Neck Tee', canonicalCategory: 't-shirt', color: 'white' }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
});

Deno.test('BASICS ladder 3/4: an unusually specific material + silhouette + pattern combination lifts it', () => {
  const result = classifyPair(
    {
      brand: 'Uniqlo', visibleBrandText: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white',
      material: 'supima cotton', silhouette: 'boxy crop', pattern: 'solid',
    },
    existing({
      id: 'c1', brand: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white',
      material: 'supima cotton', silhouette: 'boxy crop', pattern: 'solid',
    }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
});

Deno.test('BASICS ladder 4/4: an authoritative identifier reaches STRONG even for a basic', () => {
  const result = classifyPair(
    { brand: 'Uniqlo', visibleBrandText: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white' },
    existing({
      id: 'c1', brand: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white', authoritativeId: 'UNI-TEE-001',
    }),
    { authoritativeId: 'UNI-TEE-001' },
  );
  assertEquals(result.classification, 'STRONG_SIMILARITY');
  assertEquals(result.categoryFamily, 'uniform_basic');
});

Deno.test('BASICS: a distinctive pattern alone falls just SHORT — recorded, not endorsed', () => {
  // KNOWN CALIBRATION GAP, reported in the Checkpoint 4 report rather than
  // tuned away. Net 0.52 against a 0.54 floor — two hundredths short.
  //
  // The engine has no notion of pattern DISTINCTIVENESS: `pattern` carries the
  // lowest positive weight (0.04) precisely because most values are "solid",
  // and a "breton stripe" is scored identically. Raising the pattern weight to
  // admit this case would also admit every "solid" pairing, which is the
  // opposite of what the basics guard is for. The honest fix is a
  // distinctiveness signal the scanner does not currently emit.
  const result = classifyPair(
    {
      brand: 'Uniqlo', visibleBrandText: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white',
      material: 'cotton', pattern: 'breton stripe',
    },
    existing({
      id: 'c1', brand: 'Uniqlo', canonicalCategory: 't-shirt', color: 'white',
      material: 'cotton', pattern: 'breton stripe',
    }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
  assert(
    result.netScore < result.potentialAt,
    'documents the margin: this is a threshold outcome, not a missing signal',
  );
  assert(result.potentialAt - result.netScore < 0.05, 'and it is a NARROW miss, which is why it is reported');
});

// ── 16. conflicting size, model generations, pattern conflicts ─────────────

Deno.test('directional: size is not modelled, so a size-only difference is invisible to the engine', () => {
  // Recorded as a KNOWN LIMITATION. Neither `ProductMatchQuery` nor
  // `ExistingItemCandidate` carries size, so "same shoe, different size" and
  // "same shoe, same size" are indistinguishable here. For an advisory
  // notice that is defensible — the user can see the size themselves — but
  // it means this engine can never answer "do I already own this IN MY SIZE".
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing({ id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(result.conflicts, [], 'no size conflict can exist, because size is not an input');
});

Deno.test('directional: the same model name across generations notices, with no conflict', () => {
  // "Air Force 1 07" vs "Air Force 1 07 LV8" — the majority-token rule treats
  // these as the same model family. Surfacing them is reasonable (same line,
  // likely the thing the user meant), and the user can see the difference.
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1 07', canonicalCategory: 'footwear', color: 'white' },
    existing({ id: 'c1', brand: 'Nike', model: 'Air Force 1 07 LV8', canonicalCategory: 'footwear', color: 'white' }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
  assert(result.reasons.includes('same_model_tokens'));
  assertEquals(result.conflicts, []);
});

Deno.test('directional: same brand and silhouette but a clearly different model does not notice', () => {
  const result = classifyPair(
    {
      brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
      color: 'white', silhouette: 'low-top',
    },
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Max 90', canonicalCategory: 'footwear',
      color: 'white', silhouette: 'low-top',
    }),
  );
  assertEquals(result.classification, 'NO_NOTICE');
  assert(result.conflicts.includes('different_model_family'));
});

Deno.test('directional: a pattern conflict is now named and penalised', () => {
  // Added in response to Checkpoint 4 review: before `different_pattern`
  // existed, a floral dress and a striped dress sharing brand, colour and
  // material produced a notice with NO conflict recorded at all.
  const result = classifyPair(
    { brand: 'Acne', visibleBrandText: 'Acne', canonicalCategory: 'dress', color: 'blue', pattern: 'floral', material: 'silk' },
    existing({ id: 'c1', brand: 'Acne', canonicalCategory: 'dress', color: 'blue', pattern: 'striped', material: 'silk' }),
  );
  assert(result.conflicts.includes('different_pattern'), 'the disagreement must be named');
});

// ── 17. subtle colourway variants ───────────────────────────────────────────

Deno.test('directional: cream is normalized to white, so no false colourway conflict is raised', () => {
  const result = classifyPair(
    { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
    existing({ id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'cream' }),
  );
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM');
  assert(result.reasons.includes('same_normalized_color'));
  assertEquals(result.conflicts, []);
});

Deno.test('directional: sail and bone are NOT normalized, producing a cosmetically wrong reason', () => {
  // KNOWN DEFECT, reported rather than fixed in this checkpoint. `sail` and
  // `bone` are off-white footwear shades absent from `COLOR_SYNONYMS` in
  // identity.ts. The OUTCOME is still right (brand + model + category carry
  // the notice), but the user is told "Different colourway" about two shades
  // of white.
  //
  // Not fixed here because `normalizeColor` is SHARED with commerce dedupe
  // (`dedupe.ts` builds variantKey from it). Adding sail/bone would merge
  // those colourways in commerce results too — a change to the commerce path,
  // which Checkpoint 4 is explicitly scoped out of ("Closet similarity must
  // remain separate from commerce-listing deduplication").
  for (const shade of ['sail', 'bone']) {
    const result = classifyPair(
      { brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white' },
      existing({ id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: shade }),
    );
    assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM', `${shade}: still surfaces`);
    assert(result.conflicts.includes('different_colorway'), `${shade}: reason is cosmetically wrong`);
  }
});

// ── 18. one low-quality image plus strong metadata ─────────────────────────

Deno.test('directional: one poor image with strong metadata still reaches STRONG', () => {
  const result = classifyPair(
    {
      brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
      color: 'white', material: 'leather',
    },
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
      color: 'white', material: 'leather', imageQuality: 'poor',
    }),
    { imageQuality: 'ok' },
  );
  assertEquals(result.imageAvailability, 'poor_quality');
  assertEquals(result.classification, 'STRONG_SIMILARITY');
});

Deno.test('directional: one MISSING image caps the outcome below STRONG even with the same metadata', () => {
  const result = classifyPair(
    {
      brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
      color: 'white', material: 'leather',
    },
    existing({
      id: 'c1', brand: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
      color: 'white', material: 'leather', imageQuality: 'missing',
    }),
    { imageQuality: 'ok' },
  );
  assertEquals(result.imageAvailability, 'one_missing');
  assertEquals(result.classification, 'POTENTIAL_SIMILAR_ITEM', 'no emphasis when the user cannot look');
});

// ── 19. many potential matches, only the strongest few returned ────────────

Deno.test('directional: many qualifying matches are ranked and only the strongest few returned', () => {
  const query: ProductMatchQuery = {
    brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear',
    color: 'white', material: 'leather',
  };
  // Ten candidates that ALL qualify, with deliberately varying strength.
  const items: ExistingItemCandidate[] = Array.from({ length: 10 }, (_, index) =>
    existing({
      id: `closet-${index}`,
      brand: 'Nike',
      model: 'Air Force 1',
      canonicalCategory: 'footwear',
      color: 'white',
      // The first three also agree on material, so they score strictly higher.
      material: index < 3 ? 'leather' : null,
    }));
  const { items: returned, classifiedBeforeCap } = classifySimilarItems({ query, existingItems: items });

  assertEquals(returned.length, 3, 'a wall of comparisons is not a decision aid');
  assertEquals(classifiedBeforeCap, 10, 'the pre-cap count is reported so the trim is visible');
  // Strongest first, and the survivors are the materially-richer ones.
  assert(returned[0].advisoryConfidence >= returned[1].advisoryConfidence);
  assert(returned[1].advisoryConfidence >= returned[2].advisoryConfidence);
  for (const item of returned) {
    assert(
      ['closet-0', 'closet-1', 'closet-2'].includes(item.existingItemId),
      `the cap must keep the STRONGEST, not the first encountered — got ${item.existingItemId}`,
    );
  }
});

// ── 20. large Closet candidate population, end to end ───────────────────────

Deno.test('directional: a large Closet population still returns a capped, ranked result', () => {
  const query: ProductMatchQuery = {
    brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1', canonicalCategory: 'footwear', color: 'white',
  };
  const items: ExistingItemCandidate[] = Array.from({ length: 25 }, (_, index) =>
    existing({
      id: `closet-${index}`,
      brand: 'Nike',
      canonicalCategory: 'footwear',
      color: 'white',
      // Only every 5th one carries the model match, so only those clear the bar.
      model: index % 5 === 0 ? 'Air Force 1' : null,
    }));
  const startedAt = performance.now();
  const result = classifySimilarItems({ query, existingItems: items });
  const elapsedMs = performance.now() - startedAt;
  assert(result.items.length <= 3, 'the display cap must still apply');
  assert(result.classifiedBeforeCap >= result.items.length);
  assert(elapsedMs < 100, `scoring 25 candidates took ${elapsedMs}ms`);
});
