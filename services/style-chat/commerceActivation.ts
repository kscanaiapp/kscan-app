/**
 * Elise Commerce activation — the client half (Build 36).
 *
 * WHERE COMMERCE ACTUALLY RUNS. Here, not in `stylechat-generate`. Three
 * reasons, all structural:
 *
 *   1. The governed Commerce transport already lives on the client
 *      (`commerceHydration.fetchDeferredCommerce`, the single authority for
 *      `commerce_only`). Calling it from the chat function would mean a new
 *      server-to-server hop and a second place that can reach a provider.
 *   2. The Closet and Signature Style context this needs is already on the
 *      device. Shipping it to the chat function so the chat function could
 *      ship it back out would widen the blast radius for no gain.
 *   3. `stylechat-generate` is SINGLE_PASS. Commerce runs AFTER the model
 *      turn either way, so running it where the transport and the context
 *      already are costs nothing and adds no model pass.
 *
 * WHAT THIS MODULE IS NOT. It does not rank, score, or order anything: #409
 * owns that, server-side. It assembles a request and turns a result into a
 * block.
 */

import type { CommerceHydrationEvidence, CommerceHydrationResult } from '../commerceHydration';
import type { CommerceContextContribution } from '../commerce/shoppingContext.ts';
import { buildShoppingContext, closetContribution, signatureStyleContribution } from '../commerce/shoppingContext.ts';
import type { StyleChatUiBlock } from './types';
import { hasCommerceProvenance } from '../commerce/productIdentity.ts';
import {
  EXHAUSTION_REFRESH_MIN_AGE_MS,
  activeExclusions,
  candidateUniverseKey,
  clearRejections,
  emptyShelfMemory,
  parseShelfMemory,
  readCandidateUniverseEntry,
  recordShelf,
  rejectLatestShelf,
  resolveShelfReference,
  revalidateRestoredProduct,
  selectPresentedShelf,
  shelfMemoryForActor,
  writeCandidateUniverse,
  type ShelfMemoryOp,
  type ShelfMemoryState,
} from './commerceShelfMemory.ts';

/** The block type a verified Commerce result is persisted and rendered under. */
export const COMMERCE_PRODUCTS_BLOCK_TYPE = 'commerce_products';

/**
 * Section 17. A wardrobe is not context; a handful of relevant pieces is.
 * Anything above this is noise to the ranker and payload to the network.
 */
export const MAX_CLOSET_CONTEXT_ITEMS = 6;

/** Bound on rendered cards. The shelf explains a choice; it is not a catalogue. */
export const MAX_COMMERCE_CARDS = 6;

export interface ShoppingIntentStateLike {
  category: string | null;
  color: string | null;
  colorStrength?: 'EXPLICIT_PREFERENCE' | 'STRONG_EXPLICIT_PREFERENCE' | null;
  /** Commerce V2 axes. Each one reaches #409's ranker as a USER_EXPLICIT field. */
  material?: string | null;
  silhouette?: string | null;
  formality?: string | null;
  budget: { amount: number; currency: string } | null;
  exclusions: Array<{ axis: 'material' | 'color'; token: string }>;
  functionalRequirements: string[];
  /** What Commerce already showed for this task. */
  shelfMemory?: ShelfMemoryState | null;
}

export interface ClosetContextItem {
  title?: unknown;
  category?: unknown;
  color?: unknown;
  material?: unknown;
}

/** Canonical category -> the identification the Commerce query is built from. */
const CATEGORY_TO_IDENTIFICATION: Readonly<Record<string, { item_type: string; subtype: string }>> = {
  footwear: { item_type: 'footwear', subtype: 'shoes' },
  outerwear: { item_type: 'outerwear', subtype: 'jacket' },
  dress: { item_type: 'dress', subtype: 'dress' },
  pants: { item_type: 'pants', subtype: 'trousers' },
  top: { item_type: 'top', subtype: 'top' },
  bag: { item_type: 'bag', subtype: 'bag' },
  accessory: { item_type: 'accessory', subtype: 'accessory' },
};

/**
 * Build the identification the Commerce request searches on.
 *
 * Only the customer's own stated attributes reach it. In particular no Closet
 * item text, no conversation text and no identifier of any kind: this object
 * is what the existing provider query is constructed from, so anything placed
 * here is a candidate for leaving the device (section 19).
 */
export function buildCommerceIdentification(
  state: ShoppingIntentStateLike | null,
): Record<string, unknown> | null {
  const category = typeof state?.category === 'string' ? state.category : null;
  if (!category) return null;
  const base = CATEGORY_TO_IDENTIFICATION[category];
  if (!base) return null;
  const identification: Record<string, unknown> = { ...base };
  if (state?.color) identification.primary_color = state.color;
  return identification;
}

/**
 * Closet vocabulary per canonical shopping category.
 *
 * THE TWO TAXONOMIES DO NOT AGREE, and this is where they are reconciled. A
 * shopping intent says `footwear`; a Closet item says `boot`. Handing the
 * canonical word straight to a substring filter matches neither way round, so
 * the Closet context silently disappeared and duplication detection never ran
 * — the failure looked like "the ranker ignored my wardrobe" and was really a
 * vocabulary mismatch one layer earlier.
 *
 * The translation lives HERE, at the activation boundary, rather than in
 * either system: Commerce should not learn Closet words, and the Closet
 * should not learn shopping categories.
 */
const CLOSET_WORDS_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
  footwear: ['footwear', 'shoe', 'shoes', 'boot', 'boots', 'sneaker', 'sneakers', 'heel', 'heels', 'loafer', 'loafers', 'sandal', 'sandals', 'trainer', 'trainers', 'pump', 'pumps', 'flat', 'flats'],
  outerwear: ['outerwear', 'jacket', 'coat', 'parka', 'blazer', 'overcoat', 'trench', 'puffer', 'vest'],
  dress: ['dress', 'dresses', 'gown', 'jumpsuit', 'romper'],
  pants: ['pants', 'trouser', 'trousers', 'jeans', 'shorts', 'skirt', 'chino', 'chinos', 'legging', 'leggings'],
  top: ['top', 'tops', 'shirt', 'blouse', 'sweater', 'knit', 'tee', 't-shirt', 'hoodie', 'cardigan', 'tank'],
  bag: ['bag', 'bags', 'handbag', 'tote', 'clutch', 'backpack', 'crossbody', 'purse'],
  accessory: ['accessory', 'accessories', 'belt', 'scarf', 'hat', 'sunglasses', 'jewelry', 'necklace', 'earrings', 'watch'],
};

/** Does this Closet item belong to the category being shopped for? */
function itemMatchesCategory(item: ClosetContextItem, category: string | null): boolean {
  if (!category) return true;
  const words = CLOSET_WORDS_BY_CATEGORY[category];
  if (!words) return true;
  const haystack = [item?.category, item?.title]
    .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
    .join(' ');
  if (!haystack.trim()) return false;
  return words.some((word) => new RegExp(`\\b${word}\\b`).test(haystack));
}

/**
 * Select the Closet pieces that matter for THIS request.
 *
 * Deterministic and bounded: same-category items only, capped, and reduced to
 * the descriptor plus the three axes duplication actually turns on. There is
 * no model call here and no scoring — an LLM choosing which of someone's
 * clothes to disclose is exactly what section 17 forbids.
 */
export function selectClosetContext(input: {
  actorId: string | null;
  category: string | null;
  items: readonly ClosetContextItem[] | null | undefined;
}): CommerceContextContribution | null {
  if (!input.actorId || !Array.isArray(input.items) || !input.items.length) return null;
  const relevant = input.items
    .filter((item) => item && typeof item === 'object' && itemMatchesCategory(item, input.category))
    .slice(0, MAX_CLOSET_CONTEXT_ITEMS);
  if (!relevant.length) return null;
  // Category filtering already happened above, in the vocabulary that Closet
  // items actually use, so no category is passed down.
  return closetContribution({ actorId: input.actorId, items: relevant as ClosetContextItem[] });
}

export function selectSignatureStyleContext(input: {
  actorId: string | null;
  tokens: readonly unknown[] | null | undefined;
}): CommerceContextContribution | null {
  if (!input.actorId || !Array.isArray(input.tokens) || !input.tokens.length) return null;
  return signatureStyleContribution({ actorId: input.actorId, tokens: [...input.tokens] });
}

/**
 * Assemble the whole `commerce_only` request for an activated shopping turn.
 *
 * Returns null when there is nothing to search for — an action with no
 * resolvable category is not a Commerce request, and firing one anyway would
 * spend a provider call on a guess.
 */
export function buildActivationEvidence(input: {
  state: ShoppingIntentStateLike | null;
  actorId: string | null;
  closetItems?: readonly ClosetContextItem[] | null;
  signatureStyleTokens?: readonly unknown[] | null;
  extraContributions?: readonly (CommerceContextContribution | null | undefined)[];
}): CommerceHydrationEvidence | null {
  const identification = buildCommerceIdentification(input.state);
  if (!identification) return null;

  const explicit: CommerceContextContribution = { provenance: 'USER_EXPLICIT' };
  if (input.state?.color) {
    explicit.color = input.state.color;
    if (input.state.colorStrength === 'STRONG_EXPLICIT_PREFERENCE') {
      explicit.colorStrength = 'STRONG_EXPLICIT_PREFERENCE';
    }
  }
  // The axes that passed the Phase 0 gate. Sent as USER_EXPLICIT because that
  // is what the reducer proved them to be: a token the customer typed.
  if (input.state?.material) explicit.material = input.state.material;
  if (input.state?.silhouette) explicit.silhouette = input.state.silhouette;
  if (input.state?.formality) explicit.formality = input.state.formality;
  if (input.state?.budget) {
    explicit.budgetCeiling = { amount: input.state.budget.amount, currency: input.state.budget.currency };
  }
  if (input.state?.exclusions?.length) {
    explicit.exclusions = input.state.exclusions.map((e) => ({ axis: e.axis, token: e.token }));
  }
  if (input.state?.functionalRequirements?.length) {
    explicit.functionalRequirements = [...input.state.functionalRequirements];
  }

  const context = buildShoppingContext([
    // Order is precedence: inferred context first, the customer's own words
    // last, so an explicit constraint always lands on top of a preference.
    selectClosetContext({ actorId: input.actorId, category: input.state?.category ?? null, items: input.closetItems }),
    selectSignatureStyleContext({ actorId: input.actorId, tokens: input.signatureStyleTokens }),
    ...(input.extraContributions ?? []).filter(Boolean) as CommerceContextContribution[],
    explicit,
  ]);

  return {
    identification,
    ...(context ? { shoppingContext: context } : {}),
  };
}

// ── Result -> block ─────────────────────────────────────────────────────────

/**
 * What happened, as four DIFFERENT facts.
 *
 * `no_matches` is "the market has nothing that fits those constraints".
 * `exhausted` is "the market had options and you have now seen or rejected all
 * of them" — a scarcity the customer created, which is answered by offering to
 * relax something rather than by an apology. `error` is "I could not check".
 * Collapsing any pair of these tells someone something untrue about their own
 * shopping, which is why they never share copy.
 */
export type CommerceBlockStatus = 'results' | 'no_matches' | 'exhausted' | 'error';

/**
 * Closed notice codes. Copy lives in the view; the block carries the FACT.
 *
 * A code is emitted only when deterministic state proved it, which is what
 * keeps a conversational promise ("I'll ask about the formality") from being
 * something the model decided to say.
 */
export type CommerceBlockNotice =
  | 'formality_needs_reference'
  | 'restored_not_transactable'
  | 'reference_expired'
  | 'reference_out_of_range'
  | 'reference_no_shelf'
  | 'rejections_dropped'
  | 'rejections_cleared';

export interface CommerceProductsBlock extends StyleChatUiBlock {
  type: typeof COMMERCE_PRODUCTS_BLOCK_TYPE;
  status: CommerceBlockStatus;
  products: Array<Record<string, unknown>>;
  /** The memory operation this shelf answers, when it answers one. */
  memoryOp?: ShelfMemoryOp | null;
  /** Facts the view must say out loud. Never prose, never model-authored. */
  notices?: CommerceBlockNotice[];
  /** Candidates the active product exclusions removed, for honest copy (§47). */
  hiddenCount?: number;
  /** Echoed so a stale block can be told from a current one. */
  intentSummary: {
    category: string | null;
    color: string | null;
    /**
     * Whether the customer INSISTED on the colour.
     *
     * Presentation reads this, not ranking: when someone says "only black" and
     * a brown option is still on the shelf, the shelf has to say why it is
     * there. An ordinary preference needs no such explanation, so the split is
     * offered only for the strong tier.
     */
    colorStrength: 'EXPLICIT_PREFERENCE' | 'STRONG_EXPLICIT_PREFERENCE' | null;
    material: string | null;
    silhouette: string | null;
    formality: string | null;
    budget: { amount: number; currency: string } | null;
    exclusions: string[];
  };
}

/**
 * Commerce provenance, re-exported from its definition site.
 *
 * The rule itself now lives in `services/commerce/productIdentity.ts`, beside
 * the identity derivation that shelf memory asks about the same row — but this
 * remains the import path every existing caller uses, and it stays that way.
 */
export { hasCommerceProvenance };

/**
 * Turn one Commerce outcome into the block the chat will persist and render.
 *
 * THE FAILURE DISTINCTION (section 29 / BLOCK-13). A provider failure is not
 * "nothing matches". They produce different statuses here and different copy
 * downstream, and both produce ZERO product cards — there is no path in this
 * function that can emit a card without a real candidate behind it.
 */
export function buildCommerceProductsBlock(input: {
  result: CommerceHydrationResult | null | undefined;
  state: ShoppingIntentStateLike | null;
  /** Presentation override: the shelf memory already chose these. */
  products?: Array<Record<string, unknown>> | null;
  status?: CommerceBlockStatus;
  memoryOp?: ShelfMemoryOp | null;
  notices?: CommerceBlockNotice[];
  hiddenCount?: number;
}): CommerceProductsBlock {
  const intentSummary = buildIntentSummary(input.state);
  const extras = {
    ...(input.memoryOp ? { memoryOp: input.memoryOp } : {}),
    ...(input.notices?.length ? { notices: [...input.notices] } : {}),
    ...(input.hiddenCount ? { hiddenCount: input.hiddenCount } : {}),
  };

  // A caller that already selected the shelf still goes through the SAME
  // provenance filter. Shelf memory can choose which verified products to show
  // and never what counts as one.
  if (input.products) {
    const verified = input.products
      .filter(hasCommerceProvenance)
      .slice(0, MAX_COMMERCE_CARDS) as Array<Record<string, unknown>>;
    const status: CommerceBlockStatus = verified.length > 0
      ? 'results'
      : (input.status && input.status !== 'results' ? input.status : 'no_matches');
    return { type: COMMERCE_PRODUCTS_BLOCK_TYPE, status, products: verified, intentSummary, ...extras };
  }

  const result = input.result;
  if (!result || result.status === 'error') {
    return { type: COMMERCE_PRODUCTS_BLOCK_TYPE, status: 'error', products: [], intentSummary, ...extras };
  }

  const verified = (result.purchaseOptions ?? [])
    .filter(hasCommerceProvenance)
    .slice(0, MAX_COMMERCE_CARDS) as Array<Record<string, unknown>>;

  return {
    type: COMMERCE_PRODUCTS_BLOCK_TYPE,
    status: verified.length > 0 ? 'results' : 'no_matches',
    products: verified,
    intentSummary,
    ...extras,
  };
}

/** The active constraints, echoed so a stale block can be told from a current one. */
function buildIntentSummary(state: ShoppingIntentStateLike | null) {
  return {
    category: state?.category ?? null,
    color: state?.color ?? null,
    colorStrength: state?.color ? (state.colorStrength ?? 'EXPLICIT_PREFERENCE') : null,
    material: state?.material ?? null,
    silhouette: state?.silhouette ?? null,
    formality: state?.formality ?? null,
    budget: state?.budget ? { ...state.budget } : null,
    exclusions: (state?.exclusions ?? []).map((e) => `${e.axis}:${e.token}`),
  };
}

/**
 * The prices this turn actually showed, for the next turn's "cheaper".
 *
 * Only same-currency, provider-declared prices count: a mixed-currency shelf
 * is not a comparable reference, and treating it as one would invent a
 * comparison the data cannot support.
 */
export function extractShownPrices(
  products: readonly Record<string, unknown>[] | null | undefined,
): { currency: string; amounts: number[] } | null {
  if (!Array.isArray(products) || !products.length) return null;
  let currency: string | null = null;
  const amounts: number[] = [];
  for (const product of products) {
    const code = typeof product.currency === 'string' && /^[A-Za-z]{3}$/.test(product.currency.trim())
      ? product.currency.trim().toUpperCase()
      : null;
    if (!code) return null;
    if (currency === null) currency = code;
    else if (currency !== code) return null;
    const raw = product.price;
    const value = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseFloat(raw.replace(/[^0-9.,-]/g, '').replace(/,/g, ''))
        : NaN;
    if (!Number.isFinite(value) || value <= 0) return null;
    amounts.push(value);
  }
  return currency && amounts.length ? { currency, amounts } : null;
}

// ── Wire validation ─────────────────────────────────────────────────────────

export interface ShoppingIntentWire {
  blockType: string;
  state: ShoppingIntentStateLike & { stateVersion: 1; turns: number; lastShownPrices: unknown };
  needsBudgetReference: boolean;
  /** A relative formality request with nothing to be relative to (§39). */
  needsFormalityReference: boolean;
  /** The memory operation the server's reducer resolved for this turn. */
  memory: { op: ShelfMemoryOp; ordinal: number | null; scope: 'latest' | 'earliest' } | null;
}

const MEMORY_OPS: readonly ShelfMemoryOp[] = ['different', 'another', 'not_those', 'reference', 'clear'];
const AXIS_RE = /^[a-z][a-z-]{1,31}$/;

const COLOR_RE = /^[a-z]{3,12}$/;
const ISO_RE = /^[A-Z]{3}$/;

/**
 * Validate the `shoppingIntent` a backend turn returned.
 *
 * The server authored it, but it still crosses the wire, and a client that
 * trusts a shape it did not check is one deploy skew away from acting on
 * nonsense. Rebuilt field by field; anything unrecognised is dropped rather
 * than passed through.
 */
export function parseShoppingIntentWire(raw: unknown): ShoppingIntentWire | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.blockType !== 'commerce_shopping_intent') return null;
  const rawState = rec.state;
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) return null;
  const st = rawState as Record<string, unknown>;
  if (st.stateVersion !== 1) return null;

  const category = typeof st.category === 'string' && st.category.trim() ? st.category.trim().toLowerCase().slice(0, 40) : null;
  const color = typeof st.color === 'string' && COLOR_RE.test(st.color.trim().toLowerCase())
    ? st.color.trim().toLowerCase()
    : null;
  // Closed enum, re-validated on the way in. Only STRONG is carried: the
  // ordinary tier is what an absent value already means, so an ordinary request
  // produces exactly the contribution it produced before this field existed.
  const colorStrength = color && st.colorStrength === 'STRONG_EXPLICIT_PREFERENCE'
    ? ('STRONG_EXPLICIT_PREFERENCE' as const)
    : null;

  let budget: { amount: number; currency: string } | null = null;
  if (st.budget && typeof st.budget === 'object') {
    const b = st.budget as Record<string, unknown>;
    const amount = typeof b.amount === 'number' ? b.amount : Number.NaN;
    const currency = typeof b.currency === 'string' && ISO_RE.test(b.currency.trim().toUpperCase())
      ? b.currency.trim().toUpperCase()
      : null;
    if (Number.isFinite(amount) && amount > 0 && currency) budget = { amount, currency };
  }

  const exclusions: Array<{ axis: 'material' | 'color'; token: string }> = [];
  if (Array.isArray(st.exclusions)) {
    for (const entry of st.exclusions.slice(0, 6)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const axis = e.axis === 'material' || e.axis === 'color' ? e.axis : null;
      const token = typeof e.token === 'string' ? e.token.trim().toLowerCase().slice(0, 32) : '';
      if (!axis || !token) continue;
      exclusions.push({ axis, token });
    }
  }

  const functionalRequirements: string[] = [];
  if (Array.isArray(st.functionalRequirements)) {
    for (const entry of st.functionalRequirements.slice(0, 6)) {
      if (typeof entry !== 'string') continue;
      const token = entry.trim().toLowerCase().slice(0, 32);
      if (token && !functionalRequirements.includes(token)) functionalRequirements.push(token);
    }
  }

  const turns = typeof st.turns === 'number' && Number.isFinite(st.turns) ? Math.max(0, Math.floor(st.turns)) : 0;

  const axis = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const token = value.trim().toLowerCase().slice(0, 32);
    return AXIS_RE.test(token) ? token : null;
  };

  // The memory operation the server resolved. Re-validated against the closed
  // enum, and an ordinal outside the shelf bound is DROPPED rather than
  // clamped — a clamped ordinal resolves to a real product nobody named.
  let memory: ShoppingIntentWire['memory'] = null;
  const rawMemory = rec.memory;
  if (rawMemory && typeof rawMemory === 'object' && !Array.isArray(rawMemory)) {
    const m = rawMemory as Record<string, unknown>;
    if (typeof m.op === 'string' && (MEMORY_OPS as readonly string[]).includes(m.op)) {
      const op = m.op as ShelfMemoryOp;
      const raw = typeof m.ordinal === 'number' ? m.ordinal : Number.NaN;
      const ordinal = Number.isInteger(raw) && raw >= 1 && raw <= MAX_COMMERCE_CARDS ? raw : null;
      const scope = m.scope === 'earliest' ? ('earliest' as const) : ('latest' as const);
      memory = op === 'reference' && ordinal === null ? null : { op, ordinal, scope };
    }
  }

  return {
    blockType: 'commerce_shopping_intent',
    state: {
      stateVersion: 1,
      category,
      color,
      colorStrength,
      material: axis(st.material),
      silhouette: axis(st.silhouette),
      formality: axis(st.formality),
      budget,
      exclusions,
      functionalRequirements,
      turns,
      lastShownPrices: (st as { lastShownPrices?: unknown }).lastShownPrices ?? null,
      shelfMemory: parseShelfMemory((st as { shelfMemory?: unknown }).shelfMemory),
    },
    needsBudgetReference: rec.needsBudgetReference === true,
    needsFormalityReference: rec.needsFormalityReference === true,
    memory,
  };
}

/** The intent block persisted alongside the assistant message. */
export function buildShoppingIntentBlock(
  wire: ShoppingIntentWire,
  shownPrices: { currency: string; amounts: number[] } | null,
  shelfMemory?: ShelfMemoryState | null,
): StyleChatUiBlock {
  return {
    type: 'commerce_shopping_intent',
    state: {
      ...wire.state,
      // Recorded from the shelf THIS turn actually showed, so next turn's
      // "cheaper" has a concrete reference instead of a guess.
      lastShownPrices: shownPrices,
      // Same mechanism, same reason: what was SHOWN is recorded from what was
      // actually rendered, not from what was requested.
      shelfMemory: shelfMemory === undefined ? (wire.state.shelfMemory ?? null) : shelfMemory,
    },
  } as unknown as StyleChatUiBlock;
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface CommerceActivationOutcome {
  /** Blocks to append to the assistant message, in order. */
  blocks: StyleChatUiBlock[];
  /** What actually happened, for the caller's copy and for tests. */
  status: CommerceBlockStatus | 'skipped';
  /** True when a relative request had no reference and Elise must ask. */
  needsBudgetReference: boolean;
  /** True when a relative FORMALITY request had no reference (§39). */
  needsFormalityReference: boolean;
  /** Provider-facing Commerce invocations this activation made. */
  commerceCalls: number;
  /** The memory operation this turn served, for diagnostics and journeys. */
  memoryOp: ShelfMemoryOp | null;
  /** Facts the caller may need to say. Mirrors the block's notices. */
  notices: CommerceBlockNotice[];
}

export interface CommerceActivationDeps {
  fetchCommerce: (evidence: CommerceHydrationEvidence) => Promise<CommerceHydrationResult>;
  loadClosetItems?: () => Promise<readonly ClosetContextItem[] | null>;
  loadSignatureStyleTokens?: () => Promise<readonly string[] | null>;
}

/**
 * Run one activated shopping turn.
 *
 * AT MOST ONE Commerce invocation, and often zero.
 *
 * That is the whole economic argument for shelf memory. Before it, every
 * "show me different ones" was a fresh provider round trip that returned the
 * same market and therefore, necessarily, the same shelf — money spent to
 * disappoint someone. Now the CANDIDATE UNIVERSE from the retrieval this task
 * already paid for is kept, and the conversational operations are result-set
 * decisions over it: "different" and "another" answer from candidates already
 * in hand, and a retrieval happens only when there is genuinely nothing left
 * to answer from. There is no retry loop and no second pass.
 *
 * WHAT IS NOT IN THE RETRIEVAL KEY. Product exclusions. They are applied to
 * the RESULT, never to the request, so the base cache key is byte-identical to
 * the one #410 shipped for every zero-memory caller and a customer wanting
 * different products cannot force a cache miss.
 *
 * Context loads are best-effort. A Closet read that fails must not fail the
 * shopping request — it degrades to a request with less context, which is
 * exactly what a customer with an empty Closet already gets.
 */
export async function runCommerceActivation(input: {
  wire: ShoppingIntentWire | null;
  actorId: string | null;
  deps: CommerceActivationDeps;
  /**
   * Verified products from persisted `commerce_products` blocks in THIS
   * session, for resolving "the first one" (§17, §28).
   *
   * Every one is re-checked for Commerce provenance before it can resolve a
   * reference, so a forged or edited shelf state cannot mint a product: the
   * ordinal picks a stored identity, and that identity must match a product
   * that really came back from the Commerce path.
   */
  priorShelfProducts?: readonly Record<string, unknown>[] | null;
  /** Injected in tests. Production reads the wall clock. */
  now?: number;
}): Promise<CommerceActivationOutcome> {
  const wire = input.wire;
  const notices: CommerceBlockNotice[] = [];
  if (!wire) {
    return {
      blocks: [], status: 'skipped', needsBudgetReference: false,
      needsFormalityReference: false, commerceCalls: 0, memoryOp: null, notices,
    };
  }

  const now = input.now ?? Date.now();
  const op = wire.memory?.op ?? null;
  if (wire.needsFormalityReference) notices.push('formality_needs_reference');

  // ACTOR GATE, not an actor filter. A memory tagged for someone else is
  // discarded whole: a partially retained foreign shelf is still foreign.
  let memory = shelfMemoryForActor(wire.state.shelfMemory, input.actorId);

  // A relative BUDGET request with no reference is a QUESTION, not a search.
  // Firing a provider call on an invented ceiling would spend money to answer
  // something the customer has not said yet.
  if (wire.needsBudgetReference) {
    return {
      blocks: [buildShoppingIntentBlock(wire, null, memory)],
      status: 'skipped',
      needsBudgetReference: true,
      needsFormalityReference: wire.needsFormalityReference,
      commerceCalls: 0,
      memoryOp: op,
      notices,
    };
  }

  const universeKey = candidateUniverseKey({
    actorId: input.actorId,
    category: wire.state.category ?? null,
    color: wire.state.color ?? null,
    material: wire.state.material ?? null,
    silhouette: wire.state.silhouette ?? null,
    formality: wire.state.formality ?? null,
    budget: wire.state.budget,
    exclusions: wire.state.exclusions,
    functionalRequirements: wire.state.functionalRequirements,
  });

  let commerceCalls = 0;
  let lookupFailed = false;

  /**
   * ONLY A MEMORY REQUEST REUSES THE RETAINED UNIVERSE.
   *
   * A new or refined search is still a search: it takes the ordinary
   * retrieval path #410 shipped, with #410's own server-side cache behind it,
   * so a turn that asks nothing about what was already shown behaves exactly
   * as it did before this lane — including reporting a provider failure as a
   * failure rather than quietly answering from a stale local set.
   *
   * The retention exists for the operations that genuinely cannot be answered
   * by asking the provider the same question again: "different", "another",
   * "not those" and "the first one" are all questions about a candidate set
   * K Scan has already paid for.
   */
  const reuseUniverse = op !== null;
  const retained = reuseUniverse ? readCandidateUniverseEntry(universeKey, now) : null;
  let universe = (retained?.products ?? null) as Array<Record<string, unknown>> | null;
  /**
   * A universe this fresh was just fetched, so re-fetching it on exhaustion
   * would re-ask the same provider the same question and be billed for the
   * same answer. "That is everything I can currently find" is already the
   * honest reply; paying again to hear it is not.
   */
  const retainedIsFresh = retained !== null && retained.ageMs < EXHAUSTION_REFRESH_MIN_AGE_MS;

  // Context is loaded LAZILY, on the first retrieval that actually happens.
  // A turn answered entirely from the retained universe reads neither the
  // Closet nor the Signature Style profile — and a turn that does retrieve
  // always assembles the same evidence, so a cache-served shelf and a
  // freshly-fetched one were ranked from identical context.
  let contextLoaded = false;
  let closetItems: readonly ClosetContextItem[] | null = null;
  let styleTokens: readonly string[] | null = null;
  const loadContext = async (): Promise<void> => {
    if (contextLoaded) return;
    contextLoaded = true;
    const [items, tokens] = await Promise.all([
      input.deps.loadClosetItems?.().catch(() => null) ?? Promise.resolve(null),
      input.deps.loadSignatureStyleTokens?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    closetItems = items;
    styleTokens = tokens;
  };

  const retrieve = async (): Promise<void> => {
    await loadContext();
    const evidence = buildActivationEvidence({
      state: wire.state,
      actorId: input.actorId,
      closetItems,
      signatureStyleTokens: styleTokens,
    });
    if (!evidence) return;
    commerceCalls += 1;
    let result: CommerceHydrationResult | null = null;
    try {
      result = await input.deps.fetchCommerce(evidence);
    } catch {
      // `fetchDeferredCommerce` is documented never to throw; if a future
      // transport does, it is an ERROR state, never an empty shelf.
      result = null;
    }
    if (!result || result.status === 'error') { lookupFailed = true; return; }
    const verified = (result.purchaseOptions ?? [])
      .filter(hasCommerceProvenance) as Array<Record<string, unknown>>;
    universe = verified;
    writeCandidateUniverse(universeKey, verified, now);
  };

  // ── Reference: restore a product, never a commercial fact ────────────────
  if (op === 'reference') {
    return resolveReferenceTurn({
      wire, memory, actorId: input.actorId, ordinal: wire.memory?.ordinal ?? 0,
      scope: wire.memory?.scope ?? 'latest',
      priorShelfProducts: input.priorShelfProducts, universe, notices,
    });
  }

  if (op === 'not_those') {
    const rejection = rejectLatestShelf(memory);
    memory = rejection.memory;
    if (rejection.dropped > 0) notices.push('rejections_dropped');
  } else if (op === 'clear') {
    memory = clearRejections(memory);
    notices.push('rejections_cleared');
  }

  if (!universe || !universe.length) await retrieve();

  let selection = selectPresentedShelf({
    universe: universe ?? [], memory, op, limit: MAX_COMMERCE_CARDS,
  });

  // EXHAUSTION IS NOT FAILURE, and one refresh is the whole allowance. If the
  // retained universe has nothing left to offer, the live market may; if the
  // live market has nothing left either, that is an honest answer and not a
  // reason to keep asking a provider the same question.
  if (selection.exhausted && commerceCalls === 0 && !retainedIsFresh) {
    await retrieve();
    selection = selectPresentedShelf({
      universe: universe ?? [], memory, op, limit: MAX_COMMERCE_CARDS,
    });
  }

  if (selection.exhausted && lookupFailed) {
    // A lookup that failed is NOT "that is everything available". Saying so
    // would be inventing a fact about the market from a network error.
    const errorBlock = buildCommerceProductsBlock({
      result: null, state: wire.state, memoryOp: op, notices, hiddenCount: selection.hiddenCount,
    });
    return {
      blocks: [buildShoppingIntentBlock(wire, null, memory), errorBlock],
      status: 'error',
      needsBudgetReference: false,
      needsFormalityReference: wire.needsFormalityReference,
      commerceCalls,
      memoryOp: op,
      notices,
    };
  }

  const exhaustedByMemory = selection.exhausted && (selection.hiddenCount > 0 || activeExclusions(memory, op).length > 0);
  const productsBlock = buildCommerceProductsBlock({
    result: null,
    state: wire.state,
    products: selection.products,
    status: exhaustedByMemory ? 'exhausted' : 'no_matches',
    memoryOp: op,
    notices,
    hiddenCount: selection.hiddenCount,
  });

  // The shelf memory records what was ACTUALLY RENDERED, not what was asked
  // for: a remembered shelf that never reached the screen would make "the
  // first one" point at something the customer never saw.
  const nextMemory = productsBlock.status === 'results'
    ? recordShelf(memory, {
      turn: wire.state.turns,
      products: productsBlock.products,
      actorId: input.actorId,
    })
    : { ...memory, actorId: input.actorId };

  const shownPrices = productsBlock.status === 'results'
    ? extractShownPrices(productsBlock.products)
    : null;

  return {
    blocks: [buildShoppingIntentBlock(wire, shownPrices, nextMemory), productsBlock],
    status: productsBlock.status,
    needsBudgetReference: false,
    needsFormalityReference: wire.needsFormalityReference,
    commerceCalls,
    memoryOp: op,
    notices,
  };
}

/**
 * "Go back to the first pair."
 *
 * TWO SEPARATE QUESTIONS, ANSWERED SEPARATELY. Which product was that — a
 * deterministic lookup against verified persisted state, never a model
 * judgement. And is it still buyable — a question about NOW, which a
 * four-turn-old snapshot cannot answer. A restored identity is real; a
 * restored price is not evidence, and `revalidateRestoredProduct` is where the
 * difference is enforced: the live candidate universe replaces the row when it
 * still holds the offer, and strips every commercial claim when it does not.
 *
 * Costs ZERO provider calls. A reference is a presentation operation over
 * products K Scan has already shown, and spending a retrieval to re-answer it
 * would be charging the customer's latency budget for scrolling up.
 */
function resolveReferenceTurn(input: {
  wire: ShoppingIntentWire;
  memory: ShelfMemoryState;
  actorId: string | null;
  ordinal: number;
  scope: 'latest' | 'earliest';
  priorShelfProducts?: readonly Record<string, unknown>[] | null;
  universe: Array<Record<string, unknown>> | null;
  notices: CommerceBlockNotice[];
}): CommerceActivationOutcome {
  const { wire, memory, notices } = input;
  const outcome = resolveShelfReference<Record<string, unknown>>({
    memory,
    ordinal: input.ordinal,
    scope: input.scope,
    verifiedProducts: input.priorShelfProducts ?? [],
    actorId: input.actorId,
  });

  const fail = (notice: CommerceBlockNotice): CommerceActivationOutcome => {
    notices.push(notice);
    const block = buildCommerceProductsBlock({
      result: null, state: wire.state, products: [], status: 'no_matches',
      memoryOp: 'reference', notices,
    });
    return {
      blocks: [buildShoppingIntentBlock(wire, null, { ...memory, actorId: input.actorId }), block],
      status: block.status,
      needsBudgetReference: false,
      needsFormalityReference: wire.needsFormalityReference,
      commerceCalls: 0,
      memoryOp: 'reference',
      notices,
    };
  };

  if (outcome.reason === 'no_shelf') return fail('reference_no_shelf');
  if (outcome.reason === 'out_of_range') return fail('reference_out_of_range');
  // The identity is real but the evidence for it has aged out of the loaded
  // conversation. Say that; never reconstruct a product from prose.
  if (outcome.reason === 'expired' || !outcome.product) return fail('reference_expired');

  const revalidated = revalidateRestoredProduct(outcome.product, input.universe ?? []);
  if (!revalidated.currentTruth) notices.push('restored_not_transactable');

  const block = buildCommerceProductsBlock({
    result: null,
    state: wire.state,
    products: [revalidated.product],
    memoryOp: 'reference',
    notices,
  });

  return {
    // A restored product is NOT a new shelf: recording it would rewrite the
    // ordinals the customer is referring to, so "the first one" would start
    // meaning whatever they last looked at.
    blocks: [buildShoppingIntentBlock(wire, null, { ...memory, actorId: input.actorId }), block],
    status: block.status,
    needsBudgetReference: false,
    needsFormalityReference: wire.needsFormalityReference,
    commerceCalls: 0,
    memoryOp: 'reference',
    notices,
  };
}
