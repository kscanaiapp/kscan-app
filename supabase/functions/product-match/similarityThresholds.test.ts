/**
 * Checkpoint 4 — threshold configuration (Deno).
 *
 * Tests the versioned, source/evidence/category/coverage/image-aware
 * threshold model in isolation from the scoring engine that consumes it
 * (`closetSimilarity.ts`), so a threshold regression and a scoring regression
 * fail in different tests.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  capClassification,
  categoryFamilyOf,
  coverageOf,
  readThresholdOverrides,
  resolveThresholds,
  SIMILARITY_THRESHOLD_TABLE,
  SIMILARITY_THRESHOLD_VERSION,
} from './similarityThresholds.ts';

Deno.test('the threshold version is a non-empty, stable string', () => {
  assert(SIMILARITY_THRESHOLD_VERSION.length > 0);
  assertEquals(SIMILARITY_THRESHOLD_TABLE.version, SIMILARITY_THRESHOLD_VERSION);
});

// ── category family ─────────────────────────────────────────────────────────

Deno.test('umbrella categories the scanner actually emits resolve correctly', () => {
  assertEquals(categoryFamilyOf('footwear'), 'identity_strong');
  assertEquals(categoryFamilyOf('outerwear'), 'identity_strong');
  assertEquals(categoryFamilyOf('Sneakers'), 'identity_strong');
  assertEquals(categoryFamilyOf('handbag'), 'identity_strong');
});

Deno.test('basics and uniforms are their own family, checked before identity_strong', () => {
  assertEquals(categoryFamilyOf('t-shirt'), 'uniform_basic');
  assertEquals(categoryFamilyOf('Crew Socks'), 'uniform_basic');
  assertEquals(categoryFamilyOf('underwear'), 'uniform_basic');
  // A category matching both lists gets the QUIETER treatment.
  assertEquals(categoryFamilyOf('polo shirt jacket'), 'uniform_basic');
});

Deno.test('an unrecognized or absent category is the safe middle default', () => {
  assertEquals(categoryFamilyOf('spaceship'), 'general');
  assertEquals(categoryFamilyOf(null), 'general');
  assertEquals(categoryFamilyOf(undefined), 'general');
  assertEquals(categoryFamilyOf(''), 'general');
});

// ── coverage bands ───────────────────────────────────────────────────────────

Deno.test('coverage bands match their documented boundaries', () => {
  assertEquals(coverageOf(0), 'thin');
  assertEquals(coverageOf(2), 'thin');
  assertEquals(coverageOf(3), 'partial');
  assertEquals(coverageOf(4), 'partial');
  assertEquals(coverageOf(5), 'rich');
  assertEquals(coverageOf(8), 'rich');
});

// ── resolveThresholds: base profiles differ where the design says they must ──

Deno.test('Recent Scans requires more evidence than Closet, both dimensions', () => {
  const closetAttr = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'both',
  });
  const recentAttr = resolveThresholds({
    source: 'recent_scan', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'both',
  });
  assert(
    recentAttr.minDistinctPositiveClasses >= closetAttr.minDistinctPositiveClasses,
    'Recent Scans must not require FEWER distinct classes than Closet',
  );
  assert(recentAttr.potentialAt > closetAttr.potentialAt, 'Recent Scans must sit at a higher score floor');

  const closetId = resolveThresholds({
    source: 'closet', evidenceMode: 'identifier_backed', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'both',
  });
  const recentId = resolveThresholds({
    source: 'recent_scan', evidenceMode: 'identifier_backed', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'both',
  });
  assert(recentId.potentialAt > closetId.potentialAt);
});

Deno.test('identifier-backed evidence needs fewer distinct classes than attribute-only, same source', () => {
  // NOTE: `potentialAt` is not comparable ACROSS evidence modes as a raw
  // number — identifier and attribute reasons sit on deliberately different
  // weight scales (`authoritative_identifier_match` alone outweighs any two
  // attribute reasons combined), so a lower class requirement is the correct,
  // scale-independent way to state "needs less corroboration". Whether a
  // REAL comparison actually clears each bar is exercised by the directional
  // fixture suite, not by comparing the two floors as numbers.
  for (const source of ['closet', 'recent_scan'] as const) {
    const identifierBacked = resolveThresholds({
      source, evidenceMode: 'identifier_backed', categoryFamily: 'identity_strong',
      coverage: 'rich', imageAvailability: 'both',
    });
    const attributeOnly = resolveThresholds({
      source, evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
      coverage: 'rich', imageAvailability: 'both',
    });
    assert(
      identifierBacked.minDistinctPositiveClasses <= attributeOnly.minDistinctPositiveClasses,
      `${source}: an identifier path must not require MORE distinct classes than attribute-only`,
    );
  }
});

Deno.test('uniforms and basics require strictly more evidence than the general default', () => {
  const basics = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'uniform_basic',
    coverage: 'rich', imageAvailability: 'both',
  });
  const general = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'general',
    coverage: 'rich', imageAvailability: 'both',
  });
  assert(basics.minDistinctPositiveClasses > general.minDistinctPositiveClasses);
  assert(basics.potentialAt > general.potentialAt);
});

Deno.test('thin metadata coverage raises the floor without changing the class requirement', () => {
  const rich = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'both',
  });
  const thin = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'thin', imageAvailability: 'both',
  });
  assert(thin.potentialAt > rich.potentialAt, 'thin coverage must raise the score floor');
  assertEquals(
    thin.minDistinctPositiveClasses,
    rich.minDistinctPositiveClasses,
    'an unsatisfiable class requirement would be a silent off-switch — the score floor does the work instead',
  );
});

Deno.test('missing or poor images raise the floor and cap the classification below STRONG', () => {
  const both = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'both',
  });
  const oneMissing = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'one_missing',
  });
  const none = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'none',
  });
  assert(oneMissing.potentialAt > both.potentialAt);
  assert(none.potentialAt > oneMissing.potentialAt);
  assertEquals(oneMissing.maxClassification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(none.maxClassification, 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(both.maxClassification, 'STRONG_SIMILARITY');
});

Deno.test('a poor-quality image is a softer penalty than a fully missing one, and does not cap', () => {
  const poor = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'poor_quality',
  });
  const missing = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'none',
  });
  assert(poor.potentialAt < missing.potentialAt);
  assertEquals(poor.maxClassification, 'STRONG_SIMILARITY', 'a poor image still lets the user look and judge');
});

Deno.test('adjustments are additive and every one that fired is named', () => {
  const resolved = resolveThresholds({
    source: 'recent_scan', evidenceMode: 'attribute_only', categoryFamily: 'uniform_basic',
    coverage: 'thin', imageAvailability: 'one_missing',
  });
  assert(resolved.adjustmentsApplied.some((entry) => entry.startsWith('base:recent_scan')));
  assert(resolved.adjustmentsApplied.some((entry) => entry.startsWith('category:uniform_basic')));
  assert(resolved.adjustmentsApplied.some((entry) => entry.startsWith('coverage:thin')));
  assert(resolved.adjustmentsApplied.some((entry) => entry.startsWith('image:one_missing')));
});

Deno.test('a rich, both-images, identity_strong comparison names only its base adjustment', () => {
  const resolved = resolveThresholds({
    source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'identity_strong',
    coverage: 'rich', imageAvailability: 'both',
  });
  assertEquals(resolved.adjustmentsApplied, ['base:closet/attribute_only']);
});

// ── overrides: calibration-only, never load-bearing by default ─────────────

Deno.test('overrides replace the resolved value and are recorded as having fired', () => {
  const resolved = resolveThresholds(
    { source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'general', coverage: 'rich', imageAvailability: 'both' },
    { potentialAt: 0.9, strongAt: 0.95, minDistinctPositiveClasses: 5 },
  );
  assertEquals(resolved.potentialAt, 0.9);
  assertEquals(resolved.strongAt, 0.95);
  assertEquals(resolved.minDistinctPositiveClasses, 5);
  assert(resolved.adjustmentsApplied.includes('override:potentialAt'));
  assert(resolved.adjustmentsApplied.includes('override:strongAt'));
  assert(resolved.adjustmentsApplied.includes('override:minDistinctPositiveClasses'));
});

Deno.test('a strongAt override below potentialAt is clamped, never inverted', () => {
  const resolved = resolveThresholds(
    { source: 'closet', evidenceMode: 'attribute_only', categoryFamily: 'general', coverage: 'rich', imageAvailability: 'both' },
    { potentialAt: 0.5, strongAt: 0.1 },
  );
  assertEquals(resolved.strongAt, 0.5, 'STRONG must never be reachable by a score that fails POTENTIAL');
});

Deno.test('with no environment set, every override reads as undefined', () => {
  const overrides = readThresholdOverrides(() => undefined);
  assertEquals(overrides.potentialAt, undefined);
  assertEquals(overrides.strongAt, undefined);
  assertEquals(overrides.minDistinctPositiveClasses, undefined);
});

Deno.test('a non-numeric environment value is ignored rather than producing NaN', () => {
  const overrides = readThresholdOverrides((key) =>
    key === 'SIMILARITY_THRESHOLD_POTENTIAL_AT' ? 'not-a-number' : undefined
  );
  assertEquals(overrides.potentialAt, undefined);
});

Deno.test('a numeric environment value is parsed', () => {
  const overrides = readThresholdOverrides((key) =>
    key === 'SIMILARITY_THRESHOLD_STRONG_AT' ? '0.81' : undefined
  );
  assertEquals(overrides.strongAt, 0.81);
});

// ── capClassification ───────────────────────────────────────────────────────

Deno.test('capClassification never raises a value, only lowers or leaves it', () => {
  assertEquals(capClassification('STRONG_SIMILARITY', 'POTENTIAL_SIMILAR_ITEM'), 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(capClassification('POTENTIAL_SIMILAR_ITEM', 'STRONG_SIMILARITY'), 'POTENTIAL_SIMILAR_ITEM');
  assertEquals(capClassification('NO_NOTICE', 'STRONG_SIMILARITY'), 'NO_NOTICE');
  assertEquals(capClassification('STRONG_SIMILARITY', 'STRONG_SIMILARITY'), 'STRONG_SIMILARITY');
});
