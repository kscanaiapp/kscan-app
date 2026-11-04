/**
 * VRI-03 Visual Retrieval Intelligence — Scanner improvements (H1–H4b).
 *
 * Every export is inert unless its sub-flag is ON (resolved per request by
 * `_shared/vri03/scanImprovementsFlag.ts`: master × cohort × sub-flag, default
 * OFF). Callers keep the existing prompt/schema/query as the fallback and pass
 * flags explicitly, so flag-OFF behavior is byte-identical.
 *
 * Constraints honored by construction:
 *   - zero additional Gemini calls (H1/H2 only enrich the existing call);
 *   - only fields that already round-trip through the client allowlist are used
 *     (search_queries, distinctive_features, style_tags, length, closure,
 *     secondary_colors), so no mobile build is required;
 *   - at most ONE extra provider query (H3), only on thin results, only inside
 *     the existing fast-path deadline;
 *   - no product, merchant or ownership label is ever created here.
 */

// ── H1: identification instruction (appended; base prompts unchanged) ───────

export const VRI03_H1_VERSION = 'vri-03-h1-v1';

const SEARCHABLE_ATTRIBUTE_RULES = `
Fashion identification precision (VRI-03):
- Describe what a shopper would type to find this exact item: category, subtype (specific garment name), dominant and secondary colors, silhouette/shape, texture appearance (e.g. "ribbed", "quilted", "brushed"), pattern, and construction details (closures, pockets, hardware, stitching, hem, collar).
- Material: describe the APPEARANCE ("leather-look", "satin-finish", "chunky knit") unless a label is readable. Never state a fibre or composition you cannot see.
- Brand: only from a readable wordmark, tag or clearly identifiable logo on the item. If unsure, leave brand fields empty.
- distinctive_features: up to 6 short concrete noun phrases that separate this item from look-alikes. No marketing adjectives (luxury, designer, premium, inspired, dupe).
- search_queries: 2-3 concise retail search phrasings (3-7 words each), most specific first, using common shop vocabulary; include an alternate common name for the garment when one exists (e.g. "moto jacket" / "biker jacket"). Never include a brand that is not visibly confirmed.`;

export const VRI03_H1_SELECTED_ITEM_ADDENDUM = `${SEARCHABLE_ATTRIBUTE_RULES}
- Target selection: the selected candidate's bounds may overlap other items. Analyze the garment whose category matches the selected candidate and that fills most of the bounds; ignore anything only partly inside them.`;

export const VRI03_H1_SINGLE_ITEM_ADDENDUM = `${SEARCHABLE_ATTRIBUTE_RULES}
- Target selection: when several items are visible, choose the one that is most central and largest in frame; prefer a worn or held garment over background objects.`;

export const VRI03_H1_MULTI_ITEM_ADDENDUM = `

Target-selection precision (VRI-03):
- Each candidate must be one physical item with a tight box. Separate layered garments (e.g. jacket over shirt) only when both are clearly visible.
- Give each candidate the most specific subtype you can see (e.g. "cropped denim jacket", not "jacket").`;

export function withVri03Instruction(prompt: string, mode: 'selected_item' | 'legacy_single_item' | 'multi_item_detection', enabled: boolean): string {
  if (!enabled) return prompt;
  if (mode === 'selected_item') return `${prompt}\n${VRI03_H1_SELECTED_ITEM_ADDENDUM}`;
  if (mode === 'legacy_single_item') return `${prompt}\n${VRI03_H1_SINGLE_ITEM_ADDENDUM}`;
  return `${prompt}${VRI03_H1_MULTI_ITEM_ADDENDUM}`;
}

// ── H2: selected-item schema (additive, optional fields only) ───────────────

const VRI03_H2_IDENTIFICATION_PROPERTIES = {
  secondary_colors: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 3 },
  length: { type: 'STRING' },
  closure: { type: 'STRING' },
  distinctive_features: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 6 },
  style_tags: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 4 },
  search_queries: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 3 },
} as const;

type Schema = { properties: Record<string, unknown>; required: readonly string[] } & Record<string, unknown>;

/**
 * Add optional fields to the selected-item `identification` schema. Existing
 * properties (including any v124 definitions) win; `required` is unchanged, so
 * every response valid before stays valid.
 */
export function withVri03SelectedItemSchema<T extends Schema>(schema: T, enabled: boolean): T {
  if (!enabled) return schema;
  const identification = schema.properties.identification as Schema | undefined;
  if (!identification || typeof identification !== 'object') return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      identification: {
        ...identification,
        properties: { ...VRI03_H2_IDENTIFICATION_PROPERTIES, ...identification.properties },
        required: [...identification.required],
      },
    },
    required: [...schema.required],
  } as T;
}

// ── H3: query preservation, synonyms, bounded fallback ──────────────────────

const MAX_PRESERVED_QUERIES = 2;
const MAX_QUERY_WORDS = 8;
const QUERY_NOISE_RE = /\b(luxury|designer|inspired|dupe|replica|knock-?off|premium|aesthetic|vibes?)\b/i;

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Gemini's own search phrasings, kept AFTER the quality label instead of being
 * overwritten. A phrasing naming any brand the gate did not verify is dropped,
 * so preservation can never reintroduce a suppressed brand.
 */
export function preserveModelSearchQueries(
  original: unknown,
  label: string,
  blockedBrandTerms: readonly string[],
): string[] {
  if (!Array.isArray(original)) return [];
  const labelKey = collapse(label).toLowerCase();
  const blocked = blockedBrandTerms
    .map((t) => collapse(t))
    .filter((t) => t.length >= 2)
    .map((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t.toLowerCase())}([^a-z0-9]|$)`, 'i'));
  const out: string[] = [];
  const seen = new Set<string>([labelKey]);
  for (const raw of original) {
    if (out.length >= MAX_PRESERVED_QUERIES) break;
    if (typeof raw !== 'string') continue;
    const q = collapse(raw).toLowerCase();
    const words = q.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > MAX_QUERY_WORDS || q.length > 120) continue;
    if (QUERY_NOISE_RE.test(q)) continue;
    if (blocked.some((re) => re.test(q))) continue;
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}

/** Bidirectional garment-name synonyms: [variant, canonical shop term]. */
export const VRI03_GARMENT_SYNONYMS: readonly (readonly [string, string])[] = Object.freeze([
  ['moto jacket', 'biker jacket'],
  ['biker jacket', 'moto jacket'],
  ['trainers', 'sneakers'],
  ['trainer', 'sneaker'],
  ['sneakers', 'trainers'],
  ['jumper', 'sweater'],
  ['pullover', 'sweater'],
  ['trousers', 'pants'],
  ['slacks', 'pants'],
  ['puffer jacket', 'down jacket'],
  ['shacket', 'shirt jacket'],
  ['shirt jacket', 'shacket'],
  ['tee', 't-shirt'],
  ['crossbody bag', 'shoulder bag'],
  ['purse', 'handbag'],
  ['flip flops', 'thong sandals'],
  ['hoody', 'hoodie'],
  ['cardi', 'cardigan'],
]);

/** One deterministic synonym rewrite of a query, or '' when none applies. */
export function synonymVariantQuery(query: string): string {
  const q = ` ${collapse(query).toLowerCase()} `;
  for (const [from, to] of VRI03_GARMENT_SYNONYMS) {
    const needle = ` ${from} `;
    if (q.includes(needle) && !q.includes(` ${to} `)) return collapse(q.replace(needle, ` ${to} `));
  }
  return '';
}

export type Vri03FallbackChoice = { query: string; source: 'model_query' | 'synonym' | 'computed_fallback' } | null;

/**
 * Pick the single fallback query for a thin result set. Order: Gemini's own
 * phrasing (already brand-filtered), then a synonym rewrite of the primary,
 * then the v122 computed fallback. Never the primary itself, never a weak query.
 */
export function chooseVri03FallbackQuery(opts: {
  primary: string;
  searchQueries: readonly unknown[] | undefined;
  computedFallback: string;
  isWeak: (q: string) => boolean;
}): Vri03FallbackChoice {
  const primaryKey = collapse(opts.primary).toLowerCase();
  const usable = (q: string) => {
    const k = collapse(q).toLowerCase();
    return !!k && k !== primaryKey && !opts.isWeak(k);
  };
  // search_queries[0] is the gate's own label (≈ the primary). Model phrasings follow it.
  const model = (opts.searchQueries ?? []).slice(1).filter((x): x is string => typeof x === 'string').find(usable);
  if (model) return { query: collapse(model).toLowerCase(), source: 'model_query' };
  const syn = synonymVariantQuery(opts.primary);
  if (syn && usable(syn)) return { query: syn, source: 'synonym' };
  if (opts.computedFallback && usable(opts.computedFallback)) return { query: collapse(opts.computedFallback), source: 'computed_fallback' };
  return null;
}

/** Fast path: minimum remaining deadline before the single fallback may run. */
export const VRI03_MIN_FALLBACK_BUDGET_MS = 700;

export type Vri03CommerceFlags = { h3: boolean; h4: boolean };

export function vri03CacheSuffix(flags: Vri03CommerceFlags | undefined): string {
  if (!flags || (!flags.h3 && !flags.h4)) return '';
  return `|vri03:${flags.h3 ? 1 : 0}${flags.h4 ? 1 : 0}`;
}

// ── H4b: Black-owned subtype matching (relevance only) ──────────────────────

/**
 * Synonym variants of catalog subtype match keys (singular token form, as the
 * Black-owned validator produces them). Relevance only: eligibility,
 * verification and ownership rules are untouched by construction.
 */
const SUBTYPE_TOKEN_SYNONYMS: Readonly<Record<string, string>> = Object.freeze({
  moto: 'biker', biker: 'moto', trainer: 'sneaker', sneaker: 'trainer', jumper: 'sweater', pullover: 'sweater',
  trouser: 'pant', slack: 'pant', hoody: 'hoodie', shacket: 'shirt jacket', purse: 'handbag', cardi: 'cardigan',
});

export const VRI03_MAX_SUBTYPE_KEYS = 6;

export function vri03SynonymSubtypeKeys(baseKeys: readonly string[]): string[] {
  const out = [...baseKeys];
  // Head phrases first ("moto jacket" before "black leather moto jacket"):
  // catalog subtypes are usually short, so their variants matter most.
  for (const key of [...baseKeys].reverse()) {
    const tokens = key.split(' ');
    tokens.forEach((t, i) => {
      const syn = SUBTYPE_TOKEN_SYNONYMS[t];
      if (!syn) return;
      const variant = [...tokens.slice(0, i), syn, ...tokens.slice(i + 1)].join(' ');
      if (!out.includes(variant)) out.push(variant);
    });
  }
  return out.slice(0, VRI03_MAX_SUBTYPE_KEYS);
}
