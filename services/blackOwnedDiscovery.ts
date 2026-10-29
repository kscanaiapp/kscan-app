/** Additive V1 consumer contract. No import from server-only Supabase modules. */
export type OwnershipIdentity = {
  brandId: string; brandName: string; ownershipVerificationStatus: 'verified';
  publicOwnershipLabelAllowed: true; verifiedUntil: string;
};
export type SecondaryProduct = {
  id: string; productId: string; brandId: string; merchantId: string; brandName: string;
  title: string; imageUrl?: string; productUrl?: string; price?: string; currency?: string;
  type: 'similar'; matchType: 'similar'; placementType: 'organic';
  ownershipIdentity?: OwnershipIdentity; inventoryVerifiedAt: string;
  relevanceExplanation: string; checkoutCapability: 'product_destination';
};
export type SecondaryResponse = {
  version: 'black-owned-discovery-v1'; status: 'ready' | 'empty' | 'unavailable';
  products: SecondaryProduct[]; primaryOwnership: Record<string, OwnershipIdentity>; generatedAt: string;
};
export type SecondaryInput = {
  garment: { item_type: string; subtype?: string; primary_color?: string; secondary_color?: string; material_estimate?: string; silhouette?: string; pattern?: string; distinctive_features?: string[] };
  market: string; primaryProducts: { id: string; productUrl?: string }[];
};
export function hasVerifiedOwnership(identity?: OwnershipIdentity | null, now = Date.now()): boolean {
  return !!identity && identity.ownershipVerificationStatus === 'verified' && identity.publicOwnershipLabelAllowed === true
    && typeof identity.brandId === 'string' && !!identity.brandId && typeof identity.brandName === 'string' && !!identity.brandName
    && Number.isFinite(Date.parse(identity.verifiedUntil)) && Date.parse(identity.verifiedUntil) > now;
}
type Invoke = (name: string, options: { body: SecondaryInput; signal: AbortSignal }) => Promise<{ data: unknown; error: unknown }>;

function safeOptionalUrl(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function safeDisplayFields(product: SecondaryProduct): boolean {
  return safeOptionalUrl(product.productUrl) && safeOptionalUrl(product.imageUrl)
    && (product.price === undefined || typeof product.price === 'string')
    && (product.currency === undefined || typeof product.currency === 'string');
}
/** Host calls only after the primary shelf settles. Default disabled and never
 * imported by scan orchestration. Server feature flags remain authoritative. */
export async function requestBlackOwnedDiscovery(invoke: Invoke, input: SecondaryInput, options: { enabled?: boolean; primarySettled?: boolean; signal?: AbortSignal } = {}): Promise<SecondaryResponse | undefined> {
  if (options.enabled !== true || options.primarySettled !== true || options.signal?.aborted) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    // Explicit projection: no scan photo, face data, conversation or role claim.
    const g = input.garment;
    const body: SecondaryInput = { garment: { item_type: g.item_type, subtype: g.subtype, primary_color: g.primary_color, secondary_color: g.secondary_color, material_estimate: g.material_estimate, silhouette: g.silhouette, pattern: g.pattern, distinctive_features: g.distinctive_features }, market: input.market, primaryProducts: input.primaryProducts.map(({ id, productUrl }) => ({ id, productUrl })) };
    const { data, error } = await invoke('black-owned-discovery', { body, signal: controller.signal });
    if (error || controller.signal.aborted || !data || typeof data !== 'object') return undefined;
    const result = data as SecondaryResponse;
    if (result.version !== 'black-owned-discovery-v1' || !['ready','empty','unavailable'].includes(result.status) || !Array.isArray(result.products) || result.products.length > 8) return undefined;
    if (result.products.some((p) => !p || p.type !== 'similar' || p.matchType !== 'similar' || p.placementType !== 'organic' || typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.brandName !== 'string' || !safeDisplayFields(p))) return undefined;
    return result;
  };
  const cancelled = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    timer = setTimeout(abort, 1800);
  });
  try { return await Promise.race([work(), cancelled]); } catch { return undefined; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort(); }
}
