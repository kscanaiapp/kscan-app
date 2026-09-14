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
} as const;

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
  /** Explicit budget ceiling. Null once the customer removes it. */
  budget: { amount: number; currency: string } | null;
  exclusions: Array<{ axis: 'material' | 'color'; token: string }>;
  functionalRequirements: string[];
  /** How many turns this intent has survived, for staleness. */
  turns: number;
  /** Prices shown last turn, in one known currency — the "cheaper" reference. */
  lastShownPrices: { currency: string; amounts: number[] } | null;
}

export function emptyShoppingIntentState(): EliseShoppingIntentState {
  return {
    stateVersion: 1,
    category: null,
    color: null,
    colorStrength: null,
    budget: null,
    exclusions: [],
    functionalRequirements: [],
    turns: 0,
    lastShownPrices: null,
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

  return state;
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

  return { state, reset, rejected, needsBudgetReference };
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
    contribution.budgetCeiling ||
    contribution.exclusions ||
    contribution.functionalRequirements;
  return hasAnything ? [contribution] : [];
}
