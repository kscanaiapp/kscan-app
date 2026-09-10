/**
 * Commerce V2 retailer registry (Build 35 §17).
 *
 * The single, versioned source of truth for retailer display name, known
 * domains, logo availability and (where stable) commerce classification.
 * Entries are derived only from retailers this app already transacts
 * with -- current commerce adapters (`farfetch3Provider.ts`,
 * `kicksCrewProvider.ts`, `poshmarkProvider.ts`), the secondhand provider
 * (`SecondhandItem.source === 'vinted'`), and a retailer domain that
 * recurs across this repo's own commerce test fixtures
 * (`nordstrom.com` / `shop.nordstrom.com` -- see
 * `__tests__/phase3CommerceAuthWeather.test.js`,
 * `__tests__/dressingRoomUxMaturity.test.js`,
 * `__tests__/externalUrlOpenSafety.test.js`). No retailer is invented.
 *
 * Registry presence/order has NO effect on ranking, offer ordering, or
 * which offers are shown (Build 35 §5, §80). It only supplies presentation
 * facts to `resolveRetailerIdentity`.
 */

export const RETAILER_REGISTRY_VERSION = 1 as const;

export type CommerceClassification = 'retail' | 'resale';

export interface RetailerRegistryEntry {
  /** Stable lowercase key. Matches the backend's own provider key where one
   * already exists (see `WATCH_PROVIDER_REGISTRY` in
   * `supabase/functions/scan-identify/watchlistCapability.ts`). */
  retailerKey: string;
  /** Human-facing name, e.g. "Farfetch". */
  displayName: string;
  /** Registered apex domains. A purchase URL matches an entry when its
   * hostname equals a domain or is a subdomain of one (e.g.
   * `shop.nordstrom.com` matches `nordstrom.com`). */
  domains: string[];
  /** Asset module reference for the retailer's logo, or null. Null unless a
   * documented rights basis exists -- see `logoRightsBasis` and
   * `assets/commerce/retailers/README.md`. No entry ships a logo today. */
  logoAsset: string | null;
  /** Single-character (or short) fallback shown when `logoAsset` is null. */
  fallbackMonogram: string;
  /** Commerce classification, only when stable/known for this retailer as a
   * whole. Individual offers still carry their own `commerceType` where the
   * backend supplies one -- this is a registry-level hint, not an override. */
  commerceType: CommerceClassification | null;
  /** Why `logoAsset` is (or, today, is always) null. See Build 35 §19. */
  logoRightsBasis: string | null;
}

const ENTRIES: RetailerRegistryEntry[] = [
  {
    retailerKey: 'farfetch',
    displayName: 'Farfetch',
    domains: ['farfetch.com'],
    logoAsset: null,
    fallbackMonogram: 'F',
    commerceType: 'retail',
    logoRightsBasis: null,
  },
  {
    retailerKey: 'kickscrew',
    displayName: 'KicksCrew',
    domains: ['kickscrew.com'],
    logoAsset: null,
    fallbackMonogram: 'K',
    commerceType: 'retail',
    logoRightsBasis: null,
  },
  {
    retailerKey: 'poshmark',
    displayName: 'Poshmark',
    domains: ['poshmark.com'],
    logoAsset: null,
    fallbackMonogram: 'P',
    commerceType: 'resale',
    logoRightsBasis: null,
  },
  {
    retailerKey: 'vinted',
    displayName: 'Vinted',
    domains: ['vinted.com'],
    logoAsset: null,
    fallbackMonogram: 'V',
    commerceType: 'resale',
    logoRightsBasis: null,
  },
  {
    retailerKey: 'nordstrom',
    displayName: 'Nordstrom',
    domains: ['nordstrom.com'],
    logoAsset: null,
    fallbackMonogram: 'N',
    commerceType: 'retail',
    logoRightsBasis: null,
  },
];

/** retailerKey -> entry. O(1). */
export const RETAILER_REGISTRY: Readonly<Record<string, RetailerRegistryEntry>> = Object.freeze(
  Object.fromEntries(ENTRIES.map((entry) => [entry.retailerKey, entry])),
);

/** lowercase apex domain -> retailerKey. O(1) exact-domain lookup. */
const DOMAIN_INDEX: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    ENTRIES.flatMap((entry) => entry.domains.map((domain) => [domain.toLowerCase(), entry.retailerKey])),
  ),
);

/** lowercase alias (display name, key, or bare domain string) -> retailerKey. */
const ALIAS_INDEX: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    ENTRIES.flatMap((entry) => {
      const aliases = new Set<string>([
        entry.retailerKey.toLowerCase(),
        entry.displayName.toLowerCase(),
        ...entry.domains.map((domain) => domain.toLowerCase()),
      ]);
      return Array.from(aliases, (alias) => [alias, entry.retailerKey]);
    }),
  ),
);

export function listRetailers(): readonly RetailerRegistryEntry[] {
  return ENTRIES;
}

export function getRetailerByKey(retailerKey: string | null | undefined): RetailerRegistryEntry | null {
  if (!retailerKey) return null;
  return RETAILER_REGISTRY[retailerKey] ?? null;
}

/**
 * O(1) hostname match. Checks the exact host first, then walks up to two
 * label levels (covers `shop.nordstrom.com` -> `nordstrom.com`) without a
 * per-registry-entry scan.
 */
export function findRetailerByDomain(hostname: string | null | undefined): RetailerRegistryEntry | null {
  if (!hostname) return null;
  const host = hostname.toLowerCase().replace(/^www\./, '');
  const labels = host.split('.');
  for (let start = 0; start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start).join('.');
    const key = DOMAIN_INDEX[candidate];
    if (key) return RETAILER_REGISTRY[key];
  }
  return null;
}

/**
 * O(1) declared-name match (case-insensitive). Matches a registered display
 * name, retailer key, or a raw domain string a provider sometimes supplies
 * as its "source" (see `shoppingProvider.ts` `hostnameOf` fallback).
 */
export function findRetailerByDeclaredName(value: string | null | undefined): RetailerRegistryEntry | null {
  if (!value) return null;
  const key = ALIAS_INDEX[value.trim().toLowerCase()];
  return key ? RETAILER_REGISTRY[key] : null;
}
