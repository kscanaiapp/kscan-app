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
  budget: { amount: number; currency: string } | null;
  exclusions: Array<{ axis: 'material' | 'color'; token: string }>;
  functionalRequirements: string[];
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
  if (input.state?.color) explicit.color = input.state.color;
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

export type CommerceBlockStatus = 'results' | 'no_matches' | 'error';

export interface CommerceProductsBlock extends StyleChatUiBlock {
  type: typeof COMMERCE_PRODUCTS_BLOCK_TYPE;
  status: CommerceBlockStatus;
  products: Array<Record<string, unknown>>;
  /** Echoed so a stale block can be told from a current one. */
  intentSummary: {
    category: string | null;
    color: string | null;
    budget: { amount: number; currency: string } | null;
    exclusions: string[];
  };
}

/**
 * Does this product carry proof that a real Commerce result produced it?
 *
 * Section 24: fabrication has to be mechanically detectable, not a matter of
 * trust. A card may render only for an object that came back from the
 * Commerce path carrying the fields that path assigns — a destination URL and
 * a title it did not invent. `commerceRationale` is the strongest signal
 * (server-authored by #409's ranker), but it is only present on a contextual
 * turn, so the destination URL is the floor.
 */
export function hasCommerceProvenance(product: unknown): boolean {
  if (!product || typeof product !== 'object') return false;
  const rec = product as Record<string, unknown>;
  const url = typeof rec.productUrl === 'string' ? rec.productUrl.trim() : '';
  const title = typeof rec.title === 'string' ? rec.title.trim() : '';
  if (!url || !title) return false;
  // The transport drops any entry without both, so anything lacking them did
  // not come through it.
  return /^https?:\/\//i.test(url);
}

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
}): CommerceProductsBlock {
  const intentSummary = {
    category: input.state?.category ?? null,
    color: input.state?.color ?? null,
    budget: input.state?.budget ? { ...input.state.budget } : null,
    exclusions: (input.state?.exclusions ?? []).map((e) => `${e.axis}:${e.token}`),
  };

  const result = input.result;
  if (!result || result.status === 'error') {
    return {
      type: COMMERCE_PRODUCTS_BLOCK_TYPE,
      status: 'error',
      products: [],
      intentSummary,
    };
  }

  const verified = (result.purchaseOptions ?? [])
    .filter(hasCommerceProvenance)
    .slice(0, MAX_COMMERCE_CARDS) as Array<Record<string, unknown>>;

  return {
    type: COMMERCE_PRODUCTS_BLOCK_TYPE,
    status: verified.length > 0 ? 'results' : 'no_matches',
    products: verified,
    intentSummary,
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
}

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

  return {
    blockType: 'commerce_shopping_intent',
    state: {
      stateVersion: 1,
      category,
      color,
      budget,
      exclusions,
      functionalRequirements,
      turns,
      lastShownPrices: (st as { lastShownPrices?: unknown }).lastShownPrices ?? null,
    },
    needsBudgetReference: rec.needsBudgetReference === true,
  };
}

/** The intent block persisted alongside the assistant message. */
export function buildShoppingIntentBlock(
  wire: ShoppingIntentWire,
  shownPrices: { currency: string; amounts: number[] } | null,
): StyleChatUiBlock {
  return {
    type: 'commerce_shopping_intent',
    state: {
      ...wire.state,
      // Recorded from the shelf THIS turn actually showed, so next turn's
      // "cheaper" has a concrete reference instead of a guess.
      lastShownPrices: shownPrices,
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
  /** Provider-facing Commerce invocations this activation made. */
  commerceCalls: number;
}

export interface CommerceActivationDeps {
  fetchCommerce: (evidence: CommerceHydrationEvidence) => Promise<CommerceHydrationResult>;
  loadClosetItems?: () => Promise<readonly ClosetContextItem[] | null>;
  loadSignatureStyleTokens?: () => Promise<readonly string[] | null>;
}

/**
 * Run one activated shopping turn.
 *
 * EXACTLY ONE Commerce invocation, or zero. There is no retry loop and no
 * second pass: a turn that produced one `find_products` action produces one
 * request, which is what keeps provider cost proportional to customer intent.
 *
 * Context loads are best-effort. A Closet read that fails must not fail the
 * shopping request — it degrades to a request with less context, which is
 * exactly what a customer with an empty Closet already gets.
 */
export async function runCommerceActivation(input: {
  wire: ShoppingIntentWire | null;
  actorId: string | null;
  deps: CommerceActivationDeps;
}): Promise<CommerceActivationOutcome> {
  const wire = input.wire;
  if (!wire) {
    return { blocks: [], status: 'skipped', needsBudgetReference: false, commerceCalls: 0 };
  }

  // A relative request with no reference is a QUESTION, not a search. Firing a
  // provider call on an invented ceiling would spend money to answer something
  // the customer has not said yet.
  if (wire.needsBudgetReference) {
    return {
      blocks: [buildShoppingIntentBlock(wire, null)],
      status: 'skipped',
      needsBudgetReference: true,
      commerceCalls: 0,
    };
  }

  const [closetItems, styleTokens] = await Promise.all([
    input.deps.loadClosetItems?.().catch(() => null) ?? Promise.resolve(null),
    input.deps.loadSignatureStyleTokens?.().catch(() => null) ?? Promise.resolve(null),
  ]);

  const evidence = buildActivationEvidence({
    state: wire.state,
    actorId: input.actorId,
    closetItems,
    signatureStyleTokens: styleTokens,
  });

  if (!evidence) {
    return {
      blocks: [buildShoppingIntentBlock(wire, null)],
      status: 'skipped',
      needsBudgetReference: false,
      commerceCalls: 0,
    };
  }

  let result: CommerceHydrationResult | null = null;
  try {
    result = await input.deps.fetchCommerce(evidence);
  } catch {
    // `fetchDeferredCommerce` is documented never to throw; if a future
    // transport does, it is an ERROR state, never an empty shelf.
    result = null;
  }

  const productsBlock = buildCommerceProductsBlock({ result, state: wire.state });
  const shownPrices = productsBlock.status === 'results'
    ? extractShownPrices(productsBlock.products)
    : null;

  return {
    blocks: [buildShoppingIntentBlock(wire, shownPrices), productsBlock],
    status: productsBlock.status,
    needsBudgetReference: false,
    commerceCalls: 1,
  };
}
