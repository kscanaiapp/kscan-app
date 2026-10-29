import {
  hasVerifiedOwnership,
  type OwnershipIdentity,
  type SecondaryInput,
  type SecondaryResponse,
} from './blackOwnedDiscovery';

/**
 * Host-side glue between the live Scan Results surface and the independent
 * secondary discovery request. Pure functions only, so the ordering, privacy
 * and identity rules are testable without rendering.
 *
 * - The request is built from structured garment attributes. The scan photo,
 *   analysis prose and conversation never enter it.
 * - Primary products contribute only their id and canonical product URL.
 * - Ownership metadata is a read-only map keyed by primary product id; it never
 *   reorders, rewrites or reclassifies a primary card.
 */

/** Approved V1 market. Authorized merchant inventory is US-only today. */
export const BLACK_OWNED_DISCOVERY_MARKET = 'US';

const MAX_PRIMARY = 30;
const MAX_FEATURES = 8;

type PrimaryLike = { id?: string | null; productUrl?: string | null };

type AnalysisLike = {
  type?: string;
  metadata?: {
    category?: string;
    primaryItem?: string;
    itemType?: string;
    color?: string;
    silhouette?: string;
    material?: string;
    materialEstimate?: string;
    pattern?: string;
  } | null;
  identificationSnapshot?: {
    category?: string | null;
    subtype?: string | null;
    colors?: { primary?: string | null; secondary?: string[] | null } | null;
    material?: string[] | null;
    silhouette?: string[] | null;
    pattern?: string[] | null;
    attributes?: { distinctive?: string[] | null } | null;
  } | null;
  commerceDeferred?: boolean;
  confirmationCandidates?: unknown[];
} | null | undefined;

/** Mirrors the server's text rule; an invalid value is dropped, not sent. */
function clean(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f<>]/.test(trimmed)) return undefined;
  return trimmed;
}

function first(values: unknown): string | undefined {
  return Array.isArray(values) ? clean(values[0]) : undefined;
}

/** "black, white" (legacy display join) → "black". */
function firstColor(value: unknown): string | undefined {
  return typeof value === 'string' ? clean(value.split(',')[0]) : undefined;
}

/**
 * Primary commerce is settled when nothing more is coming for the displayed
 * item: deferred commerce reached a terminal status, or the scan carried its
 * products inline. Pending deferred commerce is never settled.
 */
export function isPrimaryCommerceSettled(
  analysis: AnalysisLike,
  commerceStatus: 'idle' | 'pending' | 'success' | 'empty' | 'error' | undefined,
): boolean {
  if (!analysis || analysis.type === 'non-fashion') return false;
  if (Array.isArray(analysis.confirmationCandidates) && analysis.confirmationCandidates.length > 0) return false;
  if (analysis.commerceDeferred) return commerceStatus === 'success' || commerceStatus === 'empty' || commerceStatus === 'error';
  return true;
}

/** Ordered, de-duplicated {id, productUrl} identities of the rendered primary cards. */
export function primaryIdentities(...groups: (PrimaryLike[] | null | undefined)[]): { id: string; productUrl?: string }[] {
  const out: { id: string; productUrl?: string }[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const product of group ?? []) {
      const id = clean(product?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const url = typeof product?.productUrl === 'string' && product.productUrl.length <= 2048 ? product.productUrl : undefined;
      out.push(url ? { id, productUrl: url } : { id });
      if (out.length >= MAX_PRIMARY) return out;
    }
  }
  return out;
}

/** Sanitized request, or null when there is no structured category to match. */
export function buildBlackOwnedDiscoveryInput(
  analysis: AnalysisLike,
  primaryProducts: { id: string; productUrl?: string }[],
): SecondaryInput | null {
  if (!analysis) return null;
  const snap = analysis.identificationSnapshot ?? null;
  const meta = analysis.metadata ?? null;
  const itemType = clean(snap?.category) ?? clean(meta?.category);
  if (!itemType) return null;
  const garment: SecondaryInput['garment'] = { item_type: itemType };
  const subtype = clean(snap?.subtype) ?? clean(meta?.itemType) ?? clean(meta?.primaryItem);
  if (subtype && subtype.toLowerCase() !== itemType.toLowerCase()) garment.subtype = subtype;
  const primaryColor = clean(snap?.colors?.primary) ?? firstColor(meta?.color);
  if (primaryColor) garment.primary_color = primaryColor;
  const secondaryColor = first(snap?.colors?.secondary);
  if (secondaryColor) garment.secondary_color = secondaryColor;
  const material = first(snap?.material) ?? clean(meta?.materialEstimate) ?? clean(meta?.material);
  if (material) garment.material_estimate = material;
  const silhouette = first(snap?.silhouette) ?? clean(meta?.silhouette);
  if (silhouette) garment.silhouette = silhouette;
  const pattern = first(snap?.pattern) ?? clean(meta?.pattern);
  if (pattern) garment.pattern = pattern;
  const features = (snap?.attributes?.distinctive ?? [])
    .map((value) => clean(value, 80))
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_FEATURES);
  if (features.length) garment.distinctive_features = features;
  return { garment, market: BLACK_OWNED_DISCOVERY_MARKET, primaryProducts: primaryProducts.slice(0, MAX_PRIMARY) };
}

/** Stable key so an equivalent request is not re-issued on every render. */
export function discoveryRequestKey(input: SecondaryInput | null): string | null {
  return input ? JSON.stringify(input) : null;
}

/** Only verified, current, publicly permitted identities for the given ids. */
export function primaryOwnershipById(
  response: SecondaryResponse | undefined,
  primaryIds: string[],
  now = Date.now(),
): Record<string, OwnershipIdentity> {
  const out: Record<string, OwnershipIdentity> = {};
  const map = response?.primaryOwnership;
  if (!map || typeof map !== 'object') return out;
  for (const id of primaryIds) {
    const identity = Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
    if (hasVerifiedOwnership(identity, now)) out[id] = identity!;
  }
  return out;
}

/**
 * Secondary products safe to display beside the primary results: organic only,
 * never a product already shown as a primary card (by id or exact URL).
 */
export function displayableSecondary(
  response: SecondaryResponse | undefined,
  primary: { id: string; productUrl?: string }[],
): SecondaryResponse | undefined {
  if (!response || response.status !== 'ready' || !Array.isArray(response.products)) return undefined;
  const ids = new Set(primary.map((p) => p.id));
  const urls = new Set(primary.map((p) => p.productUrl).filter((u): u is string => Boolean(u)).map((u) => u.split('#')[0]));
  const seen = new Set<string>();
  const products = response.products.filter((p) => {
    if (!p || p.placementType !== 'organic' || ids.has(p.id) || seen.has(p.id)) return false;
    if (p.productUrl && urls.has(p.productUrl.split('#')[0])) return false;
    seen.add(p.id);
    return true;
  });
  return products.length ? { ...response, products } : undefined;
}
