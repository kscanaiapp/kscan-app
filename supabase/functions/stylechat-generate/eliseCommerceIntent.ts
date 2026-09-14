/**
 * Elise -> Commerce activation: the shopping-intent authority (Build 36).
 *
 * WHAT ELISE OWNS AND WHAT IT DOES NOT. The model may PROPOSE typed shopping
 * fields through the existing `<actions>` channel. It does not own the intent.
 * Everything persisted between turns is produced by the reducer below from
 * typed input, so a remembered budget is a stored number rather than something
 * the model recalls from the transcript -- transcript recollection is not
 * intent authority.
 *
 * WHY THERE IS NO TOOL LOOP. `stylechat-generate` is SINGLE_PASS: one Gemini
 * call per turn, no `tools` / `functionDeclarations` / `toolConfig` in the
 * request body, and the only second call is a completeness retry. So Commerce
 * runs AFTER the model turn, deterministically, from the action the model
 * already emitted in that one pass. The model never sees the products, which
 * is also why no second model pass is needed to explain them: the rationale is
 * rendered from #409's structured facts.
 *
 * WHERE THE STATE LIVES. The same place the outfit state already lives -- a
 * typed block in the message's `ui_blocks`, written by the client and read
 * back by the server on the next turn (`eliseOutfitState.ts` established the
 * pattern). No new table, no new column, no migration.
 */

import type { IntentContribution } from './eliseCommerceIntentTypes.ts';

export const ELISE_COMMERCE_ACTION_TYPE = 'find_products' as const;

/** The block type the client persists this intent under, in `ui_blocks`. */
export const ELISE_COMMERCE_INTENT_BLOCK_TYPE = 'commerce_shopping_intent';

/** Bounds. Every one of these caps a value that arrives from the model or client. */
export const ELISE_COMMERCE_INTENT_LIMITS = {
  maxExclusions: 6,
  maxFunctional: 6,
  maxOwnedContext: 6,
  maxTokenChars: 32,
  maxCategoryChars: 40,
  /** Refinement turns before a shopping intent is considered stale. */
  maxTurns: 16,
  /** Shelves whose ORDER stays resolvable ("the first one"). */
  maxShelves: 3,
  /** Cards one remembered shelf may hold. Matches `MAX_COMMERCE_CARDS`. */
  maxProductsPerShelf: 6,
  /** Hard ceiling across every remembered shelf. */
  maxTotalProductReferences: 18,
  /** Active task-scoped product rejections ("not those"). */
  maxActiveExclusions: 24,
} as const;

/**
 * Identity token shape. `services/commerce/productIdentity.ts` mints these;
 * this function only ever validates and carries them.
 *
 * DECLARED STRUCTURALLY RATHER THAN IMPORTED, for the same reason
 * `eliseCommerceIntentTypes.ts` states: this Edge Function and the app are
 * separate bundles. The duplication is deliberate and is held in agreement by
 * an executable parity test rather than by good intentions
 * (`commerceV2ShelfMemoryParity.test.js`).
 */
const SHELF_IDENTITY_RE = /^u:[0-9a-f]{16}$/;

/** Categories a shopping request can name. A new one RESETS the intent. */
const GARMENT_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  footwear: ['shoe', 'shoes', 'boot', 'boots', 'sneaker', 'sneakers', 'heel', 'heels', 'loafer', 'loafers', 'sandal', 'sandals', 'trainer', 'trainers', 'pump', 'pumps'],
  outerwear: ['jacket', 'coat', 'parka', 'blazer', 'overcoat', 'trench', 'puffer'],
  dress: ['dress', 'gown', 'jumpsuit'],
  pants: ['trousers', 'jeans', 'pants', 'shorts', 'skirt', 'chinos'],
  top: ['top', 'shirt', 'blouse', 'sweater', 'knit', 'tee', 't-shirt', 'hoodie', 'cardigan'],
  bag: ['bag', 'handbag', 'tote', 'clutch', 'backpack', 'crossbody'],
  accessory: ['belt', 'scarf', 'hat', 'sunglasses', 'jewelry', 'necklace', 'earrings', 'watch'],
};

const COLOR_TOKENS = [
  'black', 'white', 'red', 'blue', 'navy', 'green', 'brown', 'pink', 'grey',
  'gray', 'beige', 'cream', 'tan', 'burgundy', 'olive', 'yellow', 'purple', 'orange',
] as const;

/**
 * How hard the customer asked for a colour. Two tiers, and only two.
 *
 * The tier may be PROPOSED by the model on the existing action channel, and it
 * may be RAISED by the customer's own words, but it is decided here, in
 * deterministic code, against a closed vocabulary. The model never owns
 * ranking weight, and nothing unbounded is ever persisted.
 */
export type EliseColorStrength = 'EXPLICIT_PREFERENCE' | 'STRONG_EXPLICIT_PREFERENCE';

/** Total. Anything unrecognised is an ordinary preference, never a strong one. */
export function normalizeColorStrength(raw: unknown): EliseColorStrength {
  return raw === 'STRONG_EXPLICIT_PREFERENCE' ? 'STRONG_EXPLICIT_PREFERENCE' : 'EXPLICIT_PREFERENCE';
}

/**
 * Phrases that mean "I really do mean this colour".
 *
 * Deterministic signals, mirroring `eliseAdviceIntents` rather than adding a
 * model call -- this is why the strength tier costs no extra round trip.
 *
 * Everything here is an EMPHASIS, not an exclusion: "only black" raises how far
 * a black option rises and does nothing to a brown one. A customer who wants
 * brown gone says "no brown", which is a different field entirely.
 */
const STRONG_COLOR_PHRASES: readonly RegExp[] = [
  /\bonly\s+(?:in\s+)?[a-z]+\b/i,
  /\bjust\s+(?:in\s+)?[a-z]+\b/i,
  /\bstrictly\b/i,
  /\bmust\s+be\b/i,
  /\bhas\s+to\s+be\b/i,
  /\bneeds?\s+to\s+be\b/i,
  /\breally\s+(?:want|need|prefer)\b/i,
  /\bdefinitely\b/i,
  /\bis\s+important\b/i,
  /\bit\s+has\s+to\b/i,
  /\bnothing\s+(?:but|else)\b/i,
];

/** Phrases that mean the opposite, and must not be read as emphasis. */
const SOFT_COLOR_PHRASES: readonly RegExp[] = [
  /\bif\s+possible\b/i,
  /\bif\s+(?:you\s+)?can\b/i,
  /\bwould\s+prefer\b/i,
  /\b(?:i'?d|i\s+would)\s+prefer\b/i,
  /\bideally\b/i,
  /\bopen\s+to\b/i,
  /\bdoesn'?t\s+have\s+to\b/i,
];

/**
 * The tier for THIS turn: the stronger of what the model proposed and what the
 * customer's words show, unless they hedged in the same breath.
 *
 * A hedge wins over the model's proposal deliberately. "Black if possible" read
 * as insistence is the failure that makes a customer feel unheard, and the
 * model is the party more likely to over-read enthusiasm.
 */
export function strengthForTurn(proposed: unknown, message: unknown): EliseColorStrength {
  const text = typeof message === 'string' ? message.slice(0, 400) : '';
  if (SOFT_COLOR_PHRASES.some((re) => re.test(text))) return 'EXPLICIT_PREFERENCE';
  if (normalizeColorStrength(proposed) === 'STRONG_EXPLICIT_PREFERENCE') {
    return 'STRONG_EXPLICIT_PREFERENCE';
  }
  return STRONG_COLOR_PHRASES.some((re) => re.test(text))
    ? 'STRONG_EXPLICIT_PREFERENCE'
    : 'EXPLICIT_PREFERENCE';
}

const MATERIAL_TOKENS = [
  'leather', 'suede', 'denim', 'wool', 'cotton', 'silk', 'satin', 'linen',
  'cashmere', 'nylon', 'polyester', 'fur', 'velvet',
] as const;

/**
 * Silhouette words that actually appear in retailer product text.
 *
 * THE AXIS GATE DECIDED THIS LIST, NOT TASTE. #409's `scoreContextualFit`
 * scores an explicit silhouette by looking for the token in the candidate's own
 * declared text, so a vocabulary of words no listing ever uses would be a field
 * that changes nothing — a silent no-op dressed as a feature. Every token here
 * is one a title or category realistically carries.
 */
const SILHOUETTE_TOKENS = [
  'chelsea', 'ankle', 'knee-high', 'chunky', 'platform', 'slim', 'straight',
  'tapered', 'wide-leg', 'oversized', 'cropped', 'a-line', 'midi', 'maxi',
  'mini', 'fitted', 'boxy', 'relaxed',
] as const;

/**
 * Formality, least formal first. The ORDER is the whole point: it is what
 * makes "less formal" and "dressier" resolvable to a concrete token instead of
 * a vibe, and it is why these four words rather than a richer taxonomy — each
 * one is a token #409 can actually find in candidate text.
 */
const FORMALITY_LADDER = ['casual', 'smart', 'dressy', 'formal'] as const;

/**
 * The persisted shopping state. Deliberately flat and typed: everything here
 * is either a value the reducer validated or absent.
 */
export interface EliseShoppingIntentState {
  stateVersion: 1;
  /** Canonical category this shopping thread is about. Drives the reset rule. */
  category: string | null;
  /** Explicit colour, when the customer stated one. */
  color: string | null;
  /**
   * How hard they asked for it. Null whenever `color` is null.
   *
   * A CLOSED ENUM, never free text and never a number. The model may propose a
   * tier on the existing action channel and the customer's own words may raise
   * it, but both are validated deterministically here -- the emphasis a
   * customer put on a word is worth storing, the sentence they put it in is
   * not.
   */
  colorStrength: EliseColorStrength | null;
  /**
   * Richer fashion axes (Commerce V2 Pillar B).
   *
   * EACH ONE PASSED THE AXIS GATE. A field is here only because a Phase 0
   * probe showed #409's `scoreContextualFit` actually consumes it and moves a
   * real score — material and silhouette by +22/+34, formality by +6. `pattern`
   * is deliberately ABSENT: the field exists in the intent schema and the cache
   * fingerprint, but the probe showed the ranker never reads it, and shipping a
   * customer-visible control that changes nothing is worse than not shipping it.
   */
  material: string | null;
  silhouette: string | null;
  formality: string | null;
  /** Explicit budget ceiling. Null once the customer removes it. */
  budget: { amount: number; currency: string } | null;
  exclusions: Array<{ axis: 'material' | 'color'; token: string }>;
  functionalRequirements: string[];
  /** How many turns this intent has survived, for staleness. */
  turns: number;
  /** Prices shown last turn, in one known currency — the "cheaper" reference. */
  lastShownPrices: { currency: string; amounts: number[] } | null;
  /**
   * What Commerce already showed, for THIS shopping task.
   *
   * It lives inside the shopping intent rather than beside it so that it
   * inherits the reset rule for free: a new garment category empties the intent
   * and therefore empties the memory in the same statement. Boot rejections
   * entering wedding-dress ranking is not a bug this needs to defend against
   * separately — it is structurally impossible.
   */
  shelfMemory: EliseShelfMemoryState | null;
}

/** One shelf that was actually rendered, in render order. */
export interface EliseRememberedShelf {
  turn: number;
  items: string[];
}

export interface EliseShelfMemoryState {
  /** Who was shown these. A memory tagged for another actor is discarded whole. */
  actorId: string | null;
  /** Newest first. */
  shelves: EliseRememberedShelf[];
  /** Identities the customer rejected in this task ("not those"). */
  rejected: string[];
}

export function emptyShoppingIntentState(): EliseShoppingIntentState {
  return {
    stateVersion: 1,
    category: null,
    color: null,
    colorStrength: null,
    material: null,
    silhouette: null,
    formality: null,
    budget: null,
    exclusions: [],
    functionalRequirements: [],
    turns: 0,
    lastShownPrices: null,
    shelfMemory: null,
  };
}

// ── Restore (untrusted: written by the client) ──────────────────────────────

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim().slice(0, max).toLowerCase();
  return t || null;
}

export function restoreShoppingIntentState(raw: unknown): EliseShoppingIntentState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.stateVersion !== 1) return null;

  const turns = typeof rec.turns === 'number' && Number.isFinite(rec.turns)
    ? Math.max(0, Math.min(ELISE_COMMERCE_INTENT_LIMITS.maxTurns, Math.floor(rec.turns)))
    : 0;
  // A thread that has run past its turn budget is stale: restoring it would
  // silently apply old constraints to a request that has moved on.
  if (turns >= ELISE_COMMERCE_INTENT_LIMITS.maxTurns) return null;

  const state = emptyShoppingIntentState();
  state.turns = turns;
  state.category = str(rec.category, ELISE_COMMERCE_INTENT_LIMITS.maxCategoryChars);
  const color = str(rec.color, ELISE_COMMERCE_INTENT_LIMITS.maxTokenChars);
  state.color = color && (COLOR_TOKENS as readonly string[]).includes(color) ? color : null;
  state.colorStrength = state.color ? normalizeColorStrength(rec.colorStrength) : null;
  state.material = knownToken(rec.material, MATERIAL_TOKENS);
  state.silhouette = knownToken(rec.silhouette, SILHOUETTE_TOKENS);
  state.formality = knownToken(rec.formality, FORMALITY_LADDER);

  const budget = rec.budget;
  if (budget && typeof budget === 'object') {
    const b = budget as Record<string, unknown>;
    const amount = typeof b.amount === 'number' ? b.amount : Number.parseFloat(String(b.amount ?? ''));
    const currency = typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency.trim())
      ? b.currency.trim().toUpperCase()
      : null;
    if (Number.isFinite(amount) && amount > 0 && currency) state.budget = { amount, currency };
  }

  if (Array.isArray(rec.exclusions)) {
    for (const entry of rec.exclusions) {
      if (state.exclusions.length >= ELISE_COMMERCE_INTENT_LIMITS.maxExclusions) break;
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const token = str(e.token, ELISE_COMMERCE_INTENT_LIMITS.maxTokenChars);
      const axis = e.axis === 'material' || e.axis === 'color' ? e.axis : null;
      if (!token || !axis) continue;
      const known = axis === 'material'
        ? (MATERIAL_TOKENS as readonly string[]).includes(token)
        : (COLOR_TOKENS as readonly string[]).includes(token);
      if (!known) continue;
      if (state.exclusions.some((x) => x.axis === axis && x.token === token)) continue;
      state.exclusions.push({ axis, token });
    }
  }

  if (Array.isArray(rec.functionalRequirements)) {
    for (const entry of rec.functionalRequirements) {
      if (state.functionalRequirements.length >= ELISE_COMMERCE_INTENT_LIMITS.maxFunctional) break;
      const token = str(entry, ELISE_COMMERCE_INTENT_LIMITS.maxTokenChars);
      if (token && !state.functionalRequirements.includes(token)) state.functionalRequirements.push(token);
    }
  }

  const prices = rec.lastShownPrices;
  if (prices && typeof prices === 'object') {
    const pr = prices as Record<string, unknown>;
    const currency = typeof pr.currency === 'string' && /^[A-Za-z]{3}$/.test(pr.currency.trim())
      ? pr.currency.trim().toUpperCase()
      : null;
    const amounts = Array.isArray(pr.amounts)
      ? pr.amounts.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0).slice(0, 12)
      : [];
    if (currency && amounts.length) state.lastShownPrices = { currency, amounts };
  }

  state.shelfMemory = restoreShelfMemory(rec.shelfMemory);

  return state;
}

/** A token, only if it is one this contract actually knows. Never coerced. */
function knownToken(raw: unknown, vocabulary: readonly string[]): string | null {
  const token = str(raw, ELISE_COMMERCE_INTENT_LIMITS.maxTokenChars);
  return token && vocabulary.includes(token) ? token : null;
}

function boundedIdentities(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= max) break;
    if (typeof entry !== 'string' || !SHELF_IDENTITY_RE.test(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Rebuild shelf memory from a persisted block.
 *
 * The block is written by the CLIENT, so this is untrusted input and is
 * rebuilt field by field: anything that is not an identity token of the exact
 * expected shape is dropped rather than coerced. A forged block therefore
 * degrades to LESS memory and can never name a product that was not shown —
 * and even a well-formed identity buys nothing on its own, because resolving
 * one to a card additionally requires it to match a persisted,
 * provenance-verified Commerce product on the device.
 */
export function restoreShelfMemory(raw: unknown): EliseShelfMemoryState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  const memory: EliseShelfMemoryState = { actorId: null, shelves: [], rejected: [] };
  if (typeof rec.actorId === 'string' && rec.actorId.trim()) {
    memory.actorId = rec.actorId.trim().slice(0, 80);
  }

  let total = 0;
  if (Array.isArray(rec.shelves)) {
    for (const entry of rec.shelves) {
      if (memory.shelves.length >= ELISE_COMMERCE_INTENT_LIMITS.maxShelves) break;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const shelf = entry as Record<string, unknown>;
      const remaining = ELISE_COMMERCE_INTENT_LIMITS.maxTotalProductReferences - total;
      if (remaining <= 0) break;
      const items = boundedIdentities(
        shelf.items,
        Math.min(ELISE_COMMERCE_INTENT_LIMITS.maxProductsPerShelf, remaining),
      );
      if (!items.length) continue;
      const turn = typeof shelf.turn === 'number' && Number.isFinite(shelf.turn)
        ? Math.max(0, Math.floor(shelf.turn))
        : 0;
      memory.shelves.push({ turn, items });
      total += items.length;
    }
  }

  memory.rejected = boundedIdentities(rec.rejected, ELISE_COMMERCE_INTENT_LIMITS.maxActiveExclusions);
  if (!memory.shelves.length && !memory.rejected.length && memory.actorId === null) return null;
  return memory;
}

/** Find the most recent shopping intent an assistant turn carried. */
export function findLatestShoppingIntent(
  rows: Array<{ sender?: unknown; ui_blocks?: unknown }>,
): EliseShoppingIntentState | null {
  for (const row of rows) {
    if (row?.sender !== 'assistant') continue;
    if (!Array.isArray(row.ui_blocks)) continue;
    for (const block of row.ui_blocks) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as Record<string, unknown>;
      if (typed.type !== ELISE_COMMERCE_INTENT_BLOCK_TYPE) continue;
      const restored = restoreShoppingIntentState(typed.state);
      if (restored) return restored;
    }
  }
  return null;
}

// ── The action the model may propose ────────────────────────────────────────

/**
 * Typed fields the model is allowed to propose. Anything else it writes is
 * dropped: this is an allowlist, not a merge.
 */
export interface EliseCommerceActionPayload {
  category?: unknown;
  color?: unknown;
  colorStrength?: unknown;
  /**
   * Richer fashion axes. Proposable, NEVER authoritative: the reducer accepts
   * one only when the customer's own words this turn corroborate it. See
   * `userStatedToken`.
   */
  material?: unknown;
  silhouette?: unknown;
  formality?: unknown;
  /** A conversational memory operation, inside the closed enum. */
  memoryOp?: unknown;
  /** 1-based item ordinal, for `memoryOp: 'reference'`. */
  referenceOrdinal?: unknown;
  budgetAmount?: unknown;
  budgetCurrency?: unknown;
  excludeMaterials?: unknown;
  excludeColors?: unknown;
  functionalRequirements?: unknown;
  /** True when the customer asked to drop a constraint rather than add one. */
  clearBudget?: unknown;
  clearColor?: unknown;
}

function canonicalCategory(raw: unknown): string | null {
  const text = str(raw, ELISE_COMMERCE_INTENT_LIMITS.maxCategoryChars);
  if (!text) return null;
  if (Object.prototype.hasOwnProperty.call(GARMENT_CATEGORIES, text)) return text;
  for (const [category, words] of Object.entries(GARMENT_CATEGORIES)) {
    for (const word of words) {
      if (new RegExp(`\\b${word}\\b`).test(text)) return category;
    }
  }
  return null;
}

/** The garment category a customer message is asking about, if any. */
export function categoryFromMessage(message: unknown): string | null {
  const text = str(message, 600);
  if (!text) return null;
  for (const [category, words] of Object.entries(GARMENT_CATEGORIES)) {
    for (const word of words) {
      if (new RegExp(`\\b${word}\\b`).test(text)) return category;
    }
  }
  return null;
}

// ── Conversational memory directives (Commerce V2 §23-§28) ─────────────────
//
// DETERMINISTIC, AND THE MODEL IS NOT THE AUTHORITY. The same doctrine
// `strengthForTurn` already uses: closed phrase sets, no model call, no second
// pass. The model MAY propose an operation on the existing action channel —
// it catches paraphrases a regex never will — but where the customer's own
// words say what they want, their words win. The model is never asked WHICH
// PRODUCT was shown; it may only say "the first one", and deterministic K Scan
// state decides what that actually was.

export type EliseShelfMemoryOp = 'different' | 'another' | 'not_those' | 'reference' | 'clear';

export const ELISE_SHELF_MEMORY_OPS: readonly EliseShelfMemoryOp[] = [
  'different', 'another', 'not_those', 'reference', 'clear',
];

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3,
  fourth: 4, '4th': 4, fifth: 5, '5th': 5, sixth: 6, '6th': 6,
};

const ORDINAL_ALT = Object.keys(ORDINAL_WORDS).join('|');
const REFERENCE_NOUNS = 'one|ones|pair|option|item|product|choice|suggestion';

/**
 * Structured ordinal references ONLY.
 *
 * "The first one", "the second pair", "go back to the third". Deliberately NOT
 * "the cheaper one", "the shiny one", "the one with the gold buckle": those
 * need a general natural-language product resolver, and a resolver that
 * guesses would put the wrong real product — with a real price and a real Buy
 * control — in front of someone. Where the reference is not structurally
 * unique, Elise asks instead.
 */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(?:go\\s+)?back\\s+to\\s+(?:the\\s+)?(${ORDINAL_ALT})\\b`, 'i'),
  new RegExp(`\\b(?:show|open|see|bring\\s+up)\\s+(?:me\\s+)?(?:the\\s+)?(${ORDINAL_ALT})\\s+(?:${REFERENCE_NOUNS})\\b`, 'i'),
  new RegExp(`\\bthe\\s+(${ORDINAL_ALT})\\s+(?:${REFERENCE_NOUNS})\\b`, 'i'),
];

const NOT_THOSE_PATTERNS: readonly RegExp[] = [
  /\b(?:not|none\s+of)\s+(?:those|these)\b/i,
  /\bi\s+don'?t\s+like\s+(?:any\s+of\s+)?(?:those|these)\b/i,
  /\b(?:hide|remove|drop)\s+(?:those|these)\b/i,
];

const CLEAR_PATTERNS: readonly RegExp[] = [
  /\b(?:show|bring)\s+(?:me\s+)?everything\s+(?:again|back)\b/i,
  /\breset\s+(?:my\s+)?(?:filters?|rejections?|choices?)\b/i,
  /\bstart\s+over\b/i,
];

/**
 * "Another" means ONE more. The noun guard is load-bearing: "in another
 * colour" is a colour instruction, not a request for the next candidate, and
 * treating it as one would answer a different question with a single card.
 */
const ANOTHER_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\banother\\s+(?:${REFERENCE_NOUNS})\\b`, 'i'),
  /\banother\s*(?:[.!?,]|$)/i,
  /\bone\s+more\b/i,
  /\bnext\s+(?:one|option)\b/i,
];

/**
 * "Different" means the ones you just showed me, not these. It does NOT mean a
 * different category, colour, material or aesthetic — someone who asks for
 * different black loafers still wants black loafers, and re-reading the word
 * as "change something about the request" is how a shopping assistant loses
 * the thread of what was asked.
 */
const DIFFERENT_PATTERNS: readonly RegExp[] = [
  /\b(?:something|anything)\s+(?:else|different)\b/i,
  new RegExp(`\\bdifferent\\s+(?:${REFERENCE_NOUNS})\\b`, 'i'),
  /\bshow\s+me\s+(?:some\s+)?others?\b/i,
  /\bother\s+(?:options?|ones?)\b/i,
  /\bwhat\s+else\b/i,
];

export interface EliseShelfMemoryDirective {
  op: EliseShelfMemoryOp;
  /** 1-based, within the referenced shelf. Present only for `reference`. */
  ordinal: number | null;
  /**
   * WHICH shelf the ordinal counts within.
   *
   * "The second one" said while looking at a shelf means the second of THAT
   * shelf. "Go back to the first pair" is a backward reference: it means the
   * first pair they were shown in this shopping task, several shelves ago —
   * which is a different product, and answering one with the other is the
   * quiet kind of wrong that makes a shopper stop trusting the memory.
   */
  scope: 'latest' | 'earliest';
  /** Where the directive came from, for diagnostics and for the tests. */
  source: 'user_text' | 'model_proposal';
}

/** A backward reference: not "of these", but "of the ones from before". */
const BACKWARD_REFERENCE_RE = /\b(?:go\s+back\s+to|back\s+to|earlier|before|original(?:ly)?|at\s+the\s+start|you\s+showed\s+me\s+first)\b/i;

function ordinalFromMessage(text: string): { ordinal: number; scope: 'latest' | 'earliest' } | null {
  for (const pattern of REFERENCE_PATTERNS) {
    const match = text.match(pattern);
    const word = match?.[1]?.toLowerCase();
    if (!word || !ORDINAL_WORDS[word]) continue;
    return {
      ordinal: ORDINAL_WORDS[word],
      scope: BACKWARD_REFERENCE_RE.test(text) ? 'earliest' : 'latest',
    };
  }
  return null;
}

/**
 * Read the memory directive for this turn.
 *
 * Precedence runs most specific first. A reference to a numbered item is the
 * narrowest thing the customer can mean, an explicit rejection is next, and
 * "different" is the broadest, so it is tested last and cannot swallow the
 * others.
 */
export function detectShelfMemoryDirective(
  message: unknown,
  proposedOp: unknown,
  proposedOrdinal: unknown,
): EliseShelfMemoryDirective | null {
  const text = typeof message === 'string' ? message.slice(0, 400) : '';

  const reference = ordinalFromMessage(text);
  if (reference) {
    return { op: 'reference', ordinal: reference.ordinal, scope: reference.scope, source: 'user_text' };
  }
  const plain = { ordinal: null, scope: 'latest' as const, source: 'user_text' as const };
  if (NOT_THOSE_PATTERNS.some((re) => re.test(text))) return { op: 'not_those', ...plain };
  if (CLEAR_PATTERNS.some((re) => re.test(text))) return { op: 'clear', ...plain };
  if (ANOTHER_PATTERNS.some((re) => re.test(text))) return { op: 'another', ...plain };
  if (DIFFERENT_PATTERNS.some((re) => re.test(text))) return { op: 'different', ...plain };

  // Nothing in the customer's own words. The model's proposal may stand, but
  // only inside the closed enum and the bounded ordinal range — and a proposed
  // reference with no usable ordinal is not a reference, it is a guess.
  if (typeof proposedOp !== 'string') return null;
  if (!(ELISE_SHELF_MEMORY_OPS as readonly string[]).includes(proposedOp)) return null;
  const op = proposedOp as EliseShelfMemoryOp;
  if (op !== 'reference') return { op, ordinal: null, scope: 'latest', source: 'model_proposal' };

  const raw = typeof proposedOrdinal === 'number'
    ? proposedOrdinal
    : Number.parseInt(String(proposedOrdinal ?? ''), 10);
  if (!Number.isFinite(raw)) return null;
  const bounded = Math.floor(raw);
  if (bounded < 1 || bounded > ELISE_COMMERCE_INTENT_LIMITS.maxProductsPerShelf) return null;
  // A model proposal never claims a backward reference: the customer's own
  // words are the only evidence that they meant an earlier shelf.
  return { op: 'reference', ordinal: bounded, scope: 'latest', source: 'model_proposal' };
}

// ── Relative fashion requests (Commerce V2 §39) ────────────────────────────

const LESS_FORMAL_RE = /\b(?:less\s+formal|more\s+casual|dressed?\s+down|casual(?:l?er)\b|more\s+relaxed|less\s+dressy)\b/i;
const MORE_FORMAL_RE = /\b(?:more\s+formal|dressier|dress(?:ed)?\s+up|smarter|less\s+casual)\b/i;

export type RelativeFormalityOutcome =
  | { kind: 'resolved'; token: string }
  | { kind: 'needs_reference' };

/**
 * "Less formal" only means something against a reference, exactly as "cheaper"
 * only means something against a price.
 *
 * With a formality already on the intent, this steps one rung down the ladder
 * and returns a concrete token the ranker can actually find in candidate text.
 * With none, it returns `needs_reference` — and the caller must SAY so. It must
 * not silently do nothing, and it must not invent a starting rung, because
 * guessing that loafers are "dressy" and then quietly shopping "smart" is a
 * preference the customer never expressed being applied to real money.
 */
export function resolveRelativeFormality(
  message: unknown,
  state: EliseShoppingIntentState,
): RelativeFormalityOutcome | null {
  const text = typeof message === 'string' ? message : '';
  const down = LESS_FORMAL_RE.test(text);
  const up = MORE_FORMAL_RE.test(text);
  if (!down && !up) return null;
  // Both directions in one sentence is not a direction.
  if (down && up) return { kind: 'needs_reference' };

  const current = state.formality;
  if (!current) return { kind: 'needs_reference' };
  const index = (FORMALITY_LADDER as readonly string[]).indexOf(current);
  if (index < 0) return { kind: 'needs_reference' };

  const next = Math.max(0, Math.min(FORMALITY_LADDER.length - 1, index + (down ? -1 : 1)));
  return { kind: 'resolved', token: FORMALITY_LADDER[next] };
}

// ── Relative requests (section 16) ──────────────────────────────────────────

const CHEAPER_RE = /\b(cheaper|less expensive|lower price|more affordable|something cheaper)\b/i;

export type RelativeBudgetOutcome =
  | { kind: 'resolved'; amount: number; currency: string }
  | { kind: 'needs_reference' };

/**
 * "Cheaper" only means something against a concrete reference.
 *
 * Either an active numeric ceiling, or the prices actually shown last turn in
 * one known currency. With neither, this returns `needs_reference` and Elise
 * asks -- inventing a ceiling would be inventing the customer's budget.
 */
export function resolveRelativeBudget(
  message: unknown,
  state: EliseShoppingIntentState,
): RelativeBudgetOutcome | null {
  const text = typeof message === 'string' ? message : '';
  if (!CHEAPER_RE.test(text)) return null;
  if (state.budget) {
    // Strictly below the standing ceiling, never a fabricated new number.
    return { kind: 'resolved', amount: state.budget.amount, currency: state.budget.currency };
  }
  const shown = state.lastShownPrices;
  if (shown && shown.amounts.length) {
    return { kind: 'resolved', amount: Math.min(...shown.amounts), currency: shown.currency };
  }
  return { kind: 'needs_reference' };
}

// ── Per-field provenance for the richer axes (Commerce V2 §35-§37) ─────────

/**
 * Did the CUSTOMER say this word, this turn?
 *
 * THE MODEL DOES NOT GET TO KNOW THINGS THE CUSTOMER DID NOT SAY. A proposal
 * is evidence that the model read the sentence, not evidence about the
 * garment: a model that answers "find me black boots" with
 * `material: "leather", silhouette: "chelsea", formality: "dressy"` has
 * described a plausible boot, not the customer's boot, and every one of those
 * fields would then narrow a real shelf toward a product they never asked for.
 *
 * So a proposed axis is admitted only when its token appears in the customer's
 * own words. UNKNOWN STAYS UNKNOWN — which is the honest state for an
 * attribute nobody has stated.
 *
 * Hyphenated vocabulary tokens also match their spaced spelling, because
 * "wide leg" and "wide-leg" are the same request typed two ways.
 */
export function userStatedToken(message: unknown, token: string): boolean {
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  if (!text || !token) return false;
  // The hyphen is not escaped by the pass above, so widening it here is safe.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-\\s]');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
  const match = pattern.exec(text);
  if (!match) return false;
  // A token inside a rejection is an EXCLUSION, not a request. "Nothing
  // leather" must never become "find me leather", which is the single most
  // damaging way to misread a negation in a shopping sentence.
  const prefix = text.slice(Math.max(0, match.index - 40), match.index);
  if (NEGATION_TAIL_RE.test(prefix)) return false;
  // A COMPARATIVE is not a statement of the attribute. "Less formal" names a
  // direction, not a formality — reading the word "formal" out of it would let
  // a request to move away from formal quietly set the intent TO formal, and
  // then step down from a rung the customer never stood on.
  return !COMPARATIVE_TAIL_RE.test(prefix);
}

/** A comparative immediately before the token. Bounded lookback, no lookbehind. */
const COMPARATIVE_TAIL_RE = /\b(?:less|more|least|most|as|too|quite\s+so)\s+$/i;

/** A rejection immediately before the token. Bounded lookback, no lookbehind. */
const NEGATION_TAIL_RE =
  /\b(?:no|not|without|avoid|skip|except|excluding|nothing|none|don'?t\s+(?:want|like|show)(?:\s+me)?)\s+(?:any\s+)?(?:\w+\s+){0,2}$/i;

/**
 * Resolve one richer axis for this turn.
 *
 * Three sources, in precedence order: a corroborated model proposal, the
 * customer's own words alone (the model proposed nothing but they still said
 * it), and otherwise the value already on the intent. A proposal that the
 * customer's words do not support is REJECTED and reported, never merged.
 */
function resolveAxis(input: {
  proposed: unknown;
  message: unknown;
  vocabulary: readonly string[];
  current: string | null;
  axis: string;
  rejected: string[];
}): string | null {
  const proposed = str(input.proposed, ELISE_COMMERCE_INTENT_LIMITS.maxTokenChars);
  if (input.proposed !== undefined) {
    if (!proposed || !input.vocabulary.includes(proposed)) {
      input.rejected.push(input.axis);
    } else if (userStatedToken(input.message, proposed)) {
      return proposed;
    } else {
      // Well-formed, in-vocabulary, and unsupported by anything the customer
      // said. This is the branch BLOCK-CV2-15 exists for.
      input.rejected.push(`${input.axis}:unsupported`);
    }
  }
  for (const token of input.vocabulary) {
    if (userStatedToken(input.message, token)) return token;
  }
  return input.current;
}

// ── The reducer: deterministic code owns the intent ─────────────────────────

export interface ReduceResult {
  /** A NEW state object. The previous one is never mutated. */
  state: EliseShoppingIntentState;
  /** True when a new garment category reset the thread. */
  reset: boolean;
  /** Fields the model proposed that were rejected, for diagnostics. */
  rejected: string[];
  /** True when a relative request could not be resolved to a reference. */
  needsBudgetReference: boolean;
  /**
   * A relative FORMALITY request with nothing to be relative to.
   *
   * Reported rather than swallowed, and deliberately NON-BLOCKING: "something
   * less formal, maybe suede" carries a material change that is perfectly
   * actionable, so the search still runs and Elise asks about the formality
   * alongside a real shelf. Refusing the whole turn would punish the half of
   * the sentence that was answerable.
   */
  needsFormalityReference: boolean;
  /** The memory operation this turn resolved to, if any. */
  memory: EliseShelfMemoryDirective | null;
}

/**
 * Fold one turn's proposal into the persisted intent.
 *
 * COPY-ON-WRITE. A fresh object is always returned and nested arrays are
 * rebuilt, so the snapshot persisted on turn N is still exactly what turn N
 * showed after turn N+1 refines it.
 *
 * RESET (section 15). A clearly new garment category starts a new shopping
 * intent: colour, exclusions and functional requirements do not survive it,
 * and neither does the budget unless the customer restates it in the same
 * breath. Carrying "black, no leather, under $120" from boots onto a wedding
 * dress would be worse than forgetting.
 */
export function reduceShoppingIntent(input: {
  previous: EliseShoppingIntentState | null;
  message: unknown;
  payload: EliseCommerceActionPayload | null;
}): ReduceResult {
  const rejected: string[] = [];
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};

  const proposedCategory = canonicalCategory(payload.category) ?? categoryFromMessage(input.message);
  if (payload.category !== undefined && canonicalCategory(payload.category) === null) {
    rejected.push('category');
  }

  const previous = input.previous;
  const reset = Boolean(
    previous && previous.category && proposedCategory && proposedCategory !== previous.category,
  );

  // Start from a COPY of the previous state, or from empty on a reset.
  const base = !previous || reset ? emptyShoppingIntentState() : {
    ...previous,
    exclusions: previous.exclusions.map((e) => ({ ...e })),
    functionalRequirements: [...previous.functionalRequirements],
    budget: previous.budget ? { ...previous.budget } : null,
    lastShownPrices: previous.lastShownPrices
      ? { currency: previous.lastShownPrices.currency, amounts: [...previous.lastShownPrices.amounts] }
      : null,
    shelfMemory: previous.shelfMemory
      ? {
        actorId: previous.shelfMemory.actorId,
        shelves: previous.shelfMemory.shelves.map((shelf) => ({ turn: shelf.turn, items: [...shelf.items] })),
        rejected: [...previous.shelfMemory.rejected],
      }
      : null,
  };
  const state: EliseShoppingIntentState = base;
  state.turns = reset ? 0 : Math.min(ELISE_COMMERCE_INTENT_LIMITS.maxTurns, state.turns + 1);
  if (proposedCategory) state.category = proposedCategory;

  // Removal is explicit and always wins over a proposal in the same turn:
  // "any price is fine" must not be re-narrowed by a stale ceiling field.
  if (payload.clearBudget === true) {
    state.budget = null;
  } else if (payload.budgetAmount !== undefined) {
    const amount = typeof payload.budgetAmount === 'number'
      ? payload.budgetAmount
      : Number.parseFloat(String(payload.budgetAmount ?? ''));
    const currency = typeof payload.budgetCurrency === 'string' && /^[A-Za-z]{3}$/.test(payload.budgetCurrency.trim())
      ? payload.budgetCurrency.trim().toUpperCase()
      : null;
    if (Number.isFinite(amount) && amount > 0 && currency) {
      state.budget = { amount, currency };
    } else {
      rejected.push('budget');
    }
  }

  if (payload.clearColor === true) {
    state.color = null;
    state.colorStrength = null;
  } else if (payload.color !== undefined) {
    const color = str(payload.color, ELISE_COMMERCE_INTENT_LIMITS.maxTokenChars);
    if (color && (COLOR_TOKENS as readonly string[]).includes(color)) {
      state.color = color;
      // A NEW colour is a fresh instruction: it does not inherit the emphasis of
      // the one it replaces. "Only black" then "actually, brown" is an ordinary
      // ask for brown, not an insistent one.
      state.colorStrength = strengthForTurn(payload.colorStrength, input.message);
    } else {
      rejected.push('color');
    }
  } else if (state.color) {
    // The colour is unchanged, but the customer may have just leaned on it --
    // "only black" after "black boots". Emphasis can rise within a thread and
    // never silently falls: removing it takes a new colour or a clearing.
    const raised = strengthForTurn(payload.colorStrength, input.message);
    if (raised === 'STRONG_EXPLICIT_PREFERENCE') state.colorStrength = raised;
  }

  // Richer fashion axes. Each one is admitted only with the customer's own
  // corroboration, so an intent gains `material: suede` because they said
  // "suede" and never because the model pictured one.
  state.material = resolveAxis({
    proposed: payload.material, message: input.message, vocabulary: MATERIAL_TOKENS,
    current: state.material, axis: 'material', rejected,
  });
  state.silhouette = resolveAxis({
    proposed: payload.silhouette, message: input.message, vocabulary: SILHOUETTE_TOKENS,
    current: state.silhouette, axis: 'silhouette', rejected,
  });
  state.formality = resolveAxis({
    proposed: payload.formality, message: input.message, vocabulary: FORMALITY_LADDER,
    current: state.formality, axis: 'formality', rejected,
  });

  const addExclusions = (raw: unknown, axis: 'material' | 'color', known: readonly string[]) => {
    if (raw === undefined) return;
    if (!Array.isArray(raw)) { rejected.push(`exclude_${axis}`); return; }
    for (const entry of raw) {
      if (state.exclusions.length >= ELISE_COMMERCE_INTENT_LIMITS.maxExclusions) break;
      const token = str(entry, ELISE_COMMERCE_INTENT_LIMITS.maxTokenChars);
      if (!token || !known.includes(token)) { rejected.push(`exclude_${axis}:${String(entry)}`); continue; }
      if (state.exclusions.some((x) => x.axis === axis && x.token === token)) continue;
      state.exclusions.push({ axis, token });
    }
  };
  addExclusions(payload.excludeMaterials, 'material', MATERIAL_TOKENS);
  addExclusions(payload.excludeColors, 'color', COLOR_TOKENS);

  if (payload.functionalRequirements !== undefined) {
    if (!Array.isArray(payload.functionalRequirements)) rejected.push('functionalRequirements');
    else {
      for (const entry of payload.functionalRequirements) {
        if (state.functionalRequirements.length >= ELISE_COMMERCE_INTENT_LIMITS.maxFunctional) break;
        const token = str(entry, ELISE_COMMERCE_INTENT_LIMITS.maxTokenChars);
        if (token && !state.functionalRequirements.includes(token)) state.functionalRequirements.push(token);
      }
    }
  }

  // A relative request resolves against the state as it stands AFTER the
  // explicit fields above, so "cheaper" following "under $150" means below 150.
  let needsBudgetReference = false;
  const relative = resolveRelativeBudget(input.message, state);
  if (relative) {
    if (relative.kind === 'needs_reference') needsBudgetReference = true;
    else state.budget = { amount: relative.amount, currency: relative.currency };
  }

  // Resolved AFTER the explicit axes above, so "make it formal, then dressier"
  // steps up from the formality the same sentence just established.
  let needsFormalityReference = false;
  const relativeFormality = resolveRelativeFormality(input.message, state);
  if (relativeFormality) {
    if (relativeFormality.kind === 'needs_reference') needsFormalityReference = true;
    else state.formality = relativeFormality.token;
  }

  // ── Product memory ───────────────────────────────────────────────────────
  //
  // The two operations that CHANGE persisted state happen here, in the same
  // reducer that owns every other piece of shopping state, so there is exactly
  // one task authority and one reset rule. Presentation-only operations
  // ("different", "another", "reference") change nothing here — they are
  // result-set decisions the client makes from this state, which is what keeps
  // them out of the retrieval key and therefore out of provider spend.
  const memory = detectShelfMemoryDirective(input.message, payload.memoryOp, payload.referenceOrdinal);
  if (memory && !reset) {
    if (memory.op === 'not_those') {
      state.shelfMemory = rejectLatestShelfIdentities(state.shelfMemory);
    } else if (memory.op === 'clear') {
      state.shelfMemory = state.shelfMemory
        ? { actorId: state.shelfMemory.actorId, shelves: state.shelfMemory.shelves, rejected: [] }
        : null;
    }
  }

  return { state, reset, rejected, needsBudgetReference, needsFormalityReference, memory: reset ? null : memory };
}

/**
 * Move the most recent shelf's exact identities into the task's rejection set.
 *
 * EXACT IDENTITIES, AND NOTHING INFERRED. Four rejected loafers are four
 * rejected listings — not "no black", not "nothing from that retailer", not
 * "less formal". Inferring a rule from a rejection is how an assistant ends up
 * hiding the market behind a preference the customer never expressed.
 */
function rejectLatestShelfIdentities(
  memory: EliseShelfMemoryState | null,
): EliseShelfMemoryState | null {
  if (!memory) return memory;
  const latest = memory.shelves[0];
  if (!latest || !latest.items.length) return memory;

  const merged = [...memory.rejected];
  for (const identity of latest.items) {
    if (!merged.includes(identity)) merged.push(identity);
  }
  // Bounded, and the OLDEST rejections give way first: the customer is
  // watching the newest one. A dropped rejection can legitimately reappear,
  // which the client surfaces rather than hides.
  const overflow = Math.max(0, merged.length - ELISE_COMMERCE_INTENT_LIMITS.maxActiveExclusions);
  return {
    actorId: memory.actorId,
    shelves: memory.shelves.map((shelf) => ({ turn: shelf.turn, items: [...shelf.items] })),
    rejected: overflow ? merged.slice(overflow) : merged,
  };
}

/**
 * Translate the persisted state into #409 contributions.
 *
 * Everything here is USER_EXPLICIT: it is what the customer said, validated.
 * Closet and Signature Style contributions are assembled separately, on the
 * client, where that data already lives -- they are not this module's to
 * invent.
 */
export function contributionsFromState(state: EliseShoppingIntentState | null): IntentContribution[] {
  if (!state) return [];
  const contribution: IntentContribution = { provenance: 'USER_EXPLICIT' };
  if (state.color) {
    contribution.color = state.color;
    // Strength travels with the colour it qualifies, never on its own.
    if (state.colorStrength) contribution.colorStrength = state.colorStrength;
  }
  // Each of these reaches #409's `scoreContextualFit` as a USER_EXPLICIT axis,
  // which is the whole point of admitting them: a field that does not change a
  // real score is a field that lied to the customer about being heard.
  if (state.material) contribution.material = state.material;
  if (state.silhouette) contribution.silhouette = state.silhouette;
  if (state.formality) contribution.formality = state.formality;
  if (state.budget) {
    contribution.budgetCeiling = { amount: state.budget.amount, currency: state.budget.currency };
  }
  if (state.exclusions.length) {
    contribution.exclusions = state.exclusions.map((e) => ({ axis: e.axis, token: e.token }));
  }
  if (state.functionalRequirements.length) {
    contribution.functionalRequirements = [...state.functionalRequirements];
  }
  const hasAnything =
    contribution.color ||
    contribution.material ||
    contribution.silhouette ||
    contribution.formality ||
    contribution.budgetCeiling ||
    contribution.exclusions ||
    contribution.functionalRequirements;
  return hasAnything ? [contribution] : [];
}
