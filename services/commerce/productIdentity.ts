/**
 * Commerce product identity for shelf memory (Commerce V2 §7, §8, §9).
 *
 * THIS IS NOT A NEW IDENTITY ARCHITECTURE. It is an encoding of the one the
 * ranker already uses. `qualityTuneCommerce.productIdentityKey` resolves an
 * offer through a tier list whose reachable tier for every live provider is
 * the CANONICAL URL — both active providers synthesise `id` by hashing the raw
 * `productUrl`, so a tracking parameter or a trailing slash produces a
 * different `id` for the same listing while the canonical URL does not. That
 * canonical form is therefore the strongest stable identity present in the
 * build, and it is the one reused here.
 *
 * WHY A CLIENT MIRROR AT ALL. Commerce activation runs on the device
 * (`services/style-chat/commerceActivation.ts` explains why), so the shelf a
 * customer was actually shown is assembled here. Reaching into the Edge
 * Function bundle for `canonicalizeUrlForIdentity` would drag the whole
 * Commerce tree into the app bundle; `services/commerce/commercialUsability.ts`
 * already established the mirror pattern for exactly this reason, and the rule
 * is the same one it states: the two sides must agree, so the normalisation
 * below is a line-for-line mirror rather than an improvement on it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide that two listings from
 * two retailers are the same physical product. A K Scan shelf can prove that
 * two rows are the same OFFER; it cannot prove that a loafer on one site is
 * the same SKU as a visually similar loafer on another, and inventing that
 * claim is exactly the canonical-product-identity build this lane is forbidden
 * to start. See `CROSS_RETAILER_DUPLICATE_LIMIT` in the lane report.
 */

/**
 * Tracking parameters stripped before identity. Mirrors `TRACKING_PARAMS` in
 * `supabase/functions/scan-identify/qualityTuneCommerce.ts`; the two lists must
 * stay identical, which is why neither side may "helpfully" extend it alone.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'affiliate', 'aff', 'source', 'affiliate_id', 'irclickid', 'clickid',
  'campaign', 'gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi',
]);

/**
 * Canonicalize a purchase URL for identity only. Never a display or
 * destination URL: the offer is always opened byte-identical through
 * `commerceExit`, which is a different concern and a different value.
 */
export function canonicalCommerceUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    const kept = new URLSearchParams();
    u.searchParams.forEach((value, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase())) return;
      kept.append(key, value);
    });
    const qs = kept.toString();
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return `${u.protocol}//${u.hostname}${pathname}${qs ? `?${qs}` : ''}`;
  } catch {
    const collapsed = String(url).replace(/\s+/g, ' ').trim().toLowerCase();
    return collapsed || null;
  }
}

/** FNV-1a, 32-bit. The same bucket-selector hash the commerce cache uses. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** djb2. A second, independent mixer — see `IDENTITY_STABILITY_ASSUMPTION`. */
function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(hash, 33) + input.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/** Exactly `u:` plus 16 lowercase hex characters. Nothing else is an identity. */
export const SHELF_IDENTITY_RE = /^u:[0-9a-f]{16}$/;

/**
 * The bounded token a remembered shelf stores for one offer.
 *
 * WHY A HASH RATHER THAN THE URL. Two reasons, both structural. Shelf memory
 * is persisted state that is restored, re-validated and carried between turns,
 * so every field in it has to be BOUNDED — a retailer URL is not, and
 * truncating one would silently break the equality the whole feature rests on.
 * And a fixed-width opaque token cannot be mistaken for text: nothing
 * downstream can read a product title, a query, or an instruction out of it,
 * which is the §18 boundary stated as a data shape rather than as a promise.
 *
 * IDENTITY_STABILITY_ASSUMPTION: two DIFFERENT canonical URLs colliding on the
 * same 64-bit token. The consequence would be bounded (one extra offer hidden,
 * or an ordinal resolving to a neighbouring offer) and the probability across
 * the 18-reference bound is on the order of 1e-17, but the assumption is
 * recorded rather than assumed away. Two hashes over the same string are used
 * instead of one so the token is 64 bits wide rather than 32.
 */
export function productShelfIdentity(product: unknown): string | null {
  if (!product || typeof product !== 'object') return null;
  const rec = product as Record<string, unknown>;
  const canonical = canonicalCommerceUrl(rec.productUrl);
  if (!canonical) return null;
  const a = fnv1a(canonical).toString(16).padStart(8, '0');
  const b = djb2(canonical).toString(16).padStart(8, '0');
  return `u:${a}${b}`;
}

/** Identities for an ordered set of offers, order preserved, gaps dropped. */
export function shelfIdentities(products: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(products)) return [];
  const out: string[] = [];
  for (const product of products) {
    const identity = productShelfIdentity(product);
    if (identity && !out.includes(identity)) out.push(identity);
  }
  return out;
}

/** Validate one token arriving from persisted (therefore untrusted) state. */
export function isShelfIdentity(value: unknown): value is string {
  return typeof value === 'string' && SHELF_IDENTITY_RE.test(value);
}

/**
 * Collapse offers that are the SAME LISTING within one candidate set (§9).
 *
 * Offer identity only. Two rows collapse when they canonicalize to the same
 * URL — a genuine duplicate the dedupe upstream could not see because the two
 * providers decorated the link differently. A visually similar shoe at another
 * retailer is a DIFFERENT offer and survives, because K Scan cannot prove it is
 * the same physical product and will not imply that it can.
 */
export function collapseDuplicateOffers<T>(products: readonly T[] | null | undefined): T[] {
  if (!Array.isArray(products)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const product of products) {
    const identity = productShelfIdentity(product);
    if (identity) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    out.push(product);
  }
  return out;
}

/**
 * Does this row carry proof that a real Commerce result produced it?
 *
 * Moved here from `commerceActivation` so that identity and provenance — the
 * two questions shelf memory must answer about the same row — live together
 * and can be asked without importing the activation orchestrator. The rule is
 * byte-for-byte the one #410 shipped, and `commerceActivation` re-exports this
 * symbol so every existing caller is unchanged.
 *
 * §50/BLOCK-CV2-01: fabrication has to be mechanically detectable, not a
 * matter of trust. A card may render only for an object that came back from
 * the Commerce path carrying the fields that path assigns — a destination URL
 * and a title it did not invent.
 */
export function hasCommerceProvenance(product: unknown): boolean {
  if (!product || typeof product !== 'object') return false;
  const rec = product as Record<string, unknown>;
  const url = typeof rec.productUrl === 'string' ? rec.productUrl.trim() : '';
  const title = typeof rec.title === 'string' ? rec.title.trim() : '';
  if (!url || !title) return false;
  return /^https?:\/\//i.test(url);
}
