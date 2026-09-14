/**
 * Shelf memory — what Commerce already showed this customer (Commerce V2).
 *
 * THE ONE QUESTION THIS ANSWERS. "Which verified Commerce products did I show
 * this customer during this active shopping task?" Nothing else. It is not
 * ownership, not the Watchlist, not the Closet, not analytics history, and not
 * a cross-session retail profile — the Closet remains the only authority on
 * what someone owns, and being SHOWN a product has never made anyone own it.
 *
 * MEMORY IS NOT A SCORE. Every operation here is a deterministic result-set
 * operation over candidates the ONE ranker already ordered. There is no
 * `seenPenalty`, no `freshnessPenalty`, no novelty weight, and no second
 * ordering authority: "different" removes exact identities and "another" takes
 * the next unseen candidate, both leaving the surviving order exactly as the
 * ranker produced it. A ranking system that quietly learns to avoid what it
 * showed is a second ranker wearing a memory costume.
 *
 * TWO VALIDATIONS, NOT ONE. The reducer in `eliseCommerceIntent.ts` owns what
 * is PERSISTED; this module re-validates everything on the way back in, the
 * same way `parseShoppingIntentWire` already re-validates the intent the server
 * authored. A client that trusts a shape it did not check is one deploy skew
 * from acting on nonsense, and shelf state is the one place where acting on
 * nonsense could put the wrong product in front of someone.
 *
 * WHERE THE STATE LIVES. Inside the existing `commerce_shopping_intent`
 * ui_block, alongside the intent it belongs to. No new table, no new column,
 * no migration — and it inherits the conversation's deletion lifecycle for
 * free, which is the only acceptable answer to "how is this deleted?".
 */

import {
  hasCommerceProvenance,
  isShelfIdentity,
  productShelfIdentity,
  shelfIdentities,
} from '../commerce/productIdentity.ts';

/**
 * Bounds. Every one of these caps state that is restored from a persisted
 * block and could therefore arrive oversized.
 */
export const SHELF_MEMORY_LIMITS = {
  /** Shelves whose ORDER is still resolvable ("the first one"). */
  maxShelves: 3,
  /** Cards one shelf may remember. Matches `MAX_COMMERCE_CARDS`. */
  maxProductsPerShelf: 6,
  /** Hard ceiling across all remembered shelves. */
  maxTotalProductReferences: 18,
  /** Active task-scoped product rejections ("not those"). */
  maxActiveExclusions: 24,
} as const;

/** The conversational memory operations. A closed set, and only these. */
export type ShelfMemoryOp = 'different' | 'another' | 'not_those' | 'reference' | 'clear';

export interface RememberedShelf {
  /** The intent turn this shelf was shown on. Diagnostics and ordering only. */
  turn: number;
  /** Verified product identities, in the order they were rendered. */
  items: string[];
}

export interface ShelfMemoryState {
  /**
   * Who these shelves were shown to.
   *
   * ACTOR ISOLATION IS A GATE, NOT A FILTER. A memory whose actor does not
   * match the live one is discarded whole rather than trimmed — a partially
   * retained foreign shelf is still foreign, and the failure it would produce
   * (one account's shopping restored into another's conversation) is exactly
   * the one worth refusing outright.
   */
  actorId: string | null;
  /** Newest first. */
  shelves: RememberedShelf[];
  /** Identities the customer explicitly rejected in this task. */
  rejected: string[];
  /**
   * True once a shelf has aged out of the bounds above.
   *
   * It exists so that "go back to the first pair" can FAIL HONESTLY. Without
   * it, the oldest shelf still in memory would silently impersonate the task's
   * first shelf, and a backward reference would resolve confidently to a
   * product that was not the one being referred to. A wrong product shown with
   * confidence is worse than admitting the earlier options are gone.
   */
  truncated?: boolean;
}

export function emptyShelfMemory(): ShelfMemoryState {
  return { actorId: null, shelves: [], rejected: [], truncated: false };
}

export function isEmptyShelfMemory(memory: ShelfMemoryState | null | undefined): boolean {
  return !memory || (memory.shelves.length === 0 && memory.rejected.length === 0);
}

// ── Restore (untrusted: persisted, client-authored, possibly edited) ────────

function boundedIdentities(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= max) break;
    if (!isShelfIdentity(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Rebuild shelf memory field by field from whatever the block carried.
 *
 * Anything that is not an identity token of the exact expected shape is
 * dropped rather than coerced, so a forged or corrupted block degrades to LESS
 * memory and can never name a product that was not shown. Identities alone
 * still cannot produce a card: resolution additionally requires the identity
 * to match a persisted, provenance-verified Commerce product (see
 * `resolveShelfReference`).
 */
export function parseShelfMemory(raw: unknown): ShelfMemoryState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  const memory = emptyShelfMemory();
  memory.actorId = typeof rec.actorId === 'string' && rec.actorId.trim()
    ? rec.actorId.trim().slice(0, 80)
    : null;

  let total = 0;
  if (Array.isArray(rec.shelves)) {
    for (const entry of rec.shelves) {
      if (memory.shelves.length >= SHELF_MEMORY_LIMITS.maxShelves) break;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const shelf = entry as Record<string, unknown>;
      const remaining = SHELF_MEMORY_LIMITS.maxTotalProductReferences - total;
      if (remaining <= 0) break;
      const items = boundedIdentities(
        shelf.items,
        Math.min(SHELF_MEMORY_LIMITS.maxProductsPerShelf, remaining),
      );
      if (!items.length) continue;
      const turn = typeof shelf.turn === 'number' && Number.isFinite(shelf.turn)
        ? Math.max(0, Math.floor(shelf.turn))
        : 0;
      memory.shelves.push({ turn, items });
      total += items.length;
    }
  }

  memory.rejected = boundedIdentities(rec.rejected, SHELF_MEMORY_LIMITS.maxActiveExclusions);
  memory.truncated = rec.truncated === true;
  return memory;
}

/**
 * May this memory be used for the live actor?
 *
 * An untagged memory (no actor recorded) is usable by whoever is asking, for
 * the same reason `intentMatchesActor` accepts a null-actor intent: it was
 * never bound to anyone. A TAGGED memory is usable only by that actor —
 * including when the live request is anonymous, so "signed out" cannot become
 * the one state in which another account's shelf reappears.
 */
export function shelfMemoryMatchesActor(
  memory: ShelfMemoryState | null | undefined,
  actorId: string | null,
): boolean {
  if (!memory) return false;
  if (memory.actorId === null) return true;
  return memory.actorId === actorId;
}

/** Usable memory for this actor, or empty memory. Never another actor's. */
export function shelfMemoryForActor(
  memory: ShelfMemoryState | null | undefined,
  actorId: string | null,
): ShelfMemoryState {
  if (!memory || !shelfMemoryMatchesActor(memory, actorId)) return emptyShelfMemory();
  return memory;
}

// ── Writing the memory forward ─────────────────────────────────────────────

/** Record the shelf that was actually rendered this turn. Copy-on-write. */
export function recordShelf(
  memory: ShelfMemoryState | null | undefined,
  input: { turn: number; products: readonly unknown[]; actorId: string | null },
): ShelfMemoryState {
  const base = memory ?? emptyShelfMemory();
  const items = shelfIdentities(input.products).slice(0, SHELF_MEMORY_LIMITS.maxProductsPerShelf);
  const shelves = items.length
    ? [{ turn: input.turn, items }, ...base.shelves]
    : [...base.shelves];

  // Oldest shelves drop first, by both bounds. A shelf that ages out is GONE,
  // not summarised: a half-remembered shelf would let an ordinal resolve to
  // the wrong product, which is worse than admitting the options are no longer
  // available (see the `expired` reason below).
  const kept: RememberedShelf[] = [];
  let total = 0;
  for (const shelf of shelves) {
    if (kept.length >= SHELF_MEMORY_LIMITS.maxShelves) break;
    if (total + shelf.items.length > SHELF_MEMORY_LIMITS.maxTotalProductReferences) break;
    kept.push({ turn: shelf.turn, items: [...shelf.items] });
    total += shelf.items.length;
  }

  return {
    actorId: input.actorId,
    shelves: kept,
    rejected: [...base.rejected],
    truncated: base.truncated === true || kept.length < shelves.length,
  };
}

/**
 * "Not those" — reject exactly the products on the most recent shelf.
 *
 * EXACT IDENTITIES ONLY. It does not infer that the customer dislikes the
 * brand, the retailer, the colour, the material or the style. Someone who says
 * "not those" about four black loafers has rejected four listings, and turning
 * that into "no black" or "nothing from that retailer" would invent a
 * preference they never stated and then hide the market behind it.
 */
export function rejectLatestShelf(
  memory: ShelfMemoryState | null | undefined,
): { memory: ShelfMemoryState; rejectedCount: number; dropped: number } {
  const base = memory ?? emptyShelfMemory();
  const latest = base.shelves[0];
  if (!latest || !latest.items.length) {
    return { memory: base, rejectedCount: 0, dropped: 0 };
  }

  const merged = [...base.rejected];
  let added = 0;
  for (const identity of latest.items) {
    if (merged.includes(identity)) continue;
    merged.push(identity);
    added += 1;
  }

  // The bound is real, so overflow has to do something honest. The OLDEST
  // rejections are dropped rather than the newest refused, because the
  // customer's most recent "not those" is the one they are watching for — but
  // a dropped rejection means a product they rejected can legitimately come
  // back, and the caller is told so it can say that rather than look broken.
  const overflow = Math.max(0, merged.length - SHELF_MEMORY_LIMITS.maxActiveExclusions);
  const rejected = overflow ? merged.slice(overflow) : merged;

  return {
    memory: {
      actorId: base.actorId,
      shelves: base.shelves.map((s) => ({ ...s, items: [...s.items] })),
      rejected,
      truncated: base.truncated === true,
    },
    rejectedCount: added,
    dropped: overflow,
  };
}

/** "Show me everything again" — drop the rejections, keep the shelf order. */
export function clearRejections(memory: ShelfMemoryState | null | undefined): ShelfMemoryState {
  const base = memory ?? emptyShelfMemory();
  return {
    actorId: base.actorId,
    shelves: base.shelves.map((s) => ({ ...s, items: [...s.items] })),
    rejected: [],
    truncated: base.truncated === true,
  };
}

// ── Selection ──────────────────────────────────────────────────────────────

/**
 * The identities this turn must not present.
 *
 * "Different" is turn-scoped — it means "not the ones you just showed me" —
 * so it excludes the MOST RECENT shelf only. "Another" is task-scoped: asking
 * for one more option and being handed something already rejected is not
 * another option. Rejections from "not those" apply to every turn in the task
 * until the customer clears them, because they were an instruction, not a mood.
 */
export function activeExclusions(
  memory: ShelfMemoryState | null | undefined,
  op: ShelfMemoryOp | null,
): string[] {
  const base = memory ?? emptyShelfMemory();
  const out = new Set<string>(base.rejected);
  if (op === 'different') {
    for (const identity of base.shelves[0]?.items ?? []) out.add(identity);
  } else if (op === 'another') {
    for (const shelf of base.shelves) for (const identity of shelf.items) out.add(identity);
  }
  return [...out];
}

export interface ShelfSelection<T> {
  products: T[];
  /** Every eligible candidate was excluded. NOT the same as a lookup failure. */
  exhausted: boolean;
  /** How many candidates the active exclusions removed, for honest copy. */
  hiddenCount: number;
}

/**
 * Choose what to present from the candidate universe the ranker produced.
 *
 * ORDER IS THE RANKER'S. Within each partition the candidates keep exactly the
 * positions `filterAndDedupeProducts` gave them. The only thing this does is
 * remove excluded identities and, on an explicit memory request, put
 * never-seen candidates ahead of already-seen ones — a stable partition of a
 * finished ranking, not a re-ranking, and it happens only when the customer
 * actually asked for something they have not seen.
 */
export function selectPresentedShelf<T>(input: {
  universe: readonly T[] | null | undefined;
  memory: ShelfMemoryState | null | undefined;
  op: ShelfMemoryOp | null;
  limit: number;
}): ShelfSelection<T> {
  const universe = Array.isArray(input.universe) ? input.universe : [];
  const memory = input.memory ?? emptyShelfMemory();
  const exclusions = new Set(activeExclusions(memory, input.op));

  const eligible: T[] = [];
  let hiddenCount = 0;
  for (const product of universe) {
    const identity = productShelfIdentity(product);
    if (identity && exclusions.has(identity)) { hiddenCount += 1; continue; }
    eligible.push(product);
  }

  const limit = input.op === 'another' ? 1 : Math.max(1, input.limit);

  let ordered = eligible;
  if (input.op === 'different' || input.op === 'another') {
    const seen = new Set<string>();
    for (const shelf of memory.shelves) for (const identity of shelf.items) seen.add(identity);
    const unseen: T[] = [];
    const alreadySeen: T[] = [];
    for (const product of eligible) {
      const identity = productShelfIdentity(product);
      (identity && seen.has(identity) ? alreadySeen : unseen).push(product);
    }
    ordered = [...unseen, ...alreadySeen];
  }

  const products = ordered.slice(0, limit);
  return { products, exhausted: products.length === 0, hiddenCount };
}

// ── Reference resolution ("go back to the first one") ──────────────────────

export type ShelfReferenceReason = 'resolved' | 'no_shelf' | 'out_of_range' | 'expired';

export interface ShelfReferenceOutcome<T> {
  reason: ShelfReferenceReason;
  product: T | null;
  identity: string | null;
}

/**
 * Resolve a structured ordinal against a remembered shelf.
 *
 * THE MODEL DOES NOT DECIDE WHICH PRODUCT THIS WAS. It may understand "the
 * first one"; deterministic K Scan state decides which real product that
 * actually was, and the decision is made twice over: the ordinal selects a
 * stored IDENTITY, and that identity must then match a product that is still
 * present in a persisted, provenance-verified Commerce block. A state naming
 * an identity no verified block contains resolves to nothing — which is what
 * makes a forged or edited shelf state unable to mint a product reference.
 *
 * `verifiedProducts` must come from persisted `commerce_products` blocks for
 * the live session; those rows are already actor-scoped by the RLS-bound read
 * that loaded them, so ownership of the evidence is inherited rather than
 * re-derived here.
 */
export function resolveShelfReference<T>(input: {
  memory: ShelfMemoryState | null | undefined;
  ordinal: number;
  /**
   * `latest` for a bare ordinal ("the second one" — of what you just showed).
   * `earliest` for a backward reference ("go back to the first pair" — of what
   * you showed me at the start of this task).
   */
  scope?: 'latest' | 'earliest';
  verifiedProducts: readonly T[] | null | undefined;
  actorId: string | null;
}): ShelfReferenceOutcome<T> {
  const memory = shelfMemoryForActor(input.memory, input.actorId);
  if (!memory.shelves.length) return { reason: 'no_shelf', product: null, identity: null };

  // A backward reference against a memory that has already dropped a shelf
  // cannot be answered: the oldest shelf still held is NOT the one being
  // referred to, and resolving it anyway would be a confident wrong answer.
  if (input.scope === 'earliest' && memory.truncated === true) {
    return { reason: 'expired', product: null, identity: null };
  }

  const shelf = input.scope === 'earliest'
    ? memory.shelves[memory.shelves.length - 1]
    : memory.shelves[0];
  if (!shelf || !shelf.items.length) return { reason: 'no_shelf', product: null, identity: null };

  const ordinal = Math.floor(input.ordinal);
  if (!Number.isFinite(ordinal) || ordinal < 1 || ordinal > shelf.items.length) {
    return { reason: 'out_of_range', product: null, identity: null };
  }

  const identity = shelf.items[ordinal - 1];
  const candidates = Array.isArray(input.verifiedProducts) ? input.verifiedProducts : [];
  for (const candidate of candidates) {
    if (!hasCommerceProvenance(candidate)) continue;
    if (productShelfIdentity(candidate) !== identity) continue;
    return { reason: 'resolved', product: candidate, identity };
  }
  // The identity is real but the evidence for it is gone — an aged-out block,
  // a truncated history. Say so; never reconstruct a product from prose.
  return { reason: 'expired', product: null, identity };
}

/**
 * Bring a restored product's COMMERCIAL FACTS up to date before it is shown.
 *
 * A prior product IDENTITY may be restored. Its prior commercial facts may
 * not: a price, a stock state or a sale that was true four turns ago is not
 * evidence about now, and re-rendering one would be K Scan asserting a fact it
 * has not checked.
 *
 * When the live candidate universe still contains the same offer, that row IS
 * current truth and replaces the stored one wholesale. When it does not, the
 * identity survives and every commercial claim is stripped: no price, no
 * currency, no availability, no stale rationale, and `BROWSE_ONLY`, which the
 * existing transaction floor already reads as "this may be opened but must not
 * offer a purchase".
 */
export function revalidateRestoredProduct<T extends Record<string, unknown>>(
  stored: T,
  universe: readonly T[] | null | undefined,
): { product: Record<string, unknown>; currentTruth: boolean } {
  const identity = productShelfIdentity(stored);
  const candidates = Array.isArray(universe) ? universe : [];
  for (const candidate of candidates) {
    if (identity && productShelfIdentity(candidate) === identity) {
      return { product: candidate, currentTruth: true };
    }
  }

  const clone: Record<string, unknown> = { ...stored };
  delete clone.price;
  delete clone.currency;
  delete clone.availability;
  delete clone.commerceRationale;
  delete clone.recommendationLabel;
  clone.commercialUsability = 'BROWSE_ONLY';
  return { product: clone, currentTruth: false };
}

// ── Candidate universe retention ───────────────────────────────────────────
//
// THE UNIVERSE IS NOT THE SHELF. The universe is every real candidate the
// ranker returned for this task's retrieval; the shelf is the bounded subset
// currently rendered. Keeping the universe is what lets "different" and
// "another" answer from candidates K Scan has ALREADY PAID FOR instead of
// spending a provider call to re-fetch the same market.
//
// Deliberately IN-MEMORY and never persisted: it is a retrieval cache, not
// customer state. It dies with the process, it is capped, it expires, and
// there is consequently no orphaned store for an account deletion to miss.

interface UniverseEntry {
  products: unknown[];
  storedAt: number;
}

/** Mirrors the server commerce cache TTL: the same market, the same staleness. */
export const CANDIDATE_UNIVERSE_TTL_MS = 10 * 60 * 1000;
export const CANDIDATE_UNIVERSE_MAX_ENTRIES = 8;

const universeStore = new Map<string, UniverseEntry>();

/**
 * The retention key.
 *
 * DERIVED FROM THE RETRIEVAL, NEVER FROM THE MEMORY. Product exclusions are
 * deliberately absent: "show me different ones" must reuse the universe it
 * already has rather than force a miss, and mixing exclusions into a retrieval
 * key is precisely how a memory feature quietly doubles provider spend.
 */
export function candidateUniverseKey(input: {
  actorId: string | null;
  category: string | null;
  color: string | null;
  material: string | null;
  silhouette: string | null;
  formality: string | null;
  budget: { amount: number; currency: string } | null;
  exclusions: ReadonlyArray<{ axis: string; token: string }>;
  functionalRequirements: readonly string[];
}): string {
  const parts = [
    `a=${input.actorId ?? ''}`,
    `c=${input.category ?? ''}`,
    `col=${input.color ?? ''}`,
    `mat=${input.material ?? ''}`,
    `sil=${input.silhouette ?? ''}`,
    `for=${input.formality ?? ''}`,
    `b=${input.budget ? `${input.budget.amount}:${input.budget.currency}` : ''}`,
    `ex=${[...input.exclusions].map((e) => `${e.axis}:${e.token}`).sort().join(',')}`,
    `fn=${[...input.functionalRequirements].sort().join(',')}`,
  ];
  return parts.join('|');
}

export function readCandidateUniverse(key: string, now: number = Date.now()): unknown[] | null {
  const entry = universeStore.get(key);
  if (!entry) return null;
  if (now - entry.storedAt >= CANDIDATE_UNIVERSE_TTL_MS) {
    universeStore.delete(key);
    return null;
  }
  return entry.products;
}

export function writeCandidateUniverse(key: string, products: readonly unknown[], now: number = Date.now()): void {
  if (!Array.isArray(products) || !products.length) return;
  for (const [existing, entry] of universeStore) {
    if (now - entry.storedAt >= CANDIDATE_UNIVERSE_TTL_MS) universeStore.delete(existing);
  }
  if (!universeStore.has(key) && universeStore.size >= CANDIDATE_UNIVERSE_MAX_ENTRIES) {
    const oldest = universeStore.keys().next();
    if (!oldest.done) universeStore.delete(oldest.value);
  }
  universeStore.set(key, { products: [...products], storedAt: now });
}

/** Test seam, and the signed-out reset. Never called from the request path. */
export function clearCandidateUniverses(): void {
  universeStore.clear();
}

export function candidateUniverseSize(): number {
  return universeStore.size;
}
