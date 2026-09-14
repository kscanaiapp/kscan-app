/**
 * Structured shopping intent (Contextual Commerce, Build 35).
 *
 * WHAT THIS IS. One narrow, request-scoped description of what the user
 * actually needs, assembled from the context K Scan already holds. It is the
 * input the existing Commerce ranking authority was missing: before this,
 * `scoreProductAgreement` could see the garment and nothing else, so an
 * explicit "under $100", a rejected material, a confirmed Packing gap and an
 * already-owned near-duplicate were all invisible at ranking time.
 *
 * WHAT THIS IS NOT. Not a second scorer, not a catalogue, not a durable store.
 * Nothing here retrieves, scores or orders a product; it only says what the
 * request is. Ranking stays in `qualityTuneCommerce.filterAndDedupeProducts` ->
 * `commerceRelevanceAgreement.scoreProductAgreement`, which remains the single
 * ranking authority.
 *
 * PROVENANCE IS PART OF THE VALUE. Every field records where it came from,
 * because the precedence rules depend on it:
 *
 *   - COMMERCIAL_FACT is what the provider said. A user preference cannot
 *     overwrite it: wanting an item to be in stock does not stock it.
 *   - USER_EXPLICIT is what the user said in words. It outranks everything
 *     inferred, and a LATER explicit instruction outranks an earlier one --
 *     "actually, make it red" is allowed to change "black".
 *   - PACKING / CONCIERGE / SCANNER are evidenced context from another K Scan
 *     surface.
 *   - CLOSET / SIGNATURE_STYLE are preference signals, never constraints.
 *   - DERIVED is this module's own bounded normalization of the above.
 *
 * UNKNOWN STAYS UNKNOWN. A field is present only when something actually said
 * it. Nothing here defaults a currency, a budget, an occasion or a formality,
 * and nothing infers one attribute from another.
 */

import { normalizeCurrencyCode } from './offerCurrency.ts';

export const SHOPPING_INTENT_CONTRACT_VERSION = 1;

/** Where one intent field came from. Ordered loosely weakest-first. */
export type IntentProvenance =
  | 'DERIVED'
  | 'SIGNATURE_STYLE'
  | 'CLOSET'
  | 'SCANNER'
  | 'CONCIERGE'
  | 'PACKING'
  | 'USER_EXPLICIT'
  | 'COMMERCIAL_FACT';

/**
 * Precedence rank. Higher wins. Two fields at the SAME rank are resolved by
 * arrival order (later wins), which is what makes a later explicit instruction
 * able to replace an earlier one.
 */
const PROVENANCE_RANK: Readonly<Record<IntentProvenance, number>> = {
  DERIVED: 1,
  SIGNATURE_STYLE: 2,
  CLOSET: 3,
  SCANNER: 4,
  CONCIERGE: 5,
  PACKING: 6,
  USER_EXPLICIT: 7,
  COMMERCIAL_FACT: 8,
};

/**
 * How hard the customer asked for an attribute.
 *
 * TWO TIERS, AND THE ASYMMETRY IS THE POINT. "black shoes" and "only black"
 * are both positive requests: neither one deletes the rest of the market. What
 * separates them is how far a matching candidate rises, never how far a
 * non-matching one is pushed down -- a stronger ask elevates, it does not
 * suppress.
 *
 * An absent, unknown or malformed strength degrades to EXPLICIT_PREFERENCE.
 * Degrading to STRONG would let a malformed payload buy extra ranking weight,
 * and degrading to "no preference" would silently discard something the
 * customer actually said.
 */
export type AttributeStrength = 'EXPLICIT_PREFERENCE' | 'STRONG_EXPLICIT_PREFERENCE';

export const ATTRIBUTE_STRENGTHS: readonly AttributeStrength[] = [
  'EXPLICIT_PREFERENCE',
  'STRONG_EXPLICIT_PREFERENCE',
];

/** Total, and never throws: anything unrecognised is ordinary preference. */
export function normalizeAttributeStrength(raw: unknown): AttributeStrength {
  return raw === 'STRONG_EXPLICIT_PREFERENCE' ? 'STRONG_EXPLICIT_PREFERENCE' : 'EXPLICIT_PREFERENCE';
}

export interface IntentField<T> {
  value: T;
  provenance: IntentProvenance;
  /**
   * Only meaningful on a USER_EXPLICIT field. A derived or scanned value is
   * not something the customer asked for, so it carries no strength.
   */
  strength?: AttributeStrength;
}

export interface BudgetCeiling {
  amount: number;
  /** ISO-4217, and only ever one the user actually stated. Never defaulted. */
  currency: string;
}

/** A material/colour/attribute the user rejected. Case-folded, bounded. */
export interface IntentExclusion {
  /** What kind of thing is excluded -- keeps "red" and "leather" apart. */
  axis: 'material' | 'color' | 'attribute';
  token: string;
  provenance: IntentProvenance;
}

/** One owned item close enough to this request to matter for duplication. */
export interface OwnedReference {
  /** Free-text descriptor drawn from the Closet. Never a product id. */
  descriptor: string;
  category: string | null;
  color: string | null;
  material: string | null;
}

/** The gap this request answers, and how sure Packing was about it. */
export interface GapRelationship {
  gapCode: string;
  /** Packing's own word. Commerce reads it; Commerce never sets it. */
  certainty: 'confirmed' | 'unconfirmed';
  label: string;
}

export interface ShoppingIntent {
  contractVersion: typeof SHOPPING_INTENT_CONTRACT_VERSION;
  /**
   * The actor this context belongs to. Context whose actor does not match the
   * live request actor is discarded wholesale -- see `intentMatchesActor`.
   */
  actorId: string | null;

  category?: IntentField<string>;
  subtype?: IntentField<string>;
  color?: IntentField<string>;
  material?: IntentField<string>;
  silhouette?: IntentField<string>;
  pattern?: IntentField<string>;
  occasion?: IntentField<string>;
  formality?: IntentField<string>;

  /** e.g. waterproof, packable, warm. Only when something stated it. */
  functionalRequirements: IntentField<string>[];
  /** Hard constraint. Only ever set from an explicit user statement. */
  budgetCeiling?: IntentField<BudgetCeiling>;
  exclusions: IntentExclusion[];
  /** Owned pieces near this request. Drives duplication risk, never ownership. */
  relevantOwned: OwnedReference[];
  /** Whether the user wants the same item or something like it. */
  matchIntent?: IntentField<'exact' | 'substitute'>;
  gapRelationship?: IntentField<GapRelationship>;
  /** Preference-only style signal. Never a constraint. */
  signatureStyleTokens: string[];
}

/** An empty, actor-bound intent. Every field absent: nothing is assumed. */
export function emptyShoppingIntent(actorId: string | null = null): ShoppingIntent {
  return {
    contractVersion: SHOPPING_INTENT_CONTRACT_VERSION,
    actorId,
    functionalRequirements: [],
    exclusions: [],
    relevantOwned: [],
    signatureStyleTokens: [],
  };
}

/**
 * True when the intent carries something a ranker could actually use.
 *
 * This is the zero-context fast path's test. An intent that names nothing is
 * not "a bit of context" -- it is no context, and assembling or scoring it
 * would add latency to a request that cannot benefit from it.
 */
export function hasUsableContext(intent: ShoppingIntent | null | undefined): boolean {
  if (!intent) return false;
  return Boolean(
    intent.budgetCeiling ||
      intent.exclusions.length ||
      intent.functionalRequirements.length ||
      intent.relevantOwned.length ||
      intent.signatureStyleTokens.length ||
      intent.gapRelationship ||
      intent.occasion ||
      intent.formality ||
      // Scanner-derived attributes alone are NOT context: the existing scorer
      // already reads those off the identification. Only an attribute that
      // OUTRANKS the scan (an explicit correction) counts here.
      hasExplicitAttribute(intent),
  );
}

function hasExplicitAttribute(intent: ShoppingIntent): boolean {
  const fields = [intent.category, intent.subtype, intent.color, intent.material, intent.silhouette, intent.pattern];
  return fields.some((f) => f && f.provenance === 'USER_EXPLICIT');
}

/**
 * Cross-actor firewall. Context assembled for one account can never be applied
 * to another's request; the caller discards the whole intent rather than
 * filtering it field by field, because a partially-retained foreign context is
 * still foreign.
 */
export function intentMatchesActor(
  intent: ShoppingIntent | null | undefined,
  requestActorId: string | null,
): boolean {
  if (!intent) return false;
  // An intent with no actor is safe here because `buildShoppingIntent` already
  // refused every contribution that CLAIMED an actor this request is not --
  // including when the request itself is anonymous. So a null-actor intent
  // contains only untagged context, which belongs to whoever is asking.
  if (intent.actorId === null) return true;
  return intent.actorId === requestActorId;
}

// ── Assembly ────────────────────────────────────────────────────────────────

function collapse(value: unknown, max = 60): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Set one scalar field, honouring precedence.
 *
 * A COMMERCIAL_FACT already in place is never replaced -- that is the rule
 * that stops "I want it cheaper" from rewriting what the retailer charges.
 * Otherwise a strictly higher rank wins, and an EQUAL rank wins too, which is
 * how a later explicit instruction supersedes an earlier explicit one.
 */
function setField<T>(
  current: IntentField<T> | undefined,
  value: T,
  provenance: IntentProvenance,
  strength?: AttributeStrength,
): IntentField<T> | undefined {
  if (current && current.provenance === 'COMMERCIAL_FACT' && provenance !== 'COMMERCIAL_FACT') {
    return current;
  }
  if (current && PROVENANCE_RANK[provenance] < PROVENANCE_RANK[current.provenance]) {
    return current;
  }
  // Strength belongs to the customer's own instruction. A field that arrives
  // from anywhere else carries none, so a later PACKING or SCANNER write of the
  // same axis cannot inherit the emphasis of an earlier explicit one.
  return provenance === 'USER_EXPLICIT' && strength
    ? { value, provenance, strength }
    : { value, provenance };
}

export interface IntentContribution {
  provenance: IntentProvenance;
  actorId?: string | null;
  category?: string;
  subtype?: string;
  color?: string;
  /**
   * How hard the customer asked for `color`. Read only alongside a
   * USER_EXPLICIT contribution; anything unrecognised degrades to ordinary.
   */
  colorStrength?: unknown;
  material?: string;
  silhouette?: string;
  pattern?: string;
  occasion?: string;
  formality?: string;
  functionalRequirements?: string[];
  budgetCeiling?: { amount: unknown; currency: unknown };
  exclusions?: Array<{ axis: IntentExclusion['axis']; token: string }>;
  relevantOwned?: OwnedReference[];
  matchIntent?: 'exact' | 'substitute';
  gapRelationship?: GapRelationship;
  signatureStyleTokens?: string[];
}

const MAX_LIST = 6;

/**
 * Fold an ordered list of contributions into one intent.
 *
 * Order is meaningful: contributions are applied in the order given, so a
 * later USER_EXPLICIT correction replaces an earlier USER_EXPLICIT statement.
 * Callers therefore pass conversation turns oldest-first.
 */
export function buildShoppingIntent(
  contributions: readonly IntentContribution[],
  actorId: string | null = null,
): ShoppingIntent {
  const intent = emptyShoppingIntent(actorId);

  for (const c of contributions ?? []) {
    if (!c || typeof c !== 'object') continue;
    const p = c.provenance;
    if (!PROVENANCE_RANK[p]) continue;

    // CROSS-ACTOR FIREWALL, at the point of assembly.
    //
    // A contribution that names an actor is actor-bound evidence (a Closet, a
    // Signature Style). If it names a DIFFERENT actor than this request's, it
    // is discarded entirely rather than merged — merging it and relying on a
    // later check would already have stamped one account's wardrobe with
    // another account's id.
    // Note the deliberate absence of an `actorId !== null` guard: a
    // contribution TAGGED for actor B is foreign to an anonymous request too,
    // and admitting it there would make "no signed-in user" the one context in
    // which another account's wardrobe leaks through.
    if (typeof c.actorId === 'string' && c.actorId && c.actorId !== actorId) {
      continue;
    }

    const cat = collapse(c.category);
    if (cat) intent.category = setField(intent.category, cat.toLowerCase(), p);
    const sub = collapse(c.subtype);
    if (sub) intent.subtype = setField(intent.subtype, sub.toLowerCase(), p);
    const col = collapse(c.color);
    if (col) {
      intent.color = setField(intent.color, col.toLowerCase(), p, normalizeAttributeStrength(c.colorStrength));
    }
    const mat = collapse(c.material);
    if (mat) intent.material = setField(intent.material, mat.toLowerCase(), p);
    const sil = collapse(c.silhouette);
    if (sil) intent.silhouette = setField(intent.silhouette, sil.toLowerCase(), p);
    const pat = collapse(c.pattern);
    if (pat) intent.pattern = setField(intent.pattern, pat.toLowerCase(), p);
    const occ = collapse(c.occasion);
    if (occ) intent.occasion = setField(intent.occasion, occ.toLowerCase(), p);
    const form = collapse(c.formality);
    if (form) intent.formality = setField(intent.formality, form.toLowerCase(), p);

    if (c.matchIntent === 'exact' || c.matchIntent === 'substitute') {
      intent.matchIntent = setField(intent.matchIntent, c.matchIntent, p);
    }

    // A budget ceiling is a HARD constraint, so it is accepted only from an
    // explicit user statement and only with a currency the user actually
    // named. A ceiling with no currency cannot be compared to an offer
    // truthfully, so it is not a ceiling -- it is dropped.
    if (c.budgetCeiling && p === 'USER_EXPLICIT') {
      const amount = typeof c.budgetCeiling.amount === 'number'
        ? c.budgetCeiling.amount
        : Number.parseFloat(String(c.budgetCeiling.amount ?? ''));
      const currency = normalizeCurrencyCode(c.budgetCeiling.currency);
      if (Number.isFinite(amount) && amount > 0 && currency) {
        intent.budgetCeiling = setField(intent.budgetCeiling, { amount, currency }, p);
      }
    }

    for (const raw of c.functionalRequirements ?? []) {
      const token = collapse(raw, 32).toLowerCase();
      if (!token) continue;
      if (intent.functionalRequirements.some((f) => f.value === token)) continue;
      if (intent.functionalRequirements.length >= MAX_LIST) break;
      intent.functionalRequirements.push({ value: token, provenance: p });
    }

    for (const raw of c.exclusions ?? []) {
      const token = collapse(raw?.token, 32).toLowerCase();
      const axis = raw?.axis;
      if (!token || (axis !== 'material' && axis !== 'color' && axis !== 'attribute')) continue;
      if (intent.exclusions.some((e) => e.token === token && e.axis === axis)) continue;
      if (intent.exclusions.length >= MAX_LIST) break;
      intent.exclusions.push({ axis, token, provenance: p });
    }

    for (const owned of c.relevantOwned ?? []) {
      if (!owned || typeof owned !== 'object') continue;
      const descriptor = collapse(owned.descriptor, 80);
      if (!descriptor) continue;
      if (intent.relevantOwned.length >= MAX_LIST) break;
      intent.relevantOwned.push({
        descriptor: descriptor.toLowerCase(),
        category: collapse(owned.category).toLowerCase() || null,
        color: collapse(owned.color).toLowerCase() || null,
        material: collapse(owned.material).toLowerCase() || null,
      });
    }

    for (const raw of c.signatureStyleTokens ?? []) {
      const token = collapse(raw, 32).toLowerCase();
      if (!token || intent.signatureStyleTokens.includes(token)) continue;
      if (intent.signatureStyleTokens.length >= MAX_LIST) break;
      intent.signatureStyleTokens.push(token);
    }

    // A gap relationship is Packing's claim about the Closet. Commerce copies
    // it verbatim, certainty included, and never upgrades it.
    if (c.gapRelationship && (p === 'PACKING' || p === 'CONCIERGE')) {
      const code = collapse(c.gapRelationship.gapCode, 60);
      const label = collapse(c.gapRelationship.label, 80);
      const certainty = c.gapRelationship.certainty;
      if (code && label && (certainty === 'confirmed' || certainty === 'unconfirmed')) {
        intent.gapRelationship = setField(intent.gapRelationship, { gapCode: code, label, certainty }, p);
      }
    }

    if (typeof c.actorId === 'string' && c.actorId && intent.actorId === null) {
      intent.actorId = c.actorId;
    }
  }

  // An explicit instruction that contradicts an earlier explicit attribute has
  // already replaced it above. What it must ALSO do is stop the replaced value
  // from surviving as a preference: "in red instead" means black is no longer
  // wanted, not that red is merely preferred over it.
  return intent;
}

// ── Deterministic extraction from explicit user text ────────────────────────
//
// The same doctrine `eliseAdviceIntents.ts` already uses for intent detection:
// deterministic phrase signals, no model call. This exists so a conversational
// shopping request ("same idea, under $100") can reach ranking WITHOUT adding
// a production LLM round trip. Anything these patterns cannot prove is simply
// not extracted -- an unparsed sentence yields an empty contribution, never a
// guess.

const MATERIAL_TOKENS = [
  'leather', 'suede', 'denim', 'wool', 'cotton', 'silk', 'satin', 'linen',
  'cashmere', 'nylon', 'polyester', 'fur', 'velvet',
] as const;

const COLOR_TOKENS = [
  'black', 'white', 'red', 'blue', 'navy', 'green', 'brown', 'pink', 'grey',
  'gray', 'beige', 'cream', 'tan', 'burgundy', 'olive', 'yellow', 'purple', 'orange',
] as const;

const FUNCTIONAL_TOKENS: ReadonlyArray<{ token: string; patterns: RegExp[] }> = [
  { token: 'waterproof', patterns: [/\b(waterproof|water-resistant|rainproof|for the rain|rain jacket)\b/i] },
  { token: 'packable', patterns: [/\b(packable|foldable|lightweight for travel)\b/i] },
  { token: 'warm', patterns: [/\b(warm|insulated|thermal|for the cold)\b/i] },
  { token: 'breathable', patterns: [/\bbreathable\b/i] },
];

/** `$100`, `100 usd`, `under 100 dollars`, `£80`, `€80`. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { '$': 'USD', '£': 'GBP', '€': 'EUR' };

const BUDGET_PATTERNS: RegExp[] = [
  /\b(?:under|below|less than|no more than|max(?:imum)?|up to|within)\s*([$£€])\s?(\d[\d,]*(?:\.\d{1,2})?)/i,
  /\b(?:under|below|less than|no more than|max(?:imum)?|up to|within)\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(usd|gbp|eur|dollars?|pounds?|euros?)\b/i,
];

const WORD_CURRENCY: Readonly<Record<string, string>> = {
  usd: 'USD', dollar: 'USD', dollars: 'USD',
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP',
  eur: 'EUR', euro: 'EUR', euros: 'EUR',
};

const EXCLUSION_PATTERNS: RegExp[] = [
  /\b(?:not|no|without|avoid|skip|except|excluding)\s+([a-z-]{3,20})\b/gi,
  /\b(?:nothing|none)\s+(?:in\s+)?([a-z-]{3,20})\b/gi,
  /\b(?:don'?t|do not)\s+(?:want|like|show)\s+(?:me\s+)?(?:any\s+)?([a-z-]{3,20})\b/gi,
];

const COLOR_OVERRIDE_PATTERNS: RegExp[] = [
  /\bin\s+([a-z]{3,12})\s+instead\b/i,
  /\b(?:make it|but in|same but)\s+([a-z]{3,12})\b/i,
  /\b([a-z]{3,12})\s+(?:one|version)\s+instead\b/i,
];

const SUBSTITUTE_PATTERNS: RegExp[] = [
  /\b(?:something like|similar to|same idea|alternatives?|instead of|different)\b/i,
  /\b(?:like this but|in the style of)\b/i,
];

const EXACT_PATTERNS: RegExp[] = [
  /\b(?:this exact|the exact|exactly this|find this one|same one)\b/i,
];

/**
 * Extract a bounded, explicit contribution from one user utterance.
 *
 * Returns a USER_EXPLICIT contribution carrying only what the text actually
 * said. Deterministic and total: the same sentence always yields the same
 * fields, and an unrecognised sentence yields an empty contribution.
 */
export function extractExplicitContribution(text: unknown): IntentContribution {
  const contribution: IntentContribution = { provenance: 'USER_EXPLICIT' };
  if (typeof text !== 'string') return contribution;
  const raw = text.slice(0, 600);
  if (!raw.trim()) return contribution;
  const lower = raw.toLowerCase();

  for (const pattern of BUDGET_PATTERNS) {
    const m = raw.match(pattern);
    if (!m) continue;
    if (CURRENCY_SYMBOLS[m[1]]) {
      contribution.budgetCeiling = {
        amount: Number.parseFloat(m[2].replace(/,/g, '')),
        currency: CURRENCY_SYMBOLS[m[1]],
      };
    } else {
      const code = WORD_CURRENCY[m[2]?.toLowerCase() ?? ''];
      if (code) {
        contribution.budgetCeiling = { amount: Number.parseFloat(m[1].replace(/,/g, '')), currency: code };
      }
    }
    if (contribution.budgetCeiling) break;
  }

  const exclusions: IntentContribution['exclusions'] = [];
  for (const pattern of EXCLUSION_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(lower)) !== null) {
      const token = m[1];
      if (!token) continue;
      if ((MATERIAL_TOKENS as readonly string[]).includes(token)) {
        exclusions.push({ axis: 'material', token });
      } else if ((COLOR_TOKENS as readonly string[]).includes(token)) {
        exclusions.push({ axis: 'color', token });
      }
      if (!pattern.global) break;
    }
  }
  if (exclusions.length) contribution.exclusions = exclusions;

  for (const pattern of COLOR_OVERRIDE_PATTERNS) {
    const m = lower.match(pattern);
    const token = m?.[1];
    if (token && (COLOR_TOKENS as readonly string[]).includes(token)) {
      contribution.color = token;
      break;
    }
  }

  const functional: string[] = [];
  for (const entry of FUNCTIONAL_TOKENS) {
    if (entry.patterns.some((p) => p.test(raw))) functional.push(entry.token);
  }
  if (functional.length) contribution.functionalRequirements = functional;

  if (EXACT_PATTERNS.some((p) => p.test(raw))) contribution.matchIntent = 'exact';
  else if (SUBSTITUTE_PATTERNS.some((p) => p.test(raw))) contribution.matchIntent = 'substitute';

  return contribution;
}

// ── Untrusted-input parsing ─────────────────────────────────────────────────

const ALLOWED_CLIENT_PROVENANCE: ReadonlySet<string> = new Set([
  'USER_EXPLICIT', 'PACKING', 'CONCIERGE', 'SCANNER', 'CLOSET', 'SIGNATURE_STYLE', 'DERIVED',
]);

const MAX_CONTRIBUTIONS = 8;

function boundedStrings(raw: unknown, max: number, len: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    const value = collapse(entry, len);
    if (!value) continue;
    out.push(value);
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}

/**
 * Parse contributions arriving from the CLIENT.
 *
 * Everything here is untrusted input, so the shape is rebuilt field by field
 * rather than spread: an allowlisted provenance, bounded strings, bounded
 * lists, and no pass-through of unknown keys.
 *
 * COMMERCIAL_FACT is deliberately NOT in the allowlist. A client claiming a
 * provider fact would be claiming the highest precedence rank in the system,
 * which is exactly the escalation the provenance model exists to prevent —
 * only a provider response reaches that rank, and it does not come from here.
 */
export function parseContextContributions(raw: unknown): IntentContribution[] {
  if (!Array.isArray(raw)) return [];
  const out: IntentContribution[] = [];

  for (const entry of raw) {
    if (out.length >= MAX_CONTRIBUTIONS) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const provenance = typeof rec.provenance === 'string' ? rec.provenance : '';
    if (!ALLOWED_CLIENT_PROVENANCE.has(provenance)) continue;

    const contribution: IntentContribution = { provenance: provenance as IntentProvenance };

    for (const key of ['category', 'subtype', 'color', 'material', 'silhouette', 'pattern', 'occasion', 'formality'] as const) {
      const value = collapse(rec[key]);
      if (value) contribution[key] = value;
    }
    // Normalised here rather than passed through: the enum is closed, and an
    // unrecognised value must become ordinary preference before it can be
    // stored, not merely before it is scored.
    //
    // USER_EXPLICIT only. Strength describes how hard the CUSTOMER asked, so a
    // Closet, Packing or Signature Style contribution carries none and keeps
    // exactly the key set it had before this field existed.
    if (contribution.color && provenance === 'USER_EXPLICIT') {
      contribution.colorStrength = normalizeAttributeStrength(rec.colorStrength);
    }
    if (typeof rec.actorId === 'string' && rec.actorId.trim()) {
      contribution.actorId = rec.actorId.trim().slice(0, 80);
    }
    if (rec.matchIntent === 'exact' || rec.matchIntent === 'substitute') {
      contribution.matchIntent = rec.matchIntent;
    }

    const functional = boundedStrings(rec.functionalRequirements, MAX_LIST, 32);
    if (functional) contribution.functionalRequirements = functional;

    const signature = boundedStrings(rec.signatureStyleTokens, MAX_LIST, 32);
    if (signature) contribution.signatureStyleTokens = signature;

    if (rec.budgetCeiling && typeof rec.budgetCeiling === 'object') {
      const b = rec.budgetCeiling as Record<string, unknown>;
      contribution.budgetCeiling = { amount: b.amount, currency: b.currency };
    }

    if (Array.isArray(rec.exclusions)) {
      const exclusions: NonNullable<IntentContribution['exclusions']> = [];
      for (const e of rec.exclusions) {
        if (!e || typeof e !== 'object') continue;
        const axis = (e as Record<string, unknown>).axis;
        const token = collapse((e as Record<string, unknown>).token, 32);
        if (!token) continue;
        if (axis !== 'material' && axis !== 'color' && axis !== 'attribute') continue;
        exclusions.push({ axis, token });
        if (exclusions.length >= MAX_LIST) break;
      }
      if (exclusions.length) contribution.exclusions = exclusions;
    }

    if (Array.isArray(rec.relevantOwned)) {
      const owned: OwnedReference[] = [];
      for (const o of rec.relevantOwned) {
        if (!o || typeof o !== 'object') continue;
        const r = o as Record<string, unknown>;
        const descriptor = collapse(r.descriptor, 80);
        if (!descriptor) continue;
        owned.push({
          descriptor,
          category: collapse(r.category) || null,
          color: collapse(r.color) || null,
          material: collapse(r.material) || null,
        });
        if (owned.length >= MAX_LIST) break;
      }
      if (owned.length) contribution.relevantOwned = owned;
    }

    // A gap relationship is accepted only from the surfaces that own gaps, and
    // only with a certainty they actually stated. A client cannot mint
    // `confirmed` for a gap Packing hedged: an unrecognised certainty drops the
    // whole gap rather than defaulting to the stronger value.
    if ((provenance === 'PACKING' || provenance === 'CONCIERGE') && rec.gapRelationship && typeof rec.gapRelationship === 'object') {
      const g = rec.gapRelationship as Record<string, unknown>;
      const gapCode = collapse(g.gapCode, 60);
      const label = collapse(g.label, 80);
      const certainty = g.certainty;
      if (gapCode && label && (certainty === 'confirmed' || certainty === 'unconfirmed')) {
        contribution.gapRelationship = { gapCode, label, certainty };
      }
    }

    out.push(contribution);
  }

  return out;
}

/**
 * A stable fingerprint of everything in an intent that can change WHICH
 * candidates survive or how they order.
 *
 * Used as a commerce-cache discriminator (Build 36 activation): a cache hit
 * returns a stored shelf without re-running the contextual filter, so two
 * requests may share a cache entry only when their constraints agree.
 *
 * Deliberately covers the ranking-relevant fields rather than the whole
 * object: `contractVersion` and `actorId` are not ranking inputs (the actor is
 * enforced separately, and mixing it in would fragment the cache per user for
 * no correctness gain). Field order is fixed, and lists are sorted, so the
 * same intent always produces the same string.
 *
 * Returns '' for an intent that constrains nothing — which keeps the cache key
 * byte-identical to the pre-activation build for every zero-context caller.
 */
export function shoppingIntentFingerprint(intent: ShoppingIntent | null | undefined): string {
  if (!intent) return '';
  const parts: string[] = [];
  // STRENGTH IS PART OF THE KEY. It changes ranking, and a cache hit returns a
  // stored shelf without re-ranking, so "black boots" and "only black" must not
  // be able to collide. Appended only when present, so an intent without a
  // strength produces the byte-identical part it produced before this existed.
  // STRENGTH IS PART OF THE KEY. It changes ranking, and a cache hit returns a
  // stored shelf without re-ranking, so "black boots" and "only black" must not
  // be able to collide.
  //
  // Only a STRONG strength is appended. Ordinary preference is the default the
  // absent value already means, so an ordinary request keeps exactly the key it
  // had before this field existed -- the same "omitted is byte-identical" rule
  // the fingerprint itself follows inside the cache key.
  const scalar = (name: string, field?: IntentField<string>) => {
    if (!field) return;
    const base = `${name}:${field.provenance}:${field.value}`;
    parts.push(field.strength === 'STRONG_EXPLICIT_PREFERENCE' ? `${base}:STRONG` : base);
  };
  scalar('cat', intent.category);
  scalar('sub', intent.subtype);
  scalar('col', intent.color);
  scalar('mat', intent.material);
  scalar('sil', intent.silhouette);
  scalar('pat', intent.pattern);
  scalar('occ', intent.occasion);
  scalar('for', intent.formality);
  if (intent.matchIntent) parts.push(`match:${intent.matchIntent.value}`);
  if (intent.budgetCeiling) {
    parts.push(`budget:${intent.budgetCeiling.value.amount}:${intent.budgetCeiling.value.currency}`);
  }
  for (const f of [...intent.functionalRequirements].sort((a, b) => a.value.localeCompare(b.value))) {
    parts.push(`fn:${f.value}`);
  }
  for (const e of [...intent.exclusions].sort((a, b) => `${a.axis}${a.token}`.localeCompare(`${b.axis}${b.token}`))) {
    parts.push(`ex:${e.axis}:${e.token}`);
  }
  for (const o of [...intent.relevantOwned].sort((a, b) => a.descriptor.localeCompare(b.descriptor))) {
    parts.push(`own:${o.category ?? ''}:${o.color ?? ''}:${o.material ?? ''}`);
  }
  for (const t of [...intent.signatureStyleTokens].sort()) parts.push(`sig:${t}`);
  const gap = intent.gapRelationship?.value;
  if (gap) parts.push(`gap:${gap.gapCode}:${gap.certainty}`);
  return parts.join('|');
}
