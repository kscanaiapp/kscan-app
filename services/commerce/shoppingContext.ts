/**
 * Client-side shopping-context assembly (Build 35).
 *
 * THE CONNECTION, NOT A NEW BRAIN. Everything this builds is context K Scan
 * already holds on the device: what the user just said, which Closet pieces
 * are close to this request, the Signature Style tokens, and a Packing gap
 * Packing itself already graded. It retrieves nothing, scores nothing, and
 * calls nothing — it describes the request so the ONE existing Commerce
 * ranker can take the user into account.
 *
 * NO NEW CALL OF ANY KIND. There is no model here and no second network
 * request: the assembled context rides the existing `commerce_only` body that
 * `commerceHydration.buildCommerceOnlyBody` already sends.
 *
 * ACTOR-BOUND CONTEXT IS STAMPED. Closet and Signature Style contributions
 * carry the actor they were read for, so the backend can reject them if the
 * authenticated user is somebody else. A contribution with no actor carries
 * nothing actor-bound.
 */

export type CommerceContextProvenance =
  | 'USER_EXPLICIT'
  | 'PACKING'
  | 'CONCIERGE'
  | 'SCANNER'
  | 'CLOSET'
  | 'SIGNATURE_STYLE'
  | 'DERIVED';

export interface CommerceContextContribution {
  provenance: CommerceContextProvenance;
  actorId?: string | null;
  category?: string;
  subtype?: string;
  color?: string;
  /**
   * How hard the customer asked for `color`. Meaningful only on a
   * USER_EXPLICIT contribution; the server re-validates it against a closed
   * enum and degrades anything else to ordinary preference.
   */
  colorStrength?: 'EXPLICIT_PREFERENCE' | 'STRONG_EXPLICIT_PREFERENCE';
  material?: string;
  silhouette?: string;
  pattern?: string;
  occasion?: string;
  formality?: string;
  functionalRequirements?: string[];
  budgetCeiling?: { amount: number; currency: string };
  exclusions?: Array<{ axis: 'material' | 'color' | 'attribute'; token: string }>;
  relevantOwned?: Array<{
    descriptor: string;
    category?: string | null;
    color?: string | null;
    material?: string | null;
  }>;
  matchIntent?: 'exact' | 'substitute';
  signatureStyleTokens?: string[];
  gapRelationship?: {
    gapCode: string;
    label: string;
    /** Packing's own word. This layer copies it; it never decides it. */
    certainty: 'confirmed' | 'unconfirmed';
  };
}

const MAX_OWNED = 6;
const MAX_TOKENS = 6;

function text(value: unknown, max = 60): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Closet pieces close enough to this request to matter.
 *
 * Deliberately shallow: a descriptor plus the three axes duplication actually
 * turns on. No item ids leave the device through this path, because ranking
 * does not need to know WHICH piece is owned — only that something like this
 * already is.
 */
export function closetContribution(input: {
  actorId: string | null;
  items: Array<{ title?: unknown; category?: unknown; color?: unknown; material?: unknown }>;
  /** Only items in this category are relevant to a request for this category. */
  category?: string | null;
}): CommerceContextContribution | null {
  const wanted = text(input.category).toLowerCase();
  const relevantOwned: NonNullable<CommerceContextContribution['relevantOwned']> = [];

  for (const item of input.items ?? []) {
    if (relevantOwned.length >= MAX_OWNED) break;
    const category = text(item?.category).toLowerCase();
    if (wanted && category && !category.includes(wanted) && !wanted.includes(category)) continue;
    const descriptor = text(item?.title, 80).toLowerCase();
    if (!descriptor) continue;
    relevantOwned.push({
      descriptor,
      category: category || null,
      color: text(item?.color).toLowerCase() || null,
      material: text(item?.material).toLowerCase() || null,
    });
  }

  if (!relevantOwned.length) return null;
  return { provenance: 'CLOSET', actorId: input.actorId, relevantOwned };
}

/**
 * Signature Style as a PREFERENCE contribution.
 *
 * It never becomes a constraint and never carries a budget or an exclusion —
 * the stylist promise is that a stated request outranks an inferred
 * preference, and the only way to keep that promise at ranking time is for the
 * inferred half to arrive with the weakest provenance it can.
 */
export function signatureStyleContribution(input: {
  actorId: string | null;
  tokens: unknown[];
}): CommerceContextContribution | null {
  const signatureStyleTokens: string[] = [];
  for (const raw of input.tokens ?? []) {
    const token = text(raw, 32).toLowerCase();
    if (!token || signatureStyleTokens.includes(token)) continue;
    signatureStyleTokens.push(token);
    if (signatureStyleTokens.length >= MAX_TOKENS) break;
  }
  if (!signatureStyleTokens.length) return null;
  return { provenance: 'SIGNATURE_STYLE', actorId: input.actorId, signatureStyleTokens };
}

/**
 * A Packing gap, as a Commerce contribution.
 *
 * Certainty is copied, never computed, and never upgraded: `PackingGapV2` is
 * the authority on whether an absence was proven, and finding a product is not
 * evidence about a wardrobe. A caller that only has the client-side
 * `PackingExternalSuggestion` shape (which exists only for CONFIRMED gaps)
 * should pass `certainty: 'confirmed'` — that is a fact about which gaps that
 * type is emitted for, not an assumption about this one.
 */
export function packingGapContribution(input: {
  gapCode: unknown;
  label: unknown;
  certainty: unknown;
}): CommerceContextContribution | null {
  const gapCode = text(input.gapCode, 60);
  const label = text(input.label, 80);
  const certainty = input.certainty;
  if (!gapCode || !label) return null;
  if (certainty !== 'confirmed' && certainty !== 'unconfirmed') return null;
  return { provenance: 'PACKING', gapRelationship: { gapCode, label, certainty } };
}

/**
 * Assemble the contributions for one request.
 *
 * Returns null when nothing usable came back, so a caller can omit the field
 * entirely and get the pre-Build-35 request body byte for byte — which is what
 * keeps the zero-context fast path genuinely free.
 */
export function buildShoppingContext(
  contributions: Array<CommerceContextContribution | null | undefined>,
): CommerceContextContribution[] | null {
  const out = contributions.filter(
    (c): c is CommerceContextContribution => Boolean(c) && typeof c === 'object',
  );
  return out.length ? out.slice(0, 8) : null;
}
