// watchlistCapability.ts — K5-C1: Watchable listing identity + capability.
//
// A Watch is an OFFER at ONE retailer, identified by its normalized HTTPS
// product URL — never a product, never a variant. See
// docs/build34-kplus-smart-watchlist-v1-k5c0-audit.md §10-§20 for the full
// identity audit this narrows against: RecommendedProduct carries no size,
// color, variant id, SKU or availability, and the only field that is (a)
// required, (b) hard-normalized, and (c) already the dedupe key everywhere is
// productUrl. `canonicalProductKey` (a brand+title-token hash) is explicitly
// NOT used here — it groups colorways together and is unstable under a
// retailer re-title.
//
// This module adds one server-authored, read-only field to the existing
// commerce contract: `watchCapability`. It never filters, reorders, or drops
// a product — an unsupported listing still renders exactly as it does today.
// Nothing here creates a Watch; that is K5-C2.

import type { RecommendedProduct } from './shoppingProvider.ts';
import { isFarfetchProductUrl, isFarfetch3Enabled } from './farfetch3Provider.ts';
import { isKicksCrewProductUrl, isKicksCrewEnabled } from './kicksCrewProvider.ts';
import { normalizeUrl } from './shoppingProvider.ts';

export type WatchCapability = 'refreshable_listing' | 'unsupported';

export type WatchableProduct = RecommendedProduct & { watchCapability: WatchCapability };

/**
 * The two response paths (MODE A image/text, MODE B commerce_only) carry the
 * finalized shelf under two different, structurally-incompatible aliases for
 * what is the same runtime shape (`RecommendedProduct` vs the broader
 * `Record<string, unknown> & {...}` `RankedScanProduct`). This annotator only
 * ever reads `type` and `productUrl` off whatever object it is given, so it
 * reads them defensively at `unknown` rather than constraining either call
 * site's element type to the other's shape.
 */
function readWatchableFields(product: unknown): { type: unknown; productUrl: unknown } {
  if (!product || typeof product !== 'object') return { type: undefined, productUrl: undefined };
  const rec = product as Record<string, unknown>;
  return { type: rec.type, productUrl: rec.productUrl };
}

/**
 * Provider registry (§18): only providers with a proven, trustworthy
 * listing-level re-observation path are watch-eligible in V1. Both current
 * entries are URL-enrichment adapters (`enrichFarfetchProductByUrl`,
 * `enrichKicksCrewProductByUrl`) — a real "re-read this exact listing" call,
 * not a keyword re-search that could silently resolve to a different item.
 * Serper, Brave and Poshmark have no refresh-by-identity path at all (§21,
 * §65) and stay unsupported until a trustworthy adapter exists for them.
 *
 * This is config, not a table — there is nothing here a client or an
 * operator needs to change independently of a code deploy.
 */
const WATCH_PROVIDER_REGISTRY: ReadonlyArray<{
  retailer: string;
  matchesUrl: (url: string) => boolean;
  isEnabled: () => boolean;
}> = [
  { retailer: 'farfetch', matchesUrl: isFarfetchProductUrl, isEnabled: isFarfetch3Enabled },
  { retailer: 'kickscrew', matchesUrl: isKicksCrewProductUrl, isEnabled: isKicksCrewEnabled },
];

/**
 * True only for a listing this build can actually re-observe later:
 *   - a real offer (`type: 'retail'`) — a `'similar'` web link is not
 *     something to buy, so it is never watchable, matching the existing
 *     SAME vs SIMILAR distinction (audit §14);
 *   - a governed, safe HTTPS URL (`shoppingProvider.normalizeUrl` — the same
 *     authority `dedupeProductsByUrl` already trusts);
 *   - a URL whose host matches a registered, currently-enabled provider.
 *
 * Never true for a Serper/Brave/Poshmark listing, however plausible the URL
 * looks — those providers have no re-read-by-identity call to give the
 * refresh worker (§21), and a Watch this build cannot actually refresh would
 * be a promise it cannot keep.
 */
export function deriveWatchCapability(product: unknown): WatchCapability {
  const { type, productUrl } = readWatchableFields(product);
  if (type !== 'retail') return 'unsupported';
  const url = normalizeUrl(productUrl);
  if (!url) return 'unsupported';
  const eligible = WATCH_PROVIDER_REGISTRY.some(
    (entry) => entry.isEnabled() && entry.matchesUrl(url),
  );
  return eligible ? 'refreshable_listing' : 'unsupported';
}

/** Watch-eligible retailer label for a URL already known to be capable, or null. */
export function watchProviderForUrl(url: string | undefined): string | null {
  if (!url) return null;
  const entry = WATCH_PROVIDER_REGISTRY.find((e) => e.isEnabled() && e.matchesUrl(url));
  return entry?.retailer ?? null;
}

/**
 * Attaches `watchCapability` to every product in the response shelf.
 *
 * Purely additive: same array length, same order, same existing fields.
 * Must run at exactly the response boundary (once per request, after ranking
 * and filtering are final) so it can never influence ranking, dedupe, or
 * which products get persisted into Recent Scans — those are decided from
 * the array's existing contents, and this only appends one field to each.
 */
export function attachWatchCapability<T>(products: T[]): (T & { watchCapability: WatchCapability })[] {
  return products.map((p) => ({ ...p, watchCapability: deriveWatchCapability(p) }));
}
