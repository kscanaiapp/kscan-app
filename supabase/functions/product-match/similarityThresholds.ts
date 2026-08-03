/**
 * Checkpoint 4 — versioned thresholds for the ADVISORY similar-item notice.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY NUMBER IN THIS FILE IS A PRODUCT DECISION, NOT A TUNING ARTEFACT.
 *  If you change one, change the version string and the justification with it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The engine this configures is advisory in all three of its outcomes. Even
 * `STRONG_SIMILARITY` means "you should probably look at these two side by
 * side", never "these are the same item". Nothing downstream is permitted to
 * read a classification as authority to merge, delete, hide or resolve — see
 * `closetSimilarity.ts` for the enforcement of that rule.
 *
 * WHY THRESHOLDS ARE STRUCTURED RATHER THAN A SINGLE CONSTANT
 *
 * A single global cutoff would have to be right for a scan of a limited-edition
 * sneaker with a barcode match AND for a scan of a plain black t-shirt with no
 * brand and a blurry photo. Those are not the same question, and answering them
 * with one number means being wrong about one of them on purpose. So the cutoff
 * is resolved from four named dimensions, each with a stated reason:
 *
 *   1. SOURCE          Closet vs Recent Scans
 *   2. EVIDENCE MODE   identifier-backed vs attribute-only
 *   3. CATEGORY FAMILY items people deliberately own many of, vs items they do not
 *   4. OBSERVABILITY   how much metadata and how much image there was to go on
 *
 * The resolved profile records which adjustments fired, so a surprising notice
 * can be explained after the fact instead of guessed at.
 *
 * NUMBERS ARE CONSTRAINED BY THE CHECKPOINT 3 GOVERNED SUITE
 *
 * `productMatchUserValue.test.ts` and `productMatchOrchestration.test.ts` fixed
 * several admit/reject outcomes for the OLD flat `MIN_REASONS` gate before this
 * file existed (a 3-reason attribute-only Closet comparison must admit; a
 * 4-reason one obviously must). The base profiles below are chosen so every one
 * of those pre-existing outcomes still holds — the margins are noted at each
 * constant so a future change can see how much room it has.
 */

import type { EnvGet } from './config.ts';
import { defaultEnvGet } from './config.ts';

/**
 * Bump on ANY change to a weight, cutoff or gate below.
 *
 * The version travels with every comparison into telemetry and the internal
 * debug block, so a threshold change that silently altered behaviour would be
 * visible in both places rather than shipping quietly.
 */
export const SIMILARITY_THRESHOLD_VERSION = 'closet-similarity-thresholds/2026-08-03.v1';

/**
 * The three internal outcomes.
 *
 * `NO_NOTICE` is the default and the one the engine is biased toward. A notice
 * the user dismisses every time is worse than no notice at all, because it
 * trains them to dismiss the one that mattered.
 *
 * `STRONG_SIMILARITY` exists to order and emphasise, NOT to authorise. It is
 * still `potentialSimilarItem: true`, still `resolution: 'user_required'`, and
 * still offers the full action vocabulary.
 */
export type SimilarityClassification =
  | 'NO_NOTICE'
  | 'POTENTIAL_SIMILAR_ITEM'
  | 'STRONG_SIMILARITY';

export type ExistingItemSourceKind = 'closet' | 'recent_scan';

/**
 * Whether an authoritative identity signal was available AND agreed.
 *
 * `identifier_backed` means a product identifier or a canonical product URL
 * agreed on both sides. That is a statement about product identity made by a
 * retailer or a barcode, not an inference from appearance, so it needs less
 * corroboration than colour-and-shape agreement does. A DISAGREEING identifier
 * is not "attribute_only" — it is a structural veto handled separately in
 * `closetSimilarity.ts`, because no amount of attribute agreement should
 * overrule a barcode saying these are different products.
 */
export type EvidenceMode = 'identifier_backed' | 'attribute_only';

/**
 * How much there was to compare.
 *
 * Two agreements out of two comparable fields is much weaker evidence than two
 * agreements out of nine, and a flat cutoff cannot tell those apart. Coverage
 * is measured as "fields comparable on both sides / fields the engine knows how
 * to compare", and thin coverage raises the bar.
 */
export type MetadataCoverage = 'rich' | 'partial' | 'thin';

/** Whether the user will actually be able to look at the two items. */
export type ImageAvailability = 'both' | 'one_missing' | 'none' | 'poor_quality';

export type ThresholdProfile = {
  /**
   * Distinct positive evidence classes required before a notice is considered
   * at all. A structural gate, checked before any score is compared, so that a
   * single heavily-weighted signal cannot carry a notice on its own unless the
   * identifier path explicitly allows it.
   */
  minDistinctPositiveClasses: number;
  /**
   * At least one positive that is stronger than "same category".
   *
   * Without this, every coat matches every other coat. Category agreement is
   * real evidence but it is evidence about a wardrobe section, not an item.
   */
  requiresNonWeakPositive: boolean;
  /** Net score at or above which the notice is offered. */
  potentialAt: number;
  /** Net score at or above which the notice is emphasised. */
  strongAt: number;
};

/**
 * Category families, for the one adjustment that is about human intent rather
 * than about evidence quality.
 */
export type CategoryFamily =
  /**
   * Things people deliberately own several identical copies of: plain tees,
   * socks, underwear, base layers, uniforms, workwear. Here a correct detection
   * is still an unwanted notice — the user knows they own five black t-shirts
   * and does not need to be asked about the sixth. The bar goes up a lot.
   */
  | 'uniform_basic'
  /**
   * Things with strong, well-published identity where colourway is meaningful
   * and duplicates are unusual: sneakers, bags, watches, eyewear, outerwear.
   * Standard bar — the evidence means what it says.
   */
  | 'identity_strong'
  /** Everything else. */
  | 'general';

/**
 * Category slugs → family. Matched on normalized substrings, so canonical
 * category values like `t-shirt`, `tshirt`, `mens t shirt` all land correctly.
 *
 * Deliberately a short, reviewable list rather than a clever classifier. A
 * category we have not thought about gets `general`, which is the middle
 * bar — being wrong in the safe direction for an unlisted category.
 *
 * `footwear` and `outerwear` are listed explicitly (not just `shoe`/`coat`)
 * because those are the umbrella `canonicalCategory` values the scanner and
 * the query planner actually emit — see `queryPlanner.ts` `categoryRouteOf`.
 */
const UNIFORM_BASIC_TOKENS = [
  't-shirt', 'tshirt', 't shirt', 'tee', 'undershirt', 'vest top', 'tank',
  'sock', 'socks', 'underwear', 'brief', 'briefs', 'boxer', 'boxers',
  'bra', 'bralette', 'tights', 'stocking', 'hosiery', 'legging',
  'camisole', 'base layer', 'uniform', 'scrub', 'scrubs', 'apron',
  'polo shirt', 'dress shirt', 'oxford shirt', 'white shirt',
];

const IDENTITY_STRONG_TOKENS = [
  'footwear', 'sneaker', 'trainer', 'shoe', 'boot', 'heel', 'loafer', 'sandal',
  'handbag', 'bag', 'purse', 'backpack', 'tote', 'clutch',
  'watch', 'sunglass', 'eyewear', 'glasses',
  'outerwear', 'coat', 'jacket', 'parka', 'blazer', 'overcoat', 'trench',
];

export function categoryFamilyOf(canonicalCategory: unknown): CategoryFamily {
  if (typeof canonicalCategory !== 'string') return 'general';
  const text = canonicalCategory.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return 'general';
  // Uniform-basic is checked first: it is the adjustment that PREVENTS notices,
  // and a category matching both lists (e.g. "polo shirt jacket") should get the
  // quieter treatment rather than the louder one.
  if (UNIFORM_BASIC_TOKENS.some((token) => text.includes(token))) return 'uniform_basic';
  if (IDENTITY_STRONG_TOKENS.some((token) => text.includes(token))) return 'identity_strong';
  return 'general';
}

/**
 * Base profiles, by source × evidence mode.
 *
 * WHY CLOSET AND RECENT SCANS DIFFER
 *
 * A Closet item is a curated statement: the user chose to keep it, so a notice
 * against it is answering a question they plausibly care about ("do I already
 * have this?").
 *
 * Recent Scans is a log, not a collection. It contains rejected scans, retries,
 * and the same garment photographed three times from two angles while standing
 * in a shop. Prompting as eagerly there would produce a notice comparing a scan
 * to its own near-duplicate seconds earlier — technically correct and completely
 * useless. So Recent Scans requires MORE evidence, not less.
 *
 * WHY IDENTIFIER-BACKED AND ATTRIBUTE-ONLY DIFFER
 *
 * A shared product identifier or canonical product URL is a claim about product
 * identity from a source that knows — a retailer's catalogue or a barcode.
 * Attribute agreement is an inference from appearance, and appearance is shared
 * by every navy crew-neck jumper ever made. One agreement of the first kind is
 * worth several of the second, and the gates reflect that.
 */
const BASE_PROFILES: Record<
  ExistingItemSourceKind,
  Record<EvidenceMode, ThresholdProfile>
> = {
  closet: {
    identifier_backed: {
      // The identifier already answers "same product"; the second class only
      // guards against a stale or mis-scraped identifier on one side.
      minDistinctPositiveClasses: 2,
      requiresNonWeakPositive: true,
      potentialAt: 0.50,
      strongAt: 0.72,
    },
    attribute_only: {
      // Margin note: `productMatchOrchestration.test.ts`
      // "telemetry records a similar-item COUNT" fixes a 3-reason
      // (brand+colour+category) Closet comparison at net score 0.42, which
      // must admit. With partial-coverage's +0.05 that requires potentialAt
      // <= 0.37; 0.34 leaves a deliberate margin rather than sitting exactly
      // on the fixture's value.
      minDistinctPositiveClasses: 3,
      requiresNonWeakPositive: true,
      potentialAt: 0.34,
      strongAt: 0.60,
    },
  },
  recent_scan: {
    identifier_backed: {
      minDistinctPositiveClasses: 2,
      requiresNonWeakPositive: true,
      potentialAt: 0.58,
      strongAt: 0.78,
    },
    attribute_only: {
      // Margin note: `productMatchUserValue.test.ts`
      // "the source of the existing item is always reported" fixes a 4-reason
      // (brand+model+colour+category) Recent-Scans comparison at net score
      // 0.62, which must admit. With partial-coverage's +0.05 that requires
      // potentialAt <= 0.57; 0.46 leaves margin for the directional fixtures.
      minDistinctPositiveClasses: 4,
      requiresNonWeakPositive: true,
      potentialAt: 0.46,
      strongAt: 0.68,
    },
  },
};

/**
 * Category adjustment, applied to the resolved base profile.
 *
 * `uniform_basic` is the large one and the important one. Owning six identical
 * black t-shirts is a wardrobe strategy, not a mistake, and a system that
 * queries it every time is a system the user turns off. The extra required
 * class means a plain-basics notice needs brand AND model AND colour
 * agreement — i.e. it has to be a genuinely specific claim, not "this is also
 * a black tee".
 */
const CATEGORY_ADJUSTMENTS: Record<CategoryFamily, {
  distinctClassDelta: number;
  potentialDelta: number;
  strongDelta: number;
}> = {
  uniform_basic: { distinctClassDelta: 1, potentialDelta: 0.20, strongDelta: 0.10 },
  identity_strong: { distinctClassDelta: 0, potentialDelta: 0.00, strongDelta: 0.00 },
  general: { distinctClassDelta: 0, potentialDelta: 0.04, strongDelta: 0.02 },
};

/** Coverage bands. Comparable fields present on BOTH sides, out of 8. */
export const COVERAGE_RICH_MIN_FIELDS = 5;
export const COVERAGE_PARTIAL_MIN_FIELDS = 3;

export function coverageOf(comparableFieldCount: number): MetadataCoverage {
  if (comparableFieldCount >= COVERAGE_RICH_MIN_FIELDS) return 'rich';
  if (comparableFieldCount >= COVERAGE_PARTIAL_MIN_FIELDS) return 'partial';
  return 'thin';
}

/**
 * Metadata-coverage adjustment.
 *
 * With only two comparable fields, agreeing on both is nearly guaranteed for
 * anything in the same category — the agreement carries almost no information.
 * Raising the floor when coverage is thin is what stops an under-described scan
 * from matching everything.
 *
 * The distinct-class requirement is NOT raised for thin coverage: there may not
 * be enough fields to satisfy it, and an unsatisfiable gate is just a silent
 * "off" switch. The score floor does the work instead.
 */
const COVERAGE_ADJUSTMENTS: Record<MetadataCoverage, {
  potentialDelta: number;
  strongDelta: number;
}> = {
  rich: { potentialDelta: 0.00, strongDelta: 0.00 },
  partial: { potentialDelta: 0.05, strongDelta: 0.04 },
  thin: { potentialDelta: 0.14, strongDelta: 0.10 },
};

/**
 * Image-availability adjustment.
 *
 * The side-by-side photograph is the user's verification step: they look, and
 * they know. Without it we are asking them to accept a claim about two things
 * they cannot see, so the notice has to earn more before it appears — and it
 * is capped below `STRONG_SIMILARITY`, because emphasis without evidence the
 * user can check is exactly the overreach this feature is built to avoid.
 *
 * DEFAULT IS `both`. Availability is read from an explicit, caller-supplied
 * quality hint (`imageQuality` / `newScanImageQuality`), never inferred from
 * whether a display URI happens to be present — many legitimate calls (tests,
 * early wiring, a client that has not attached image preview yet) omit the
 * display URI without the underlying photo being missing. Treating absence as
 * "missing" would punish those calls for an unrelated wiring gap.
 */
const IMAGE_ADJUSTMENTS: Record<ImageAvailability, {
  potentialDelta: number;
  strongDelta: number;
  cap: SimilarityClassification;
}> = {
  both: { potentialDelta: 0.00, strongDelta: 0.00, cap: 'STRONG_SIMILARITY' },
  poor_quality: { potentialDelta: 0.06, strongDelta: 0.06, cap: 'STRONG_SIMILARITY' },
  one_missing: { potentialDelta: 0.10, strongDelta: 0.00, cap: 'POTENTIAL_SIMILAR_ITEM' },
  none: { potentialDelta: 0.16, strongDelta: 0.00, cap: 'POTENTIAL_SIMILAR_ITEM' },
};

export type ThresholdInputs = {
  source: ExistingItemSourceKind;
  evidenceMode: EvidenceMode;
  categoryFamily: CategoryFamily;
  coverage: MetadataCoverage;
  imageAvailability: ImageAvailability;
};

/** The profile actually used, plus what produced it. */
export type ResolvedThresholds = ThresholdProfile & {
  version: string;
  inputs: ThresholdInputs;
  maxClassification: SimilarityClassification;
  /**
   * Named adjustments that fired, in application order. Present so a notice can
   * be explained — "this needed 4 classes because it is Recent Scans and
   * attribute-only" — rather than reverse-engineered from a number.
   */
  adjustmentsApplied: string[];
};

/**
 * Optional numeric overrides, for calibration runs only.
 *
 * Read from the environment so a calibration pass can sweep the floors without
 * a code change, and deliberately NOT wired to anything that ships enabled:
 * `SCAN_SIMILAR_ITEM_FLAG_ENABLED` is false, so in production these are read and
 * then never used. An override that is present is reported in
 * `adjustmentsApplied`, so a fixture run under an override cannot be mistaken
 * for a run under the shipped defaults.
 */
export type ThresholdOverrides = {
  potentialAt?: number;
  strongAt?: number;
  minDistinctPositiveClasses?: number;
};

function readNumber(envGet: EnvGet, key: string): number | undefined {
  const raw = envGet(key)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function readThresholdOverrides(envGet: EnvGet = defaultEnvGet): ThresholdOverrides {
  return {
    potentialAt: readNumber(envGet, 'SIMILARITY_THRESHOLD_POTENTIAL_AT'),
    strongAt: readNumber(envGet, 'SIMILARITY_THRESHOLD_STRONG_AT'),
    minDistinctPositiveClasses: readNumber(envGet, 'SIMILARITY_THRESHOLD_MIN_CLASSES'),
  };
}

const CLASSIFICATION_RANK: Record<SimilarityClassification, number> = {
  NO_NOTICE: 0,
  POTENTIAL_SIMILAR_ITEM: 1,
  STRONG_SIMILARITY: 2,
};

/** Returns the weaker of two classifications. Used to apply caps. */
export function capClassification(
  value: SimilarityClassification,
  cap: SimilarityClassification,
): SimilarityClassification {
  return CLASSIFICATION_RANK[value] <= CLASSIFICATION_RANK[cap] ? value : cap;
}

/**
 * Resolves the profile for one comparison.
 *
 * Order matters and is fixed: base → category → coverage → image → overrides.
 * Category comes first because it encodes user intent, which no amount of
 * evidence quality should be able to argue away; the observability adjustments
 * then raise the bar further when we had less to look at.
 */
export function resolveThresholds(
  inputs: ThresholdInputs,
  overrides: ThresholdOverrides = {},
): ResolvedThresholds {
  const base = BASE_PROFILES[inputs.source][inputs.evidenceMode];
  const category = CATEGORY_ADJUSTMENTS[inputs.categoryFamily];
  const coverage = COVERAGE_ADJUSTMENTS[inputs.coverage];
  const image = IMAGE_ADJUSTMENTS[inputs.imageAvailability];

  const adjustmentsApplied: string[] = [
    `base:${inputs.source}/${inputs.evidenceMode}`,
  ];
  if (inputs.categoryFamily !== 'identity_strong') {
    adjustmentsApplied.push(`category:${inputs.categoryFamily}`);
  }
  if (inputs.coverage !== 'rich') adjustmentsApplied.push(`coverage:${inputs.coverage}`);
  if (inputs.imageAvailability !== 'both') adjustmentsApplied.push(`image:${inputs.imageAvailability}`);

  let minDistinctPositiveClasses = base.minDistinctPositiveClasses + category.distinctClassDelta;
  let potentialAt = base.potentialAt + category.potentialDelta + coverage.potentialDelta
    + image.potentialDelta;
  let strongAt = base.strongAt + category.strongDelta + coverage.strongDelta + image.strongDelta;

  if (typeof overrides.potentialAt === 'number') {
    potentialAt = overrides.potentialAt;
    adjustmentsApplied.push('override:potentialAt');
  }
  if (typeof overrides.strongAt === 'number') {
    strongAt = overrides.strongAt;
    adjustmentsApplied.push('override:strongAt');
  }
  if (typeof overrides.minDistinctPositiveClasses === 'number') {
    minDistinctPositiveClasses = overrides.minDistinctPositiveClasses;
    adjustmentsApplied.push('override:minDistinctPositiveClasses');
  }

  // `strongAt` below `potentialAt` would make STRONG reachable by scores that
  // do not qualify for POTENTIAL — an ordering inversion that would only ever
  // arrive via a bad override. Clamped rather than trusted.
  if (strongAt < potentialAt) strongAt = potentialAt;

  return {
    version: SIMILARITY_THRESHOLD_VERSION,
    inputs,
    adjustmentsApplied,
    minDistinctPositiveClasses,
    requiresNonWeakPositive: base.requiresNonWeakPositive,
    potentialAt: Number(potentialAt.toFixed(4)),
    strongAt: Number(strongAt.toFixed(4)),
    maxClassification: image.cap,
  };
}

/**
 * The full table, for the inspection surface and for documentation tests.
 *
 * Exported as data so a test can assert the shipped matrix rather than
 * re-implementing it, and so the dev inspector can print what the engine is
 * actually configured with instead of a hand-maintained copy.
 */
export const SIMILARITY_THRESHOLD_TABLE = {
  version: SIMILARITY_THRESHOLD_VERSION,
  base: BASE_PROFILES,
  category: CATEGORY_ADJUSTMENTS,
  coverage: COVERAGE_ADJUSTMENTS,
  image: IMAGE_ADJUSTMENTS,
} as const;
