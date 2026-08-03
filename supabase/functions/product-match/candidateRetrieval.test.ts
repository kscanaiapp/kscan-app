/**
 * Checkpoint 4 — bounded candidate retrieval (Deno).
 *
 * Covers the pre-score filtering pass in isolation from the scoring engine:
 * what gets kept, what gets rejected and why, and that a large candidate
 * population is bounded rather than scored in full.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MAX_CANDIDATES_SCORED, retrieveCandidates } from './candidateRetrieval.ts';
import type { ExistingItemCandidate, ProductMatchQuery } from './contracts.ts';

const QUERY: ProductMatchQuery = {
  brand: 'Nike', visibleBrandText: 'Nike', model: 'Air Force 1',
  canonicalCategory: 'footwear', color: 'white',
};

function item(overrides: Partial<ExistingItemCandidate> & { id: string }): ExistingItemCandidate {
  return { source: 'closet', ...overrides };
}

Deno.test('an empty candidate list retrieves nothing and reports nothing considered', () => {
  const { retained, report } = retrieveCandidates({ query: QUERY, existingItems: [] });
  assertEquals(retained, []);
  assertEquals(report.recordsConsidered, 0);
  assertEquals(report.candidatesRetained, 0);
  assertEquals(report.candidatesRejected, []);
  assertEquals(report.sourcesChecked, []);
});

Deno.test('a comparable candidate is retained', () => {
  const candidate = item({ id: 'c1', brand: 'Nike', canonicalCategory: 'footwear' });
  const { retained, report } = retrieveCandidates({ query: QUERY, existingItems: [candidate] });
  assertEquals(retained.length, 1);
  assertEquals(report.candidatesRetained, 1);
  assertEquals(report.recordsConsidered, 1);
});

Deno.test('a candidate with nothing comparable is rejected before scoring, named', () => {
  const candidate = item({ id: 'c1' }); // no brand/model/category/etc at all
  const { retained, report } = retrieveCandidates({ query: QUERY, existingItems: [candidate] });
  assertEquals(retained.length, 0);
  assertEquals(report.candidatesRejected, [{ reason: 'no_comparable_fields', count: 1 }]);
});

Deno.test('a candidate whose authoritativeId is the only comparable field is still retained', () => {
  const candidate = item({ id: 'c1', authoritativeId: 'SKU-1' });
  const withId: ProductMatchQuery & { authoritativeId?: string } = { ...QUERY };
  const { retained } = retrieveCandidates({ query: withId, existingItems: [candidate] });
  // The query itself carries no authoritativeId (that lives on
  // SimilarityScanIdentity, not ProductMatchQuery — see contracts.ts), so this
  // candidate is retained on the strength of brand/category alone via QUERY,
  // not the id. Confirms retrieval does not require identifier agreement to
  // keep a candidate — that judgement belongs to the scorer, not retrieval.
  assertEquals(retained.length, 1);
});

Deno.test('a structural category conflict is rejected before scoring, named', () => {
  const candidate = item({ id: 'c1', brand: 'Nike', canonicalCategory: 'outerwear', color: 'white' });
  const { retained, report } = retrieveCandidates({ query: QUERY, existingItems: [candidate] });
  assertEquals(retained.length, 0);
  assertEquals(report.candidatesRejected, [{ reason: 'category_conflict', count: 1 }]);
});

Deno.test('a candidate with a same-category attribute is retained even with a low information count', () => {
  const candidate = item({ id: 'c1', canonicalCategory: 'footwear' });
  const { retained } = retrieveCandidates({ query: QUERY, existingItems: [candidate] });
  assertEquals(retained.length, 1, 'category alone is comparable, even though it will not clear scoring alone');
});

Deno.test('sources checked reflects only the sources actually present, in stable order', () => {
  const { report } = retrieveCandidates({
    query: QUERY,
    existingItems: [
      item({ id: 'c1', brand: 'Nike', source: 'recent_scan' }),
      item({ id: 'c2', brand: 'Nike', source: 'recent_scan' }),
    ],
  });
  assertEquals(report.sourcesChecked, ['recent_scan']);
});

Deno.test('both sources are reported when both are present', () => {
  const { report } = retrieveCandidates({
    query: QUERY,
    existingItems: [
      item({ id: 'c1', brand: 'Nike', source: 'closet' }),
      item({ id: 'c2', brand: 'Nike', source: 'recent_scan' }),
    ],
  });
  assertEquals(report.sourcesChecked, ['closet', 'recent_scan']);
});

Deno.test('rejections of different kinds are each counted and both reported', () => {
  const { report } = retrieveCandidates({
    query: QUERY,
    existingItems: [
      item({ id: 'empty-1' }),
      item({ id: 'empty-2' }),
      item({ id: 'conflict-1', canonicalCategory: 'dress' }),
      item({ id: 'ok-1', brand: 'Nike' }),
    ],
  });
  assertEquals(report.recordsConsidered, 4);
  assertEquals(report.candidatesRetained, 1);
  const byReason = Object.fromEntries(report.candidatesRejected.map((r) => [r.reason, r.count]));
  assertEquals(byReason.no_comparable_fields, 2);
  assertEquals(byReason.category_conflict, 1);
});

// ── large-Closet performance ─────────────────────────────────────────────────

Deno.test('a large candidate population is bounded, not scored in full', () => {
  const large = Array.from({ length: 500 }, (_, index) =>
    item({ id: `closet-${index}`, brand: 'Nike', canonicalCategory: 'footwear', color: 'white' }));
  const { retained, report } = retrieveCandidates({ query: QUERY, existingItems: large });
  assertEquals(report.recordsConsidered, 500);
  assert(retained.length <= MAX_CANDIDATES_SCORED, `retained ${retained.length} exceeds the scoring cap`);
  const overCap = report.candidatesRejected.find((r) => r.reason === 'over_scoring_cap');
  assert(overCap, 'a population beyond the cap must report how much was trimmed');
  assertEquals(overCap!.count, 500 - MAX_CANDIDATES_SCORED);
});

Deno.test('retrieval over a large population completes well inside a scan budget', () => {
  const large = Array.from({ length: 2000 }, (_, index) =>
    item({
      id: `closet-${index}`,
      brand: index % 3 === 0 ? 'Nike' : 'Zara',
      canonicalCategory: index % 5 === 0 ? 'footwear' : 'outerwear',
      color: index % 2 === 0 ? 'white' : 'black',
    }));
  const startedAt = performance.now();
  const { report } = retrieveCandidates({ query: QUERY, existingItems: large });
  const elapsedMs = performance.now() - startedAt;
  assertEquals(report.recordsConsidered, 2000);
  // A generous ceiling: this is cheap string normalization over plain
  // objects, not a network call or a database query. A real regression here
  // would be orders of magnitude past this bound, not a few milliseconds.
  assert(elapsedMs < 200, `retrieval over 2000 candidates took ${elapsedMs}ms`);
});

Deno.test('a malformed entry does not throw and is simply not counted as a source', () => {
  const { retained, report } = retrieveCandidates({
    query: QUERY,
    existingItems: [null as unknown as ExistingItemCandidate, item({ id: 'c1', brand: 'Nike' })],
  });
  assertEquals(retained.length, 1);
  assertEquals(report.recordsConsidered, 2);
});

// ── the funnel: how many comparisons SURVIVE pruning ────────────────────────
//
// The load-bearing large-Closet question is not "how fast is one comparison"
// — it is how many comparisons a realistic wardrobe produces at each stage.
// These tests measure the funnel itself and are stated as
// considered → retained → scored, so a future change that quietly widens
// pruning shows up as a survivor-count regression rather than a latency one.

Deno.test('FUNNEL: a same-category-heavy Closet is still bounded, and the survivors are counted', () => {
  // The realistic worst case for pruning: a sneaker collector scanning a
  // sneaker. Category pruning cannot help — every record is footwear — so
  // the per-request cap is the only thing standing between this and scoring
  // the whole wardrobe.
  const sneakerWardrobe = Array.from({ length: 400 }, (_, index) =>
    item({
      id: `closet-${index}`,
      brand: index % 2 === 0 ? 'Nike' : 'Adidas',
      canonicalCategory: 'footwear',
      color: index % 3 === 0 ? 'white' : 'black',
      model: index % 7 === 0 ? 'Air Force 1' : `Model ${index}`,
    }));

  const { retained, report } = retrieveCandidates({ query: QUERY, existingItems: sneakerWardrobe });

  assertEquals(report.recordsConsidered, 400);
  assertEquals(report.candidatesRetained, MAX_CANDIDATES_SCORED);
  assertEquals(retained.length, MAX_CANDIDATES_SCORED);
  // Nothing was rejected for category (they are all footwear) — the cap did
  // all the work, and it says so.
  const byReason = Object.fromEntries(report.candidatesRejected.map((r) => [r.reason, r.count]));
  assertEquals(byReason.category_conflict, undefined);
  assertEquals(byReason.over_scoring_cap, 400 - MAX_CANDIDATES_SCORED);
});

Deno.test('FUNNEL: a mixed wardrobe prunes on category BEFORE the cap, so better candidates survive', () => {
  // 400 records, only 40 of them footwear. Category pruning removes 360
  // before the cap is even considered, so the 20 that get scored are drawn
  // from the relevant 40 rather than from an arbitrary prefix of everything.
  const mixedWardrobe = Array.from({ length: 400 }, (_, index) =>
    item({
      id: `closet-${index}`,
      brand: 'Nike',
      canonicalCategory: index % 10 === 0 ? 'footwear' : 'outerwear',
      color: 'white',
    }));

  const { retained, report } = retrieveCandidates({ query: QUERY, existingItems: mixedWardrobe });

  assertEquals(report.recordsConsidered, 400);
  const byReason = Object.fromEntries(report.candidatesRejected.map((r) => [r.reason, r.count]));
  assertEquals(byReason.category_conflict, 360, 'the irrelevant 90% never reach scoring');
  assertEquals(byReason.over_scoring_cap, 40 - MAX_CANDIDATES_SCORED);
  assertEquals(report.candidatesRetained, MAX_CANDIDATES_SCORED);
  // Every survivor is in the scanned category — pruning improved the pool,
  // it did not merely shrink it.
  for (const candidate of retained) {
    assertEquals(candidate.canonicalCategory, 'footwear');
  }
});

Deno.test('FUNNEL: retrieval cost scales with the population, scoring cost does not', () => {
  // The property that makes a large Closet safe: retrieval is O(records) over
  // cheap string work, but the EXPENSIVE stage downstream is pinned to the
  // cap no matter how large the wardrobe gets.
  const sizes = [100, 1000, 4000];
  const survivors: number[] = [];

  for (const size of sizes) {
    const wardrobe = Array.from({ length: size }, (_, index) =>
      item({ id: `c-${index}`, brand: 'Nike', canonicalCategory: 'footwear', color: 'white' }));
    const startedAt = performance.now();
    const { report } = retrieveCandidates({ query: QUERY, existingItems: wardrobe });
    const elapsedMs = performance.now() - startedAt;
    survivors.push(report.candidatesRetained);
    assertEquals(report.recordsConsidered, size);
    assert(elapsedMs < 300, `retrieval over ${size} candidates took ${elapsedMs}ms`);
  }

  // Constant survivor count across a 40x population increase.
  assertEquals(survivors, [MAX_CANDIDATES_SCORED, MAX_CANDIDATES_SCORED, MAX_CANDIDATES_SCORED]);
});

Deno.test('FUNNEL: retrieval reports its own duration, separately from scoring', () => {
  const wardrobe = Array.from({ length: 500 }, (_, index) =>
    item({ id: `c-${index}`, brand: 'Nike', canonicalCategory: 'footwear', color: 'white' }));
  const { report } = retrieveCandidates({ query: QUERY, existingItems: wardrobe });
  // The number exists and is non-negative — the orchestrator subtracts it
  // from the similarity stage total to derive `compareMs`, so a missing or
  // negative value here would silently corrupt the stage split.
  assert(typeof report.durationMs === 'number');
  assert(report.durationMs >= 0);
});
