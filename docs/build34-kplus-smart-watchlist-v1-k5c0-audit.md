# K+ Smart Watchlist V1 — K5-C0 Read-Only Architecture & Commerce Identity Audit

**Type:** READ-ONLY. No source modified, no migration created, no table created, no
Edge Function deployed, no staging/production data written, no notification job
created, no EAS run. Commerce, Wardrobe Concierge, Packing Intelligence and
Virtual Try-On are untouched.

---

## 1. EXECUTIVE FINDING (§61)

### Can K Scan build a trustworthy Smart Watchlist V1 on top of the current Commerce authority?

**Yes — but only a deliberately narrow one, and only if the alert language is
scoped to what the current commerce contract can actually prove.**

Three findings dominate everything else:

1. **There is no variant identity anywhere in the live commerce contract.**
   `RecommendedProduct` (the single normalized commerce object, defined in
   `supabase/functions/scan-identify/shoppingProvider.ts:12-40`) carries
   `id, title, source, price, type, imageUrl, productUrl, brand, commerceType`
   and nothing else. There is no size, no color, no variant id, no SKU, no
   availability, no stock. Poshmark actually parses `size` and `condition`
   (`poshmarkProvider.ts:200-218`) and KicksCrew actually receives a full
   `variants[]` array with per-variant `sku`/`price`/`price_currency`
   (`kicksCrewProvider.ts:96-143`) — but **both are discarded** at
   `scanCommerceRouter.ts:637-652` (`normalizeToRecommendedProduct`), which
   copies nine fields and drops the rest. A variant-specific alert is
   structurally impossible today.

2. **There is no scheduler, no background worker for commerce, and no
   notification system at all.** No `pg_cron`, no `pg_net`, no scheduled Edge
   Function defined in source, no cron in `render.yaml`, no `schedule:` in any
   `.github/workflows/*.yml`. `package.json` has no `expo-notifications`, no
   `expo-task-manager`, no `expo-background-fetch`; `app.json` declares no
   notification plugin; `hooks/usePermissionPreferences.ts` is an explicit
   placeholder that returns `backend_not_connected`; and Build 33 **removed**
   the Notifications onboarding card (`components/account-home/PermissionsStepV1.tsx:27`).
   Watchlist is the first feature in this codebase that needs periodic
   execution and an outbound user message.

3. **Product identity is a fuzzy title hash, not a stable id.**
   `canonicalProductKey` (`canonicalCommerce.ts:132-139`) is
   `fnv1a(brand + first-8-sorted-noise-stripped-title-tokens)`. A retailer
   re-titling a listing changes the key. There is no UPC/GTIN/EAN/MPN anywhere
   in the repo. The only genuinely stable per-listing identity available today
   is **the normalized product URL**, plus a real provider id on the two
   URL-enrichment providers (Farfetch `internalProductId`, KicksCrew first-variant
   `sku`) — both of which are default-OFF feature flags.

### What is the narrowest V1 that creates meaningful customer value?

**Watch a specific retailer listing, by URL, and tell the user when the price
on that listing changes or the listing goes away.**

Concretely:

- The **watched thing is one offer at one retailer**, identified by its
  normalized HTTPS product URL — not a "product", not a variant.
- The **refresh** is a URL-addressed re-read, reusing the two enrichment
  adapters that already exist (`enrichFarfetchProductByUrl`,
  `enrichKicksCrewProductByUrl`) plus a re-run of the same structured-evidence
  MODE B discovery for everything else, with the listing re-located by URL match.
- The **only deterministic signals V1 can honestly emit** are
  *price changed on this listing*, *this listing is no longer being returned /
  no longer resolvable*, and *user's own target price reached*.
- The **only intent V1 should offer beyond "just watching" is "Buy under $___"**,
  because it is the one threshold the user supplies and the system does not
  have to infer.
- **Closet enrichment is display-only and qualitative** ("you may already own
  something similar"), grounded on the existing server-derived ownership
  contract (`stylechat-generate/attachmentProvenance.ts`), never on counts.

Everything else in the brief — size restock, color restock, "same product
cheaper elsewhere", cross-retailer identity claims — is **provider-limited or
post-V1** on the current contract.

---

## 2. LIVE AUTHORITY (§6, §62)

```
LIVE BASE BRANCH:  origin/integration/backend-kplus-complimentary-staging-v1
LIVE BASE SHA:     157606c99b057c0a22f2e0bd4f80a8b10a17e65e
REMOTE SHA:        157606c99b057c0a22f2e0bd4f80a8b10a17e65e
REMOTE MATCH:      YES
AUDIT WORKTREE:    detached HEAD @ 157606c9 (scratchpad worktree, read-only)
CLEAN:             YES (0 modified/untracked files)
AHEAD/BEHIND:      0 / 0 vs its own remote
```

### How this authority was resolved

`git fetch --all --prune` was run first. `origin/master` (`688dc35e`,
2026-08-14) is **not** the Build 34 authority: it contains **zero** `k_plus`
references and has diverged from the Build 34 line
(`master ↔ trackb-convergence` = **92 / 787**; master is *not* an ancestor).
Master is a parallel `codex/master-*` closet-intake/E41 test line.

The Build 34 line converges here:

| Branch | Tip | k_plus files | Relationship |
|---|---|---|---|
| `integration/build34-trackb-convergence-v1` | `206454bb` | 26 | 787 ahead of master |
| **`integration/backend-kplus-complimentary-staging-v1`** | **`157606c9`** | **26** | merges trackb (PR #230); **1 ahead** |
| `feature/build34-kplus-packing-intelligence-v1` | `4555f9a3` | 26 | contains `157606c9`; **+8** |
| `origin/master` | `688dc35e` | 0 | divergent legacy line |

`157606c9` is the newest commit that the most recent K+ **sibling** feature
(Packing Intelligence V1, the direct architectural precedent for Watchlist)
branched from. That makes it the governed shared integration authority.

### PARALLEL CHANGE RECORD (§6)

```
PARALLEL COMMERCE CHANGE: NONE
```

Verified by diffing every active branch against `157606c9` and filtering for
commerce/identity/normalization/entitlement/closet/notification/saved surfaces.
No active branch touches `scan-identify` commerce, `canonicalCommerce.ts`,
`shoppingProvider.ts`, any provider adapter, `productSnapshot.ts`, or
`dressingRoomCommerce.ts`.

Adjacent parallel work, recorded for collision awareness only:

| Branch | SHA | Touches | Watchlist impact |
|---|---|---|---|
| `feature/build34-kplus-packing-intelligence-v1` | `4555f9a3` | `stylechat-generate/packing*`, `constants/featureFlags.ts`, `contexts/AuthSessionContext.tsx`, `components/home/HomeLuxuryTechV1.tsx`, `config/edge-function-manifest.json` | **Low.** Shares the K+ gate, the home surface, the flag file and the Edge-Function manifest. Text-level conflicts only; no authority conflict. |
| `feature/build34-vto-alpha-foundation-v1` | `dae8b653` | new `supabase/functions/vto-generate/*`, incl. its own `vtoEntitlement.ts`; migration `20260830160000_vto_feature_control.sql` | **Low.** Note: VTO implements a *second* server-side K+ gate. Watchlist should use `kplus_has_active_entitlement` / `has_active_k_plus()` directly rather than adding a third. |
| `feature/build34-vto-provider-benchmark-v1` | `03b1df0a` | same VTO surface | Low |
| `feature/backend-build34-vto-generate-v1` | `59e3c03f` | same VTO surface (older lineage, 241 behind) | Low |
| `fix/phase2b4-governed-edge-inventory-v1` | `a9bc3c3c` | CI edge-inventory gate determinism | **Merge before building.** Watchlist adding an Edge Function will trip the governed edge-inventory gate this branch repairs. |

None of these is a valid base. Watchlist branches from `157606c9`.

---

## 3. AUDIT AREA A — CURRENT COMMERCE AUTHORITY

### §8 Concrete commerce path map

There are **two live commerce paths** in one Edge Function.

**MODE A — inline (image/text scan):**
```
client scan
  → supabase/functions/scan-identify/index.ts (Deno.serve)
  → identification (Gemini) → gates/quality/relevance
  → scanCommerceRouter.getScanCommerceResults()            [scanCommerceRouter.ts:1308]
      → resolveCommerceQueries()                            [:749]
      → bounded parallel discovery:
          shoppingProvider.getShoppingResults()             [shoppingProvider.ts:496]
              → Serper /shopping   (primary)                [:243]
              → Brave  /web/search (fallback)               [:342]
          poshmarkProvider.searchPoshmarkProducts()         [poshmarkProvider.ts:~225]
      → enrichDiscoveredUrls()  (URL-driven only)           [scanCommerceRouter.ts:700]
          → farfetch3Provider.enrichFarfetchProductByUrl()  [farfetch3Provider.ts:204]
          → kicksCrewProvider.enrichKicksCrewProductByUrl() [kicksCrewProvider.ts:~193]
      → qualityTuneCommerce.filterAndDedupeProducts()
      → v124 identity ranking (commerceRelevance*.ts)
  → response.recommendedProducts / purchaseOptions
  → client services/commerceHydration.ts → components/ProductShelf.tsx
```

**MODE B — deferred commerce-only (v127), the interesting one for Watchlist:**
```
client services/commerceHydration.ts  (the ONLY caller; buildCommerceOnlyBody)
  → POST scan-identify { requestMode: 'commerce_only', identification, attributes,
                         searchQueries, market, candidateId, enrich? }
  → index.ts:2002  if (commerceFunnelEnabled && isCommerceOnlyRequest(body))
      → checkCommerceOnlyRateLimit(sha256(ip+ua))          [index.ts:1342, 40 / 10min]
      → commerceResultCache.commerceCacheGet()             [10 min TTL, in-memory]
      → scanCommerceRouter.getFastCommerceResults()        [:914, 1.9s deadline]
      → (optional) enrichCommerceOffers()                  [:1225, 6s deadline]
      → canonicalCommerce.buildCanonicalCommerce()         [index.ts:2155]
  → response { purchaseOptions, recommendedProducts, canonicalProducts, commerce{…}, funnel{…} }
```

**Two gates worth recording:**
- MODE B only exists when `BACKEND_COMMERCE_FUNNEL_V127_ENABLED=true`.
  `COMMERCE_FUNNEL_DEFAULT_ENABLED = false` (`commerceFunnelConfig.ts:32`).
- `scan-identify` runs `verify_jwt = false` (`supabase/config.toml:26`)
  *specifically* so MODE B works without a bearer token. MODE B returns at
  `index.ts:2234` — **before** the authenticated daily-quota check at
  `index.ts:2512`. So commerce refresh today is **unauthenticated and unmetered
  per user**, bounded only by a per-isolate IP+UA sliding window.

### §9 Canonical commerce object field audit

Audited against `RecommendedProduct` (`shoppingProvider.ts:12-40`) — the object
every provider is normalized into and the only object the client receives.

| Field | Exists? | Source | Stable? | Suitable for Watchlist? |
|---|---|---|---|---|
| `provider` | **No** (as a field) | inferred from `ScanCommerceResult.provider` at the *result* level, not per product | n/a | No — a saved offer loses which provider produced it |
| `retailer` | **No** on `RecommendedProduct`; present on `Farfetch3Product`/`KicksCrewProduct`/`PoshmarkProduct` but **dropped** at `scanCommerceRouter.ts:637` | provider | n/a | No — client derives it from `source` |
| `source` | Yes | Serper `it.source` (merchant label) or URL hostname; Brave profile name or host; literal `'Farfetch'`/`'KicksCrew'`/`'Poshmark'` | Moderate (a label, not an id) | Display only |
| `retailerProductId` | **No** | — | — | No |
| `sku` | **No** on the contract. KicksCrew's *first variant* `sku` is smuggled into `id` (`kicksCrewProvider.ts:171-172`) | KicksCrew only, flag-gated | Stable when present | Partial, one provider |
| `productId` | **No** on the contract. `CanonicalPurchaseOption.productId` exists in *persistence* (`types/canonicalDressingRoomItem.ts:40`) but falls back to `record.id` | — | — | Weak (see below) |
| `canonicalId` | Server-side only: `CanonicalProduct.productKey` (`canonicalCommerce.ts:34`), **never sent to any client** | fnv1a(brand + 8 title tokens) | **Unstable** — title-derived | No |
| `title` | Yes | provider, truncated 160 | Retailer-controlled, changes | Untrusted display text |
| `brand` | Optional; only when the provider declares one. Serper and Brave **never** do (`shoppingProvider.ts:24-33`) | Farfetch `brand.name`, KicksCrew `vendor`, Poshmark `brand` | Good when present | Partial |
| `category` | **No** on the product | request-level `categoryRoute` | — | No |
| `productUrl` | Yes, **required** (an item without one is dropped) | provider, hard-normalized (`normalizeUrl`, `shoppingProvider.ts:157`) | **Best available identity** | **Yes — this is the identity** |
| `imageUrl` | Optional | provider | Rotates on CDNs | Display only |
| `price` | Optional **string** ("$179", "£120", "1 200 kr") | Serper raw string; Farfetch/KicksCrew/Poshmark `Intl.NumberFormat` | Provider-dependent | Yes, after parsing |
| `currency` | **No** on the contract | recoverable only by re-parsing the price string (`parseOfferPrice`, `canonicalCommerce.ts:85-108`) | Symbol/ISO heuristic | Partial |
| `color` | **No** | — | — | No |
| `size` | **No** on the contract; Poshmark parses it then it is dropped | Poshmark only | — | **No — blocking for size intents** |
| `variantId` | **No**, anywhere | — | — | **No — blocking** |
| `availability` | **No** on the contract. Poshmark *filters out* sold listings (`poshmarkProvider.ts:151-155`) rather than reporting a status | — | — | **No — blocking for stock intents** |
| `stock` | **No**, anywhere | — | — | No |
| `timestamp` | **No** on the product. `CanonicalOffer.observedAt` exists server-side (`canonicalCommerce.ts:31`) but is not exposed | request time | — | Partial |
| `commerceType` | Yes (`'retail' \| 'resale'`) | provider provenance | Stable | Useful metadata |
| `type` | Yes (`'retail' \| 'similar'`) | Serper→retail, Brave→similar | Stable | **Important**: distinguishes a real offer from a web link |
| `id` | Yes | `fnv1a`/×31 hash of the **productUrl** (`shoppingProvider.ts:212-218`), or provider id for Farfetch/KicksCrew/Poshmark | Deterministic *from the URL* | Yes, but it **is** the URL under a hash |

### §10 What should Watchlist save as its authoritative commerce reference?

**The normalized product URL, as produced by the existing commerce authority,
plus the offer snapshot that came with it.**

Reasoning from the code, not from names:

- The **existing canonical product record is not a candidate.** `CanonicalProduct`
  is built only on the MODE B path (`index.ts:2155`), emitted as
  `canonicalProducts` (`index.ts:2238`), and — verified by grep — **no client
  reads it**. Its key is a title-token hash and its `availability`/`size`/
  `providerProductId`/`retailer` fields read `rec.availability`, `rec.size`,
  `rec.providerProductId`, `rec.retailer` off a `RecommendedProduct` that has
  none of them, so those fields are **structurally always `null`** on the live path.
- **Provider product id is not available** for the two default-on providers.
- **Retailer SKU is available for exactly one flag-gated provider** (KicksCrew).
- The URL is the only field that is (a) required, (b) hard-normalized by two
  independent authorities (`shoppingProvider.normalizeUrl` server-side,
  `commerceDestination.isSafeCommerceUrl` + `dressingRoomCommerce.normalizePersistedCommerceUrl`
  client-side), (c) already the dedupe key everywhere
  (`dedupeProductsByUrl`, `mapSerperItems`, `enrichedByUrl`), (d) already the
  enrichment address, and (e) already the basis of the synthetic `id`.

**Do not invent a new canonical identity.** Adopt the governed URL contract and
be explicit that a Watch is *an offer at a retailer*, not *a product*.

---

## 4. AUDIT AREA B — PRODUCT IDENTITY

### §11 Product-family identity classification

**PARTIAL — and provider-specific.**

| Scenario | Can K Scan answer "same product"? | Evidence |
|---|---|---|
| Same retailer, same provider, unchanged URL | **YES** — exact normalized-URL match | `dedupeProductsByUrl` (`scanCommerceRouter.ts:655`) is URL-identity |
| Same retailer, repeated search | **YES, if the URL is returned again.** Not guaranteed — Serper is a ranked search API, `num: limit` ≤ 8, and a listing can simply fall out of the top 8 | `shoppingProvider.ts:60-64`, `callSerper` |
| Different provider | **PARTIAL** — only via `canonicalProductKey` title-token grouping | `canonicalCommerce.ts:132` |
| Changed URL (retailer re-slugs) | **NO** — identity is lost entirely | URL is the identity |
| Changed title | **NO for the canonical key** (the hash changes); **YES if URL unchanged** | `titleIdentityTokens` |
| Changed hero image | **YES** — image is not an identity input | `toOffer` |
| Price change | **YES** — price is not an identity input | `canonicalProductKey` |
| Availability change | **Not observable** — no availability field | see §23 |

Classification: **PARTIAL / PROVIDER-SPECIFIC**. Strong on URL equality;
absent on everything else.

### §12 Variant identity

**NO.**

`RecommendedProduct` has no variant, size, color or SKU field. Audited each
candidate field:

| Field | Present in contract? | Present upstream? |
|---|---|---|
| variant id | No | No provider exposes one in the parsed shapes |
| SKU | No | KicksCrew `product.variants[0].sku` only, collapsed into `id` |
| color id | No | No |
| size id | No | Poshmark `item.size` (free text), dropped at the router |
| merchant variant | No | KicksCrew `variants[]` (parsed for *lowest price only*, `lowestVariantPrice`) |
| retailer variant URL | No | Not modelled; `normalizeUrl` preserves query params, so a `?size=M` URL would survive by accident, not by contract |
| variant availability | No | No |

**Can Watchlist reliably watch the exact variant the user cares about? NO.**

### §13 Identity failure test

> User watches: **Black / Medium / $179**. Later observation: **Blue / XL / $149**.
> Can current identity logic prevent "Price dropped to $149"?

**Only accidentally, and not by contract.**

- If the two are **different URLs**, they are different offers and a
  URL-keyed watch never confuses them. That is the safe case, and it is the
  common case for retailers that give each colorway its own product page.
- If they are the **same URL** (one product page, a size/color picker on it),
  the provider returns **one** listing whose `price` is whatever the page
  advertises — typically the lowest or the default variant. KicksCrew makes
  this explicit and unavoidable: `lowestVariantPrice()` deliberately reduces
  the whole variant array to the single cheapest number
  (`kicksCrewProvider.ts:96-110`). A restock of a cheap XL therefore *does*
  present as a price drop on the URL the user watched.
- `canonicalProductKey` makes it worse, not better: it strips `size`, `mens`,
  `womens` as noise (`TITLE_NOISE`, `canonicalCommerce.ts:57-62`) and never
  reads color, so two colorways with similar titles **group into one product**.

**Missing authority:** a per-offer variant selector on the commerce contract —
minimally `{ variantId | sku, size, color }` carried from provider → router →
client, plus a rule that price is attributed to the selected variant rather
than to the listing.

**This is a V1 blocker for variant-specific alerts.** It is *not* a blocker
for listing-level price alerts, provided the product copy never says "your
size" or "in black" and the alert names the listing, not the variant.

### §14 SAME PRODUCT vs SIMILAR PRODUCT

The architecture **does** distinguish them, at the `type` field, and this is
the cleanest identity asset in the codebase.

| Claim | Evidence available today | Where |
|---|---|---|
| "Same item at another retailer" | **Weak.** Only `canonicalProductKey` grouping — brand + ≤8 sorted title tokens. No UPC/GTIN/MPN. Not exposed to any client. | `canonicalCommerce.ts:110-139` |
| "Similar alternative" | **Available.** `type: 'similar'` is set for every Brave web result (`mapBraveResults`, `shoppingProvider.ts:398`) and `similarityMatches` come from deterministic catalog scoring. | `shoppingProvider.ts:398`, `types/scanIdentification.ts:137` |

The visual-similarity provider that would strengthen "similar" is
**explicitly disabled**: `similarClothesProvider.ts:3` —
`STATUS: BLOCKED_BY_PRIVACY_TRANSPORT`, not wired into the live path, and the
vendor API was returning HTTP 502 at Phase 3 probe time.

### §15 Cross-retailer identity

```
CROSS-RETAILER SAME-PRODUCT: UNSUPPORTED
```

| Signal | Present? |
|---|---|
| UPC / GTIN / EAN | **Absent from the entire repository** (grep: zero hits in any source, migration, or type) |
| MPN | Absent |
| brand + model | Partial. `brand` only from Farfetch/KicksCrew/Poshmark; `CanonicalProduct.model` reads `rec.model`, which no provider sets — always `null` |
| retailer SKU | KicksCrew only, flag-gated, first-variant only |
| provider canonical product id | Farfetch `internalProductId` only, flag-gated |
| normalized product URL | Yes — but a URL is *per-retailer by definition* and proves nothing across retailers |
| exact metadata match | Only the fuzzy title-token hash |

Visual similarity is correctly **not** treated as same-product proof anywhere
in the current code, and must not be.

---

## 5. AUDIT AREA C — EXISTING SAVE / FAVORITE / COMMERCE HISTORY

### §16 Existing saved-product infrastructure

Searched for: saved products, favorites, wishlist, commerce saves, saved scans,
bookmarks, shopping history, recent commerce, `saved_product`, `commerce_product`.

**Four things exist. None of them is a saved *product*.**

**(a) Recent Scans / Saved Scans — scan-scoped, carries a commerce snapshot.**
- Client: `services/library.js` — expo-file-system manifest at
  `documentDirectory/kscan_library/kscan_library.json`, **max 25 records per
  actor partition**, atomic temp/backup swap, ownership derived from
  `services/actorContext.resolveWriteAuthority`.
- Server: `public.saved_scans` (`20260617215307_create_saved_scans.sql`) with
  `purchase_options jsonb` added by `20260717201524_…add_purchase_options_to_saved_scans.sql`.
- Sync: `services/savedScansCloud.ts`, gated by `CLOUD_SAVED_SCANS_ENABLED`.
- RLS: own-row SELECT (`deleted_at is null`) / INSERT / UPDATE; **no client
  DELETE policy — soft delete only**; `revoke all … from anon`.
- Deletion: registered `{ table: 'saved_scans', action: 'auth_delete_cascade' }`
  plus storage prefix `{userId}/saved-scans`.
- **Grain: one row per scan, holding an array of offers.** Not one row per product.

**(b) Dressing Room items — the only true per-product save.**
- `components/ProductShelf.tsx:475` "Add to Dressing Room" is the existing
  per-product action, gated by `canAddProductToDressingRoom` (title + a real
  remote image, `ProductShelf.tsx:165`).
- Persisted through `services/dressingRoomCommerce.normalizePurchaseOptions`
  into `CanonicalPurchaseOption[]` on the room item.
- **Semantics are collaborative/curatorial** (rooms are shareable, have
  participants, reactions, messages, blocking, share tokens). A room is a
  social object.

**(c) Free-tier wishlist intent — local, off by default, wrong subject.**
- `services/free-tier/wishlistIntent.ts`, `hooks/useWishlistIntent.ts`,
  `components/free-tier/WishlistIntentCard.tsx`.
- Storage: AsyncStorage via `freeTierStorage.ts` — versioned envelope,
  **device-scoped, "no backend sync"** by design.
- Optional server mirror `public.wardrobe_wishlist_intents`
  (`20260704175544_free_tier_utility_tables.sql:359`) with full own-row RLS
  including DELETE, synced by `freeTierSupabaseSync.ts` — but every one of
  `FREE_TIER_BACKEND_{SYNC,READ,WRITE,QUEUE}_ENABLED` **defaults false**, and
  the feature flag `FREE_TIER_WISHLIST_INTENT_ENABLED` defaults false.
- **Subject is a `NormalizedItem` (a wardrobe/closet item), not a commerce
  offer.** Its own header states: *"Captures intent without commerce: no price
  tracking, no retailer integrations, no availability claims."*

**(d) Cloud Closet — owned items, K+ gated.**
- `public.user_closet_items` (`20260829203657_user_closet_items.sql`).
  Not a save-for-later surface; it is the ownership authority.

### §17 Can existing save state become watch state?

**No. Watchlist requires a distinct persistent resource.**

| Candidate | Grain | Semantics | Verdict |
|---|---|---|---|
| `saved_scans.purchase_options` | one scan → N offers | *frozen record of what was shown* — the funnel config explicitly relies on this: "Recent Scans already persists the offers a user actually saw, so the cache only has to accelerate repeat retrieval, never act as the record of what was shown" (`commerceFunnelConfig.ts`) | **No.** Mutating it to carry live monitoring state would destroy the historical-record guarantee the cache design depends on. |
| Dressing Room item | one room → N items | collaborative, shareable, reactable, transferable on account deletion (`SHARED_ROOM_TRANSFER_POLICY`) | **No.** A private monitoring rule must never be transferable to another participant. |
| `wardrobe_wishlist_intents` | one closet item → one intent enum | wardrobe intent, no commerce, no price, local-first | **No.** Correct semantic neighbour, wrong subject and wrong tier. |
| `user_closet_items` | owned garments | ownership authority | **No.** Watching is the opposite of owning. |

A favorite means *I like this*. A Watch means *actively re-query this exact
listing on a schedule, evaluate a rule, and message me*. These are different
lifecycles (a Watch has `paused`, `triggered`, `expired`), different security
grain, and different retention. **Do not force them together.**

### §18 Existing commerce history

| Asked for | Exists? | Location / evidence |
|---|---|---|
| price history | **NO** | grep for `price_history`/`priceHistory`/price-observation storage: zero hits |
| product observations | **NO** | — |
| retailer observations | **NO** | — |
| commerce response cache | **YES ×2, both ephemeral and in-memory** | `shoppingProvider.ts` `CACHE` Map, keyed on lowercased query, TTL 1h; `commerceResultCache.ts` `store` Map, keyed on evidence fingerprint, TTL 10 min, max 200 entries. Both are **per-isolate process memory** — they vanish on cold start and are not shared between Edge Function instances. |
| stock state | **NO** | — |
| availability history | **NO** | — |
| commerce telemetry | **YES, but useless as history** | `public.scan_commerce_events` (`20260720120000_…`) — **anonymous** (no `user_id`), no price, no product id, no URL. Counts and durations only; service_role-only RLS. |

**There is no durable commerce observation anywhere in K Scan today.**

---

## 6. AUDIT AREA D — PRICE AUTHORITY

### §19 Price source per provider

| Provider | Price field | Currency | Sale price | Original price | Discount | Freshness |
|---|---|---|---|---|---|---|
| **Serper Shopping** (primary, default ON) | `it.price` → `normalizePrice()` — a **display string**, leading "from/starting at/as low as/only/now" stripped, truncated to 24 chars | **Never returned as a field.** Only recoverable by re-parsing the symbol/ISO code out of the string (`parseOfferPrice`) | No | No | No | request time; 1h provider cache |
| **Brave Web** (fallback, default ON) | **`price: undefined`, always** (`mapBraveResults`) | — | — | — | — | n/a |
| **Poshmark** (`POSHMARK_ENABLED`, default OFF) | `item.price` + `item.currency` → `Intl.NumberFormat` | Yes, real field | No | No | No | request time |
| **Farfetch3** (`FARFETCH3_ENABLED`, default OFF) | `productPrice.final.value.raw` (numeric) | Yes — parsed out of an Apollo cache ref `Currency:{"isoCode":"EUR"}` | `final` only; the API's non-final price fields are **not read** | Not read | Not derived | request time |
| **KicksCrew** (`KICKSCREW_ENABLED`, default OFF, sneaker route only) | **lowest** `variants[].price` | `variants[].price_currency` | No | No | No | request time |
| **RapidAPI real-time-product-search** (`product-search-deals` fn) | **Raw upstream payload passed through unnormalized** | upstream | upstream | upstream | upstream | request time |
| **Vinted** (`search-vinted-secondhand` fn) | `price`, `currency` strings | Yes | No | No | No | request time |
| **`product_catalog` table** | `price numeric`, `currency`, `availability`, `last_seen_at` | Yes | — | — | — | **Synthetic staging seed only** (`supabase/staging-v2/seed-synthetic.sql`); no writer in source; migration says "Not for Production until validated" |

**Reliability assessment:** the only always-on price source is Serper, and it
delivers an **unstructured display string with no currency field**. Everything
downstream re-parses it (`parseOfferPrice`, `formatCommercePrice`,
`toSnapshotPrice`). Any price-delta engine must own that parse and must refuse
to compare across currencies it could not confidently extract.

### §20 Price identity granularity

```
PRICE AUTHORITY GRANULARITY

Serper        : SPECIFIC RETAILER LISTING (page-level; whatever the card advertises)
Brave         : NONE (no price at all)
Poshmark      : SPECIFIC LISTING = SPECIFIC VARIANT (one-of-a-kind resale item; size is the listing)
Farfetch3     : SPECIFIC RETAILER LISTING (productPrice.final; variant not modelled)
KicksCrew     : PRODUCT-FAMILY MINIMUM — explicitly the LOWEST variant price, not a variant price
RapidAPI deals: unvalidated (raw passthrough, not normalized, no client consumer)
```

Price is attached to **the listing**, never to a variant — with the two
instructive exceptions above: Poshmark where listing *is* variant (safe), and
KicksCrew where the price is a min-over-variants aggregate (**actively unsafe**
to present as "the price of this item").

### §21 Price refresh — how should Watchlist ask Commerce to refresh?

| Capability | Available? | Where |
|---|---|---|
| lookup by provider product id | **NO.** Farfetch3 has **no** keyword or id endpoint (`/search` → 404, proven live, `farfetch3Provider.ts:6-11`). No provider offers id lookup. | — |
| lookup by retailer SKU | **NO** | — |
| **lookup by URL** | **YES — for two retailers** | `enrichFarfetchProductByUrl(url)` (`farfetch3Provider.ts:204`), `enrichKicksCrewProductByUrl(url)` (`kicksCrewProvider.ts:~193`). Also reachable *from the client today* as the standalone `kickscrew-sneaker-description` Edge Function, which accepts a client-supplied `productUrl` and enforces the `https://www.kickscrew.com/` origin (`verify_jwt = true`). |
| search by canonical identity | **NO.** MODE B takes *structured evidence* (`identification`, `attributes`, `searchQueries`, `market`) and re-runs discovery. It cannot be handed a product. | `commerceHydration.buildCommerceOnlyBody` |

**Answer:** Watchlist must ask Commerce to refresh in exactly two ways, both
reusing existing code:

1. **URL enrichment (preferred, precise):** for a watched offer whose host is
   `farfetch.com` or `www.kickscrew.com`, call the existing adapter. This is a
   true "re-read this listing" and it returns a fresh price.
2. **Evidence re-discovery + URL re-match (fallback, imprecise):** replay the
   Watch's stored MODE B evidence, then find the offer in the result whose
   normalized URL equals the watched URL. If it is absent, that is
   **"not currently offered"**, which is *not* the same as "out of stock" and
   must not be worded as such.

**Do not build a second provider client.** Both seams exist. What does *not*
exist is a governed way for a caller to say *"enrich this URL"* on the
`scan-identify` path — `selectEnrichmentCandidates` derives candidates
**server-side from discovery results** (`scanCommerceRouter.ts:1181`), and
`index.ts:2126` only ever passes `fast.enrichmentCandidates`. Exposing a
caller-supplied, host-allowlisted enrichment request is the single narrowest
backend extension Watchlist needs.

### §22 Minimum evidence for "Price dropped from $248 to $179"

Required, and each item's current status:

| Requirement | Status today |
|---|---|
| A stable identity for *the thing whose price is being compared* | **Available** = normalized product URL |
| A prior numeric price + currency, attributed to that identity | **Not stored anywhere.** Nearest is `saved_scans.purchase_options[].price` — a display string on a scan snapshot, with no observation timestamp and no guarantee it is the same offer |
| A current numeric price + currency for the same identity | **Obtainable** via URL enrichment (2 retailers) or evidence re-discovery + URL match |
| A timestamp on each | `CanonicalOffer.observedAt` exists but is never persisted; `saved_scans.saved_at` is the scan time, not an observation time |
| Same-currency guarantee | **Must be enforced by the new engine.** Serper gives no currency field |

**Existing storage cannot support that sentence.** Watchlist needs its own
bounded observation record.

**Recommended bounded observation strategy** (recommendation only — §34
justifies it against actual data architecture):
> Persist **the latest observation inline on the Watch row**
> (`last_price_value`, `last_currency`, `last_observed_at`, `last_status`) and
> append to a separate observation table **only on a change that the engine
> classified as meaningful** — a price value change, a currency change, or an
> availability-class transition. Cap per-watch history at a small fixed
> N (a bounded window such as the last 20 meaningful events) and prune the
> oldest on insert.

Rationale from this codebase specifically: every existing store here is
explicitly bounded (`library.js` `MAX_SCANS = 25` per partition;
`normalizePurchaseOptions` `MAX_OPTIONS = 24`; `COMMERCE_CACHE_MAX_ENTRIES = 200`;
`ELISE_ADVICE_LIMITS.initialCandidatesPerSource = 40`;
`list_kplus_pending_revenuecat_sync` capped at 200). An unbounded per-user
time series would be the first unbounded store in the product.
**Do not default to unlimited snapshot retention.**

---

## 7. AUDIT AREA E — STOCK / AVAILABILITY / VARIANTS

### §23 Availability by provider

| Provider | in stock | out of stock | size availability | color availability | variant stock | Classification |
|---|---|---|---|---|---|---|
| Serper | — | — | — | — | — | **NOT PROVIDED** |
| Brave | — | — | — | — | — | **NOT PROVIDED** |
| Poshmark | implicit | implicit — sold/reserved listings are **silently filtered out** (`isAvailable`, `poshmarkProvider.ts:151`), never surfaced as a status | listing-level only | listing-level only | n/a (1-of-1) | **PARTIAL** (inferable from disappearance only) |
| Farfetch3 | — | — | — | — | — | **NOT PROVIDED** (the adapter reads title/brand/price/images only) |
| KicksCrew | — | — | upstream `variants[]` exists but is read **only** for lowest price | — | — | **NOT PROVIDED by the contract; PARTIAL upstream** |
| Vinted | — | — | `size` field parsed | — | — | **NOT PROVIDED** |
| `product_catalog` | `availability` column, default `'unknown'` | same | — | — | — | **NOT PROVIDED** (synthetic staging data) |

**No live provider reports availability as a field, in any form, today.**

### §24 "Tell me when my size is back in stock"

```
UNSUPPORTED on the current contract → POST-V1
```

Not merely provider-limited: there is no size on the commerce object at all,
and no provider currently returns per-size inventory through the parsed shapes.
The nearest upstream data is KicksCrew's `variants[]`, which is (a) one
retailer, (b) sneaker-route only, (c) default-OFF, and (d) currently reduced to
a scalar minimum price. Even a full KicksCrew variant passthrough would give
*variant list + price*, not *variant inventory*.

**Do not ship this promise in V1, and do not ship it "for supported retailers
only" either** — a size-restock feature that works for one flag-gated sneaker
retailer is a trust liability, not a feature.

### §25 "Tell me when this color comes back"

```
UNSUPPORTED → POST-V1
```

Worse than size: no provider parses color at all. `CanonicalPurchaseOption.variant`
falls back to `record.color` (`dressingRoomCommerce.ts:215`), but nothing on the
live path ever sets `color`. And `canonicalProductKey` does not read color, so
colorways of one product actively **collapse together**.

---

## 8. AUDIT AREA F — RETAILER ALTERNATIVES

### §26 Same product at another retailer

**A seam exists, and it is exactly one function.**

`buildCanonicalCommerce()` (`canonicalCommerce.ts:170`) groups a ranked product
list into `CanonicalProduct { productKey, offers[], lowestPriceValue, offerCount }`.
Its docstring states the intent verbatim: *"The same real-world item listed by
three retailers is one product with three offers"*, and retailer/provider are
**deliberately excluded from the key** so cross-retailer grouping can happen.

Its real state:
- Called in **one** place — `index.ts:2155`, MODE B only.
- Emitted as `canonicalProducts` — `index.ts:2238`.
- **Consumed by nothing.** Grep across the whole tree finds only the emitter,
  a v127 backend test, and a `canonicalProducts: []` fixture.
- Its grouping strength is a brand + 8-title-token hash.
- It only ever groups **within a single response** — it has no memory, so it
  cannot answer "cheaper somewhere else than where you're watching" across time.

**Map:** the seam is `canonicalCommerce.buildCanonicalCommerce` + the
`canonicalProducts` response field. **Do not invent a second one.** But its
evidence grade is too weak to carry a "same item, cheaper at X" claim in V1.

### §27 Cheaper alternative — the two claims are different

| Claim | Supported by | Grade |
|---|---|---|
| **Same product cheaper elsewhere** | `canonicalProductKey` grouping + `lowestPriceValue` | **Weak.** Title-hash identity, no UPC, single-response scope, unconsumed. **Not shippable as a same-product claim.** |
| **Similar product that is cheaper** | `type: 'similar'` (Brave), `similarityMatches` from deterministic `product_catalog` scoring, and Elise's deterministic `eliseCompatibilityScoring.ts` | **Adequate**, provided the copy says "similar", which the existing contract already distinguishes at the `type` field |

**Do not conflate them.** The codebase already keeps them apart; Watchlist must
inherit that discipline rather than erode it.

### §28 Retailer neutrality — collision risk

Neutrality is an enforced, tested invariant, in four independent places:

- `shoppingProvider.ts:80-92` — `AGGREGATOR_HOSTS` is *"deliberately NOT a
  retailer list: it names only the generic middlemen, so every actual retailer
  stays equally eligible."*
- `shoppingProvider.ts:24-33` — `brand` must never be derived from `source`,
  *"which is retailer identity, not brand, and must stay out of ranking"*.
- `commerceRelevanceAgreement.ts:298` — *"`source` / `retailer` are never read here."*
- `commerceType` provenance *"must never carry a ranking bonus or penalty
  (retailer-neutrality is a hard rule)"*.
- Tested: `commerceIdentity.v124.test.ts:353` *"retailer neutrality: the
  provider that returned a listing never scores"*; `commerceProviders.v126.test.ts:106`;
  `commerceFunnel.v127.test.ts:640` INVARIANT 12.
- Client-side: `commerceDestination.ts` repeats the same aggregator rule.

**Collision risk: LOW, conditional on three prohibitions.** Watchlist must not
create a watchlist-specific retailer ranking, a preferred-vendor refresh order,
or an affiliate-favoured alert. There is **no** transparent commercial-placement
system in this repo that would govern such a thing — `affiliateUrl` exists as a
persisted field but no code sets it, and `dressingRoomCommerce.ts:3` states
*"never rank by commission."*

The one genuine risk is **refresh-order neutrality**: URL enrichment is only
possible for Farfetch and KicksCrew, so those two watches get precise refreshes
while everything else gets imprecise re-discovery. That is a *capability*
asymmetry, not a ranking one — but the UI must not present it as retailer
preference, and refresh scheduling must not order retailers by enrichability.

---

## 9. AUDIT AREA G — WATCH INTENT

### §29 Feasibility of the four proposed V1 intents

| Intent | Verdict | Evidence |
|---|---|---|
| **JUST WATCHING** | **NARROW EXTENSION** | Needs new persistence + a refresh path. Every ingredient (URL identity, price parse, re-query) exists. |
| **BUY UNDER $___** | **NARROW EXTENSION** | The one threshold the user supplies. Needs a numeric price + currency — obtainable via `parseOfferPrice`. **Must refuse to arm when the currency cannot be determined**, which is the common Serper case. |
| **NOTIFY WHEN MY SIZE RETURNS** | **UNSUPPORTED → DEFER** | No size on the contract, no variant inventory from any provider (§12, §23, §24). |
| **FIND ME A BETTER MATCH** | **DEFER** | Requires either same-product cross-retailer identity (unsupported, §15) or a visual-similarity provider (`similarClothesProvider.ts` — BLOCKED_BY_PRIVACY_TRANSPORT + upstream 502). |

### §30 Minimum persistent fields per intent

Validated against what identity actually exists (conceptual only — no schema).

Shared by every intent:
- actor identity (server-derived, never client-supplied)
- **watched offer identity**: normalized `productUrl` (the authority) +
  `retailerLabel` (from `source`, display only) + optional `providerProductId`
  (Farfetch/KicksCrew only)
- **offer snapshot at watch time**: `title`, `imageUrl`, `priceDisplay`,
  `priceValue`, `currency`, `commerceType`, `type`
- **refresh evidence**: the MODE B evidence bundle needed to re-discover
  (`identification`, `attributes`, `searchQueries`, `market`) — this is the
  only way to refresh a non-enrichable retailer, and it is the payload
  `commerceHydration` already builds
- **lifecycle**: `status ∈ {active, paused, triggered, archived}`, `created_at`,
  `last_observed_at`, `last_alerted_at`, `schema_version`, `row_version`,
  `deleted_at`

| Intent | Additional fields | Validated against existing authority? |
|---|---|---|
| JUST WATCHING | none | ✅ |
| BUY UNDER $___ | `target_price_value`, `target_currency` | ✅ *only when* the watch-time snapshot yielded a confident currency |
| SIZE RETURNS | `selected_size`, `variant_id` | ❌ **no source for either** — do not model it |
| BETTER MATCH | similarity anchor | ❌ no supported evidence |

**`selected_variant` / `selected_color` must not appear in a V1 model.**
Persisting a field the pipeline can never populate creates exactly the false
authority this audit exists to prevent.

---

## 10. AUDIT AREA H — PERSISTENCE

### §31 Can existing tables support Watchlist safely?

```
CAN EXISTING TABLES SUPPORT WATCHLIST SAFELY?  NO
```

- `saved_scans` — wrong grain (scan, not offer); `purchase_options` is a
  deliberate immutable historical record the commerce cache design depends on.
- `wardrobe_wishlist_intents` — right *shape* (`source_item_id`, `intent`,
  `metadata jsonb`, soft delete, own-row RLS), wrong subject (a wardrobe item),
  wrong tier (free-tier, all flags off), and no commerce fields by explicit design.
- `dressing_room_items` — collaborative and transferable.
- `user_closet_items` — ownership authority.
- `product_catalog` — global synthetic staging data, no per-user dimension.

### §32 Smallest conceptual resource if new persistence is required

**Two resources, and the split is justified by their different retention
profiles, not by tidiness:**

1. **WATCH** — user intent. One row per watched offer per user. Low cardinality
   (bounded per user, see §58). Mutable lifecycle. Carries the *latest*
   observation inline so the list screen renders from one row with no join.
2. **WATCH OBSERVATION** — append-only, **meaningful changes only**, bounded
   per watch. Exists so "dropped from $248 to $179" can be *evidenced* rather
   than asserted.

A single-table design (latest observation only) is genuinely viable and is the
smaller step — but it can never answer "dropped from", only "is now". Given the
product thesis is explicitly a *decision-support* claim about change, the
second resource earns its place. **This is a recommendation only; nothing is
created by this audit.**

Both should follow `user_closet_items` verbatim, which is the newest and
strictest governed pattern in the repo.

### §33 User-scoped security — patterns to reuse

Every requirement already has a named implementation to copy from
`20260829203657_user_closet_items.sql`:

| Requirement | Existing pattern |
|---|---|
| actor-owned | `user_id uuid not null references auth.users(id) on delete cascade` |
| identity never client-chosen | `set_user_closet_items_insert_authority()` BEFORE INSERT trigger stamps `new.user_id = auth.uid()`; the UPDATE trigger reasserts `new.user_id = old.user_id` from the persisted row |
| RLS + K+ | `using (user_id = auth.uid() and public.has_active_k_plus())` on SELECT/INSERT/UPDATE — the no-arg wrapper over `kplus_has_active_entitlement`, so no policy ever accepts a client-suppliable user id |
| deletable | **soft delete only** — `deleted_at` tombstone, **no DELETE policy for any client role** |
| pauseable | `status` column + the same UPDATE policy (no new mechanism) |
| account-deletion aware | register in **both** `lib/account-deletion/user-data-resources.json` **and** `supabase/functions/_shared/deletion/userDataResources.ts` — `__tests__/deletionRegistryParity.test.js` fails CI if they drift. Note the Closet precedent: *"Deletion is intentionally independent of K+ status — `has_active_k_plus()` is never consulted by the deletion pipeline."* |
| export/privacy aware | `privacy-data-export` / `privacy-correction-request` Edge Functions (`verify_jwt = true`), rate-limited by `privacy_request_rate_limits` |
| grants | `revoke all … from anon, authenticated, public`; `grant select, insert, update to authenticated`; `revoke truncate, references, trigger, maintain` from everyone |
| optimistic concurrency | `row_version bigint` bumped server-side; `schema_version smallint` client-reported |

### §34 Retention — bounded strategy

**Unbounded growth is a real risk and it compounds three ways:**
users × watches/user × observations/watch/day.

Options evaluated against this codebase's actual data architecture:

| Option | Assessment |
|---|---|
| Store every observation | **Reject.** Would be the only unbounded per-user store in the product (see the bound inventory in §22). |
| **Store only meaningful changes** | **Recommend as the primary rule.** It is also exactly what the change engine has to compute anyway, so it costs nothing extra. A watch on a stable listing writes **zero** rows for weeks. |
| Daily coalescing | **Recommend as the secondary rule**, layered on the first: at most one observation row per watch per UTC day, so an oscillating price cannot spam the table. |
| Limited history window | **Recommend as the hard backstop**: a fixed per-watch cap, pruned oldest-first on insert. |
| Latest-only + significant events | This *is* the combination above (latest inline on the Watch, significant events appended). |

**Do not pick a retention number in C0.** The right cap is a function of the
observed change rate, which nothing in this repo measures yet — see §75
instrumentation gaps.

---

## 11. AUDIT AREA I — MONITORING / BACKGROUND EXECUTION

### §35 Existing scheduling infrastructure

**Searched exhaustively. Result: none in source.**

| Mechanism | Present? | Evidence |
|---|---|---|
| Supabase `pg_cron` | **NO** | The only two hits in the whole repo are comments in `202606090001_style_chat_burst_usage.sql` saying *"No pg_cron or external job required"* and *"Keeps the table small without requiring pg_cron or a separate job"* — i.e. a deliberate architectural stance toward lazy, on-read cleanup |
| `pg_net` / `net.http_post` | **NO** | zero hits |
| Scheduled Edge Functions | **NO definition in source** | — |
| Queues / workers | **Two worker-*shaped* functions, externally triggered** | `process-account-deletions` (`verify_jwt = false`, `x-deletion-worker-secret`, constant-time compare, `app_config` kill switch + dry-run, claims via `claim_deletion_requests_for_purge(worker_id, limit, interval)`) and `kplus-reconcile-revenuecat` (`verify_jwt = false`, `x-kplus-reconcile-secret`, drains `list_kplus_pending_revenuecat_sync(p_limit)` capped at 200) |
| Background jobs | **NO** | — |
| Notification schedulers | **NO** | — |
| Price refresh jobs | **NO** | — |
| Render cron | **NO** | `render.yaml` declares one free-plan web service, no `type: cron` |
| GitHub Actions cron | **NO** | zero `schedule:` keys across all 8 workflows |
| Client background tasks | **NO** | no `expo-task-manager`, no `expo-background-fetch` |

`docs/build34-trackb-b1b-deletion-repair-ledger.md:30` describes
`process-account-deletions` as *"pg_cron / scheduled dispatch, worker-secret
protected — YES, the live, scheduled purge path."* **The schedule is
operator-configured outside this repository.** The *pattern* is proven in
production; the *scheduler definition* is not in source.

### §36 How can K Scan periodically recheck watched items today?

```
EXISTING SCHEDULER:           ABSENT (no definition in source)
EXISTING BACKGROUND AUTHORITY: EXTENDABLE — the worker-secret Edge Function
                               pattern is live and proven twice
```

Real options, from source:

| Option | Classification | Notes |
|---|---|---|
| **Worker-secret Edge Function + operator-configured schedule**, exactly mirroring `process-account-deletions` / `kplus-reconcile-revenuecat` | **EXTENDABLE — recommended** | Reuses a proven, security-reviewed shape: `verify_jwt=false`, header secret with constant-time compare, `app_config` kill switch, dry-run, **bounded claim RPC** (`limit … greatest(1, least(coalesce(p_limit, 25), 200))`). Zero new architecture. |
| **User-open refresh** (refresh a user's watches when they open the Watchlist screen) | **READY** | Needs nothing new server-side beyond the refresh seam. Naturally rate-limited by human behaviour. **This alone delivers a usable V1 list screen.** |
| pg_cron / pg_net | **ABSENT** | Would introduce the first in-database scheduler; also an explicit reversal of a documented stance |
| Client background fetch | **ABSENT and inadvisable** | New native capability, OS-throttled, unreliable, and would move commerce refresh onto the device |
| Provider webhooks / push | **ABSENT** | No provider in use offers one |

### §37 Provider rate / cost limits (from repo only)

| Provider | Limit / cost | Source |
|---|---|---|
| Serper Shopping | *"2,500 free queries"*; *"pricing starting around $0.30 per 1000 queries"*; *"very high concurrency on paid usage"* | `docs/general-shopping-api-evaluation.md:145,150,158` — **repo-documented, vendor-advertised, not measured** |
| RapidAPI real-time-product-search | *"Basic at 100 requests / month with a hard limit"*; *"free-plan rate limit appears to be 1000 requests per hour"*; Pro ≈ $2.50/1000, PAYG ≈ $5.00/1000 | `docs/general-shopping-api-evaluation.md:66-67,151-153` |
| Brave Web Search | **UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED**. Code handles `429 → 'quota'` but no figure exists in repo | `shoppingProvider.ts:353` |
| Poshmark (RapidAPI) | **UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED**. Latency **is** measured: *"~13.9s for a real query"* | `poshmarkProvider.ts:15` |
| Farfetch3 (RapidAPI) | **UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED**. Latency ~3.0s | `commerceFunnelConfig.ts` |
| KicksCrew (RapidAPI) | **UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED**. Latency ~2.6s | `commerceFunnelConfig.ts` |

No numbers are invented here. Everything else is UNKNOWN.

### §38 Refresh frequency

**Do not propose high-frequency polling.** A reasonable V1 architecture on the
above:

```
RECOMMENDED V1 REFRESH MODEL

  Tier 1 — USER-OPEN REFRESH (ship first)
    Refresh a user's own active watches when they open the Watchlist surface,
    bounded and debounced (the 10-minute commerce cache TTL is a natural floor).
    Requires no scheduler at all.

  Tier 2 — AT MOST ONCE DAILY BACKGROUND SWEEP (ship second, behind a flag)
    A worker-secret Edge Function, operator-scheduled, draining a bounded
    claim RPC in small batches, with an app_config kill switch and dry-run —
    the process-account-deletions shape exactly.
    Daily is the correct starting cadence because:
      - price/availability drift is the reason the existing offer cache is
        10 minutes, but the *decision* the user is waiting on moves on a
        scale of days, not minutes;
      - the only quantified cost signal in the repo ($0.30/1000 Serper
        queries) makes per-watch-per-day the only defensible starting point
        until real fan-out is measured;
      - three of five providers have UNKNOWN quotas.
```

Anything faster than daily requires measured provider quota data that does not
exist yet.

---

## 12. AUDIT AREA J — MEANINGFUL CHANGE ENGINE

### §39 Can change detection stay deterministic?

**YES — and it must.**

| Signal | Deterministic today? |
|---|---|
| price change | **Yes.** `parseOfferPrice(raw) → {value, currency}` already exists and is pure (`canonicalCommerce.ts:85`). Compare numerically, same-currency only. |
| availability change | **Only as "offer no longer resolvable / no longer returned."** No provider gives a status field. This is honest but weak, and must be worded as such. |
| variant availability change | **No.** Not observable at all. |
| retailer alternative change | Deterministic *given* `buildCanonicalCommerce` grouping — but the grouping evidence is too weak to alert on (§15, §26). |

**No LLM is required for V1 monitoring, and none should be introduced into the
poll loop.** The precedent is explicit: `eliseCompatibilityScoring.ts:3` —
*"Numeric scores are never taken from model output."*

```
PREFERRED V1: DETERMINISTIC CHANGE DETECTION — ACHIEVABLE
```

### §40 Price-drop significance

**The user-supplied "Buy under $___" should be the primary and, in V1, the
*only* armed threshold.** It is the one rule the system does not have to infer,
it is trivially explainable ("you asked to be told under $150"), and it cannot
be wrong about the user's intent.

For passive watchers, **do not invent a universal percentage in C0.** What a
future threshold needs before it can be chosen:

- a measured distribution of observed price deltas per provider (nothing
  measures this today — `scan_commerce_events` records counts and durations,
  never prices);
- a same-currency guarantee, which Serper's currency-less price strings make
  non-trivial;
- a distinction between a real drop and a **listing substitution** (the URL
  still resolves but now advertises a different variant — the KicksCrew
  lowest-variant hazard of §13).

Recommended shape when it is eventually built: a threshold **configured in
one governed config module** (the `commerceFunnelConfig.ts` / `commerceRelevanceConfig.ts`
pattern — a named exported constant with a documented rationale and an env
override), **measured** against the distribution above, never hard-coded inline.
**Do not implement it.**

### §41 Notification collapse

**Product direction: one meaningful decision event per watch per cycle, and one
grouped message per user per cycle.** A cycle that finds a price drop *and* a
restock *and* a better retailer should produce one message, not three.

```
GROUPED EVENT SUPPORT: N/A — there is no notification infrastructure to group with (§42)
```

Because notifications are being built from zero, grouping is a **design
opportunity, not a retrofit**: the collapse rule should live in the change
engine (which already has to compute all signals for a cycle before deciding
anything), so the delivery layer only ever receives an already-collapsed event.
Building the engine to emit one event per watch per cycle costs nothing now and
is expensive to retrofit later.

---

## 13. AUDIT AREA K — NOTIFICATIONS

### §42 Current notification authority

```
CURRENT NOTIFICATION AUTHORITY: NONE
PUSH AVAILABLE:                 NO
LOCAL AVAILABLE:                NO
PREFERENCES:                    NO (placeholder only)
DEEPLINK:                       YES (routing exists; nothing to deliver it)
GROUPED EVENT SUPPORT:          N/A
WATCHLIST EXTENSION NEEDED:     ENTIRE SUBSYSTEM
```

Evidence:
- `package.json` dependencies: no `expo-notifications`, no `expo-task-manager`,
  no `expo-background-fetch`, no FCM/APNs SDK.
- `app.json` `expo.plugins`: `expo-camera`, `expo-image-picker`, `expo-router`,
  `expo-apple-authentication`, `expo-font`, `expo-location`, `expo-audio`.
  **No notification plugin.**
- No push-token table in any of the 130+ migrations.
- `hooks/usePermissionPreferences.ts` has a `'notifications'` key in
  `PermissionKey`, but `savePreferences()` sleeps 300ms and returns
  `{ ok: true, persisted: false, backendConnected: false, reason: 'backend_not_connected' }`.
  Its own docstring: *"Placeholder hook … Backend integration not yet connected."*
- `components/account-home/PermissionsStepV1.tsx:27`: *"Build 33: the Microphone
  and Notifications 'Coming Soon' cards were removed."*
- `services/transactionalEmail.js` exists (Resend-backed, used for
  account-restoration mail) — the **only** outbound user channel in the product,
  and it is lifecycle mail, not a product-notification system.

**This is the single largest gap between Smart Watchlist as described and what
K Scan can do today.** It is larger than the identity gap, because identity can
be narrowed around; a watch that cannot tell you anything cannot be narrowed
around.

### §43 Notification user controls

There is **no preferences system to extend**. Nothing would be *parallel* —
it would be first.

What exists and should be reused rather than duplicated:
- `contexts/PrivacyPreferencesContext.tsx` + `public.privacy_settings` — the
  established per-user preference table and RLS shape.
- Per-watch pause needs **no** new mechanism: it is a `status` column on the
  Watch row, governed by the same UPDATE policy.
- A global on/off belongs in the existing privacy/preferences surface
  (`app/privacy.tsx` already hosts the K+ entitlement block), **not** in a new
  settings screen.

### §44 Deep link

```
Routing: expo-router file-based; scheme `kscan://`
Universal links: applinks:kscan.app, Android autoVerify only for https://kscan.app/rooms
Custom resolution: app/+native-intent.ts (rooms only; everything else falls through
                   to Expo Router default path handling)
```

An alert **could** safely navigate to a Watch detail route once one exists
(`/watchlist/[watchId]` would resolve through the default handler with no
`+native-intent` change). Required future route, documented per instruction:

```
REQUIRED FUTURE ROUTE:  app/watchlist/index.tsx      (Watchlist home)
                        app/watchlist/[watchId].tsx  (Watch detail)
```

**Critical safety rule:** a deep link must carry only the **watch id**, and the
detail screen must load the offer from the user's own RLS-scoped row. It must
never carry a product URL, a price, or a retailer as link parameters — that
would make a notification payload into a commerce authority and reopen exactly
the untrusted-URL surface `commerceDestination.ts` exists to close.

---

## 14. AUDIT AREA L — CLOSET INTELLIGENCE

### §45 Closet is enrichment, not watch authority — architecture confirmed

The required direction is achievable and the codebase already enforces the
underlying rule. `attachmentProvenance.ts:7-11` and `attachmentContext.ts:184`
state it plainly: *"saving does not prove ownership. Never 'owned'"*, and
ownership is **server-derived** and *"authoritative for any ownership claim"*.

The Watch's product identity comes from Commerce (§10). Closet may annotate the
decision. It must never participate in identity. Nothing in the current code
would push it the other way.

### §46 Duplicate risk — "Do I already own something very similar?"

```
DUPLICATE RISK: PARTIAL
```

- **Available:** `services/free-tier/duplicateDetector.ts` — a deterministic
  attribute scorer (category gate required, then color +2, brand +2, material
  +1, silhouette +1, style-tag overlap +1, title-keyword overlap +1), returning
  `{hasPossibleDuplicate, confidence, reasonLabels, matchingItemIds}`. Its
  header is exactly the right posture: *"Attribute-based similarity only
  ('possible duplicate'). Never claims an exact or visual match."*
- **Constraints:** it runs **client-side, over local free-tier `NormalizedItem`s**,
  and is gated by a default-off flag. The **authoritative** owned-item source is
  `user_closet_items` (K+ gated, server-side).
- **Safe claim today:** *"You may already own something similar"* with the
  matched items shown so the user judges. **Unsafe:** any assertion of an exact
  or visual duplicate.

Use the ownership grounding contract for the *ownership* half of the claim and
the deterministic attribute scorer for the *similarity* half. Create no new
Watchlist similarity infrastructure.

### §47 Compatibility claims

```
"This item works with several things you own."         → SUPPORTABLE (qualitative)
"This item works with exactly 11 things you own."      → NOT SUPPORTABLE
```

`eliseCompatibilityScoring.ts` is genuinely deterministic and would support a
qualitative claim. But the retrieval it scores is **bounded and possibly
partial**, by design:

- `ELISE_ADVICE_LIMITS`: `initialCandidatesPerSource: 40` → `rankedCandidates: 24`
  → `groundedShortlist: 10`.
- `EliseWardrobeRetrievalResult` carries `partialFailure: boolean` and a
  `rejectedCount` — retrieval can legitimately be incomplete.
- The Closet itself is local-first; cloud `user_closet_items` is K+ only and
  its client sync (Track B B2b/B2c) is recent.

An exact count over a capped, possibly-partial, possibly-unsynced inventory is
**fake precision**. Qualitative is the only honest register.

### §48 Wardrobe gap claims

```
WARDROBE GAPS: WEAK — NOT SUFFICIENT FOR A WATCHLIST CLAIM
```

`analyzeWardrobeGap()` (`eliseWardrobeGap.ts:24`) computes gaps as
**role-coverage over the shortlist**, not over the wardrobe: it collects
`layeringRole` values present in the ≤10-item shortlist and reports the missing
ones from a fixed six-role list. It flags `partialInventory` when
`partialFailure || inventoryCount < 3`.

That is a sound *styling* signal inside a conversation. It is **not** evidence
that an item "fills a gap in your wardrobe" — the shortlist is not the wardrobe.
Do not assume the existing gap reasoning is exhaustive enough for Watchlist.

### §49 Do not build a personal score

**Agreed, and the codebase agrees.** There is no deterministic authority that
could ground a `BUY SCORE: 87` or a `WARDROBE VALUE SCORE`. Every numeric
authority present (`matchScore`, `similarityPercentage`, Elise compatibility
scores) is scoped to *this comparison in this context* and none is calibrated
across users, categories or time. `AGENTS.md` also prohibits it directly:
*"Do not fabricate features, metrics, retailer integrations, or backend
capabilities."*

Decision **explanations** ("price is $30 below what you saw", "you asked to be
told under $150") are supportable and preferable.

---

## 15. AUDIT AREA M — UI / PRODUCT SURFACES

### §50 Natural Watch entry points

| Surface | File | Verdict | Reason |
|---|---|---|---|
| **ProductShelf card** | `components/ProductShelf.tsx:381-489` | **SAFE V1 ENTRY** | The one governed commerce card. Already renders a per-product action row with an eligibility gate (`canAddProductToDressingRoom`, title + real remote image) and a governed destination (`selectCommerceDestination`). A "Watch" action sits beside "Add to Dressing Room" with no new plumbing. |
| **Multi-item commerce section** | `components/scan-results/MultiItemCommerceSection.tsx` + `ScanResultV2.tsx:478` | **SAFE V1 ENTRY** | Renders the same governed offers via the same shelf contract. |
| **Scan result card** | `components/scan/ScanResultCard.tsx:53` | **SAFE V1 ENTRY** | Already applies `canAddProductToDressingRoom` to `primaryMatch`. |
| **Recent Scans / Library** | `app/library.tsx` (imports `Product` from ProductShelf) | **POSSIBLE LATER ENTRY** | Its offers are a **historical snapshot** — the price shown may be arbitrarily stale. Watching from here needs a re-verify hop first, or the watch baseline is a lie. |
| **Dressing Room item** | `components/dressing-rooms/*`, `services/dressingRoomCommerce.ts` | **POSSIBLE LATER ENTRY** | Rooms are collaborative; a private monitoring rule attached to a shared object is a permissions trap. |
| **Elise / StyleChat commerce result** | `stylechat-generate` attachments | **DO NOT USE** | Attachment provenance and `intentAllowsCommerce` govern this surface; adding a watch action would entangle Watchlist with attachment authorization for no V1 gain. |
| **Secondhand shelf** | `components/SecondhandShelf.tsx` | **DO NOT USE in V1** | Vinted listings are 1-of-1 resale items. "Watching" one is really "tell me when it's gone", which inverts the product promise. |

### §51 Watchlist home

Current navigation is **expo-router file-based with no bottom tab bar**.
`app/index.tsx` renders `components/home/HomeLuxuryTechV1.tsx`, which pushes to
`/scan`, `/text-scan`, `/style-chat`, `/dressing-rooms`, `/privacy`, and to
`/library` with a `section` param (`'recent' | 'closet'`).

```
RECOMMENDATION: a K+ tile on the existing home surface, routing to /watchlist.
```

- **Do not add a bottom tab** — there is none to add to.
- **Do not add a third `library` section** — `app/library.tsx` already carries
  a `CLOSET_SEPARATION_V1`-gated two-tab structure (`recent` / `closet`) whose
  section state is deliberately *"explicit route state, never inferred"*.
  Adding a third tab makes Watchlist look like a Closet subsection, which is
  precisely the wrong mental model (watched ≠ owned).
- The home tile pattern (`SectionHeader` + tile with `title`/`onPress`) is the
  smallest discoverable entry, and it is the same pattern the sibling K+
  feature uses.
- Gate the tile with `<KPlusGate source="watchlist">` (`components/kplus/KPlusGate.tsx`),
  which is documented as the component *"every future K+ feature entry point
  should render through."*

### §52 Watch detail — minimum V1 information hierarchy

```
1. Product image + title              (untrusted display text, escaped)
2. Retailer label                      (from `source`; neutral, never ranked)
3. Current price + currency            (or "price unavailable" — never "$0")
4. Price at the time you saved it      (the watch-time snapshot)
5. Watch intent                        ("Just watching" | "Buy under $X")
6. Status line                         ("Still listed" | "No longer listed" | "Not checked yet")
7. Last checked                        (relative timestamp; must never be hidden)
8. Meaningful changes                  (bounded list; empty state is normal and fine)
9. Pause / Delete                      (status update; soft delete)
--- secondary, collapsed ---
10. Closet context                     (qualitative only: "you may already own something similar")
11. Open at retailer                   (via selectCommerceDestination only)
```

Deliberately **absent from V1**: selected variant, selected size, stock status,
"cheaper elsewhere", any score. **Do not over-design.**

Two copy rules that follow directly from the identity findings:
- Never say "your size" or name a color — no variant authority exists (§12).
- "Last checked" is load-bearing. When refresh is daily-at-best and
  best-effort, hiding staleness is the fastest way to lose the user's trust.

---

## 16. AUDIT AREA N — PRIVACY / SECURITY

### §53 Threat model — reusable defenses

| Threat | Existing defense to reuse |
|---|---|
| forged product ids | `id` is server-derived (`makeId` hash of URL / provider id). A Watch must **never** accept a client-supplied product id as authority — resolve everything from the stored row. |
| forged retailer ids | Retailer is a display label derived from `source`/hostname; it carries no privilege anywhere (retailer neutrality, §28). |
| cross-account watch ids | `user_closet_items` RLS + trigger pattern (§33). Proven in staging for K+: *"cross-account read returns empty, cross-account and same-account direct mutation both return 42501"*. |
| malicious commerce metadata | Server: length clamps (`MAX_TITLE_LEN 160`, `MAX_PRICE_LEN 24/32`, `MAX_SOURCE_LEN 60`), `str()` type coercion. Client: `cleanText()` strips C0/C1 control chars and collapses whitespace. Prompt path: `escapePromptData()` + `promptHardening.ts`. |
| malicious product URLs | Three independent HTTPS-only validators: `shoppingProvider.normalizeUrl` (server), `commerceDestination.isSafeCommerceUrl` (client, open), `dressingRoomCommerce.normalizePersistedCommerceUrl` (client, persist). All reject non-HTTPS, embedded credentials, loopback/RFC1918/169.254. The persist-time one additionally rejects signed storage paths, `x-amz-*`/`x-goog-*`, and JWT-shaped values. |
| price manipulation | `parseOfferPrice` rejects non-finite and ≤ 0; `toSnapshotPrice` nulls empty/zero; `formatCommercePrice` rejects `"0"`, `"0.00"`, `"$0.00"`. |
| stale product identity | **No existing defense.** New: `last_observed_at` must be surfaced, and a listing that fails to resolve N cycles running must degrade to "no longer listed" rather than keep asserting a stale price. |
| variant collision | **No existing defense, and none possible** (§13). Mitigated only by never making variant claims. |
| notification deep-link spoofing | Deep link carries the watch id only; the screen loads from the RLS-scoped row (§44). |
| unbounded observation growth | Bounded-store precedent throughout (§22, §34). |

### §54 Product URL safety

**Watchlist must persist the URL — it is the identity — but it must persist the
*governed* one.**

The exact contract to reuse: store only what
`normalizePersistedCommerceUrl()` returns (it is already the persistence-time
authority for `saved_scans.purchase_options` and Dressing Room items), and
render/open only through `selectCommerceDestination()`. A URL that fails either
gate is not a watchable offer, and the Watch should be refused at creation
rather than stored and later found unusable.

**Do not allow arbitrary URLs to become commerce authority.** A client-supplied
"watch this URL" free-text entry point would be exactly that, and would also
turn the refresh worker into an SSRF-capable fetcher on behalf of users. V1
watches must originate from a governed commerce result.

### §55 Commerce metadata is untrusted

Confirmed and already treated as such. `title`, `brand`, `source`, `price`,
`condition`, `size`, image URLs and product URLs all come from third-party
search/marketplace APIs. Existing validation is mapped in §53. React Native
`<Text>` gives no HTML-injection surface, but the **prompt** surface does, which
is why `escapePromptData()` exists — any future Closet enrichment that puts a
watched product's title into an Elise prompt must route through it.

### §56 Cross-account boundary

```
User A cannot read / update / pause / delete User B's watch.
```

Inherited wholesale from `user_closet_items`, with **no new auth architecture**:
`user_id = auth.uid()` in every policy, `has_active_k_plus()` for the tier gate,
BEFORE INSERT/UPDATE triggers re-stamping identity from server state, no DELETE
policy for any client role, `revoke all … from anon, authenticated, public`
followed by explicit narrow grants.

---

## 17. AUDIT AREA O — COST / SCALE

### §57 Model calls

**Monitoring requires zero LLM calls.** Price comparison and
listing-resolvability are pure functions over provider output. `parseOfferPrice`
already exists and is pure.

```
MODEL CALLS REQUIRED FOR MONITORING:          0
MODEL CALLS REQUIRED FOR CLOSET ENRICHMENT:   0 for duplicate hints
                                              (duplicateDetector is deterministic);
                                              1 stylechat-generate call only if
                                              narrative Closet advice is added —
                                              optional, user-initiated, never in
                                              the poll loop
```

### §58 Scale model

| Operation | Scales with |
|---|---|
| Watch row storage | users × watches/user |
| Watch list render | watches/user (single RLS-scoped query) |
| **Refresh provider calls** | **active watches × refresh frequency** — the dominant term |
| Observation rows | active watches × *meaningful-change rate* (not × frequency, if §34 is followed) |
| Change evaluation | active watches (pure CPU) |
| Notification sends | users × cycles with ≥1 meaningful change (if §41 collapse is honoured) |
| Provider cache benefit | **≈ none across watches** — both caches are per-isolate in-memory, and MODE B's key is *evidence*, not URL, so two users watching the same jacket from different scans get different keys |

Conceptually, at 1 / 10 / 50 watches per user, storage and render stay trivial;
**provider fan-out is the only term that matters**, and it is linear in active
watches with no batching or sharing available today.

### §59 Provider fan-out

**Monitoring 20 watched products causes up to 20 independent provider
interactions today, and possibly more than 20 upstream calls.**

Verified:
- No batch endpoint exists on any adapter. Every function signature is
  single-subject: `enrichFarfetchProductByUrl(productUrl)`,
  `enrichKicksCrewProductByUrl(productUrl)`,
  `getShoppingResults({query, limit, timeoutMs})`,
  `searchPoshmarkProducts(query, {limit})`.
- Both caches are **per-isolate `Map`s** — no Redis, no shared cache, no
  database-backed cache. Cold starts empty them.
- The MODE B cache key is a **fingerprint of structured evidence**, not a URL,
  so it cannot deduplicate two users watching the same listing.
- The evidence-re-discovery fallback is **worse than 1:1**: one MODE B refresh
  fans out to Serper (or Brave) **plus** Poshmark in parallel, then optionally
  up to `MAX_ENRICHMENT_CANDIDATES = 2` enrichment calls — so one watch refresh
  can be 2–4 upstream calls.
- URL enrichment is exactly 1 upstream call per watch, which is why it is the
  preferred refresh path where available.

**Do not design an optimization yet.** The measured behaviour above is the
finding; the first correct move is Tier-1 user-open refresh, which makes fan-out
proportional to engagement rather than to inventory.

---

## 18. REQUIRED PRODUCT JOB MATRIX (§60, §71)

| Job | Classification | V1 scope | Why |
|---|---|---|---|
| **A — "Watch this item."** | **NEW PERSISTENCE REQUIRED** (+ NARROW EXTENSION) | **MUST SHIP** | Identity (normalized URL) and the entry point (ProductShelf action row) both exist. Needs a Watch resource + a K+ gate. |
| **B — "Tell me when it drops below $150."** | **NEW PERSISTENCE REQUIRED** (+ NARROW EXTENSION) | **MUST SHIP** | The only threshold the user supplies. Needs `parseOfferPrice` + a same-currency guard; must refuse to arm without a confident currency. |
| **C — "Tell me when my size comes back."** | **UNSUPPORTED → POST-V1** | **UNSUPPORTED** | No size, no variant, no inventory on the contract or from any live provider (§12, §23, §24). |
| **D — "Tell me when this exact product is cheaper somewhere else."** | **POST-V1** | **DEFER** | Requires cross-retailer same-product proof. No UPC/GTIN/MPN exists; the only grouping is a title-token hash (§15, §26). Shipping this on current evidence would be **UNSAFE**. |
| **E — "Find a similar cheaper alternative."** | **PROVIDER-LIMITED → POST-V1** | **DEFER** | "Similar" is expressible (`type: 'similar'`, catalog similarity), but the visual-similarity provider is `BLOCKED_BY_PRIVACY_TRANSPORT` and its vendor returned 502. A commerce re-search per watch also multiplies fan-out. |
| **F — "Do I already own something similar?"** | **SUPPORTED NOW (qualitative only)** | **SHOULD SHIP** | `duplicateDetector.findPossibleDuplicates` + server-derived ownership provenance. Wording must stay "possible / may already own". |
| **G — "Does this work with my Closet?"** | **SUPPORTED NOW (qualitative only)** | **DEFER to C5** | `eliseCompatibilityScoring` is deterministic, but retrieval is bounded/partial — "several things" yes, counts no (§47). Not core to the watch loop. |
| **H — "Is this still worth buying?"** | **POST-V1** | **DEFER** | Would need a buy-score authority that deliberately does not exist (§49). Replace with explanations. |
| **I — "Pause this watch."** | **NEW PERSISTENCE REQUIRED** (trivial) | **MUST SHIP** | A `status` column under the existing UPDATE policy. No new mechanism. |
| **J — "Delete this watch."** | **NEW PERSISTENCE REQUIRED** (trivial) | **MUST SHIP** | Soft delete via `deleted_at`, matching `user_closet_items` (no client DELETE policy). |

**Also MUST SHIP, though not enumerated in the brief:** notification delivery
(§42) — without it, Jobs A, B, I and J produce a list the user must remember to
open, which is a bookmark, not a watchlist.

---

## 19. FILE INVENTORY (§63)

Exact files inspected at `157606c9`.

**Commerce authority**
- `supabase/functions/scan-identify/index.ts` (MODE A/B orchestration, rate limits, quota, response contract)
- `supabase/functions/scan-identify/scanCommerceRouter.ts`
- `supabase/functions/scan-identify/commerceFastPath.ts`
- `supabase/functions/scan-identify/commerceFunnelConfig.ts`
- `supabase/functions/scan-identify/commerceResultCache.ts`
- `supabase/functions/scan-identify/qualityTuneCommerce.ts`
- `supabase/functions/scan-identify/commerceRelevanceAgreement.ts`
- `supabase/functions/scan-identify/commerceRetrievalConfig.ts`
- `supabase/functions/scan-identify/commerceIdentityConfig.ts`
- `services/commerceHydration.ts`, `services/multiItemCommerce.ts`, `services/commerceDestination.ts`
- `supabase/config.toml` (per-function `verify_jwt` posture)

**Product identity**
- `supabase/functions/scan-identify/canonicalCommerce.ts`
- `types/scanIdentification.ts` (`RankedScanProduct`)
- `types/canonicalDressingRoomItem.ts` (`CanonicalPurchaseOption`)
- `src/utils/productSnapshot.ts`
- `services/dressingRoomCommerce.ts` (`normalizePurchaseOptions`, `optionFingerprint`)

**Provider normalization**
- `supabase/functions/scan-identify/shoppingProvider.ts` (Serper + Brave)
- `supabase/functions/scan-identify/poshmarkProvider.ts`
- `supabase/functions/scan-identify/farfetch3Provider.ts`
- `supabase/functions/scan-identify/kicksCrewProvider.ts`
- `supabase/functions/scan-identify/similarClothesProvider.ts` (disabled)
- `supabase/functions/product-search-deals/index.ts`, `services/productSearchDeals.ts`
- `supabase/functions/kickscrew-sneaker-description/index.ts`, `services/sneakers/providers/kickscrewRapidApi.ts`
- `supabase/functions/nike-shoe-details/index.ts` (experimental, 404 upstream)
- `supabase/functions/search-vinted-secondhand/index.ts`, `services/secondhand.js`

**Saved products / persistence**
- `supabase/migrations/20260617215307_create_saved_scans.sql`
- `supabase/migrations/20260717201524_20260716035943_add_purchase_options_to_saved_scans.sql`
- `supabase/migrations/202606290001_product_catalog.sql`, `supabase/staging-v2/seed-synthetic.sql`
- `supabase/migrations/20260704175544_free_tier_utility_tables.sql` (`wardrobe_wishlist_intents`)
- `services/library.js`, `services/savedScansCloud.ts`
- `services/free-tier/wishlistIntent.ts`, `freeTierStorage.ts`, `freeTierSupabaseSync.ts`, `freeTierSyncQueue.ts`
- `hooks/useWishlistIntent.ts`, `hooks/useWardrobeUtility.ts`
- `constants/freeTierBackendFlags.ts`, `constants/freeTierUtilityFlags.ts`

**Closet**
- `supabase/migrations/20260829203657_user_closet_items.sql` (+ `…204635_…optimize_rls_initplan`, `…220316_…media`)
- `supabase/functions/stylechat-generate/eliseWardrobeRetrieval.ts`
- `supabase/functions/stylechat-generate/eliseCompatibilityScoring.ts`
- `supabase/functions/stylechat-generate/eliseWardrobeGap.ts`
- `supabase/functions/stylechat-generate/eliseAdviceTypes.ts`, `eliseAdvicePipeline.ts`, `eliseAdvicePrompt.ts`
- `supabase/functions/stylechat-generate/attachmentProvenance.ts`, `attachmentContext.ts`
- `services/free-tier/duplicateDetector.ts`, `hooks/useDuplicateHints.ts`
- `services/closetLibrary.js`, `services/ownedClosetItems.ts`, `hooks/useOwnedClosetItems.ts`

**K+**
- `supabase/migrations/20260829120000_kplus_entitlements.sql`
- `supabase/migrations/20260829180000_fix_grant_kplus_early_access_variable_conflict.sql`
- `supabase/functions/kplus-activate/`, `supabase/functions/kplus-reconcile-revenuecat/`
- `components/kplus/KPlusGate.tsx`, `components/kplus/KPlusEarlyAccessSheet.tsx`
- `hooks/useKPlusEntitlement.ts`, `services/kplus/{kplusClient,kplusEntitlementStore,kplusTelemetry}.ts`
- `types/entitlements.ts`, `docs/build34-kplus-ledger.md`

**Notifications**
- `hooks/usePermissionPreferences.ts` (placeholder)
- `components/account-home/PermissionsStepV1.tsx`
- `package.json`, `app.json` (absence of any notification dependency/plugin)
- `services/transactionalEmail.js` (lifecycle email only)

**Scheduling / background jobs**
- `supabase/functions/process-account-deletions/index.ts`
- `supabase/functions/_shared/deletion/common.ts`
- `supabase/migrations/20260722191013_account_deletion_lifecycle.sql` (`claim_deletion_requests_for_purge`)
- `supabase/migrations/20260723021145_account_deletion_security_hardening.sql`
- `render.yaml`, `.github/workflows/*.yml`, `supabase/migrations/202606090001_style_chat_burst_usage.sql`

**Telemetry**
- `supabase/migrations/20260720120000_scan_commerce_events.sql`
- `supabase/migrations/20260823175314_scan_commerce_events_accuracy_telemetry.sql`
- `supabase/functions/scan-identify/commerceOutcomeCapture.ts`, `commerceOutcomeCaptureConfig.ts`
- `services/kplus/kplusTelemetry.ts`, `services/closetTelemetry.ts`

**Navigation / UI**
- `app/_layout.tsx`, `app/index.tsx`, `app/library.tsx`, `app/privacy.tsx`, `app/+native-intent.ts`
- `components/home/HomeLuxuryTechV1.tsx`
- `components/ProductShelf.tsx`, `components/SecondhandShelf.tsx`
- `components/scan-results/{MultiItemCommerceSection,ScanResultV2,SimilarFindsShelf}.tsx`
- `components/scan/ScanResultCard.tsx`, `components/AnalysisCard.tsx`
- `app.json` (scheme, associated domains, intent filters)

**Security**
- `supabase/functions/scan-identify/index.ts` (rate limiting, fingerprinting, image validation)
- `supabase/migrations/20260808115735_enforce_rpc_privilege_boundary.sql`
- `supabase/migrations/20260803020000_provider_request_security.sql`
- `supabase/functions/stylechat-generate/promptHardening.ts`
- `services/dressingRoomCommerce.ts` (`normalizePersistedCommerceUrl`)

**Deletion / privacy**
- `supabase/functions/_shared/deletion/userDataResources.ts`
- `lib/account-deletion/user-data-resources.json`
- `supabase/functions/privacy-data-export/index.ts`, `privacy-correction-request/index.ts`
- `supabase/migrations/20260808103028_privacy_request_rate_limits.sql`
- `docs/build34-trackb-b1b-deletion-repair-ledger.md`

**Governance / conventions**
- `AGENTS.md`, `docs/build34-trackb-convergence.md`, `docs/general-shopping-api-evaluation.md`
- `docs/BACKEND_DEPLOYMENT_AUTHORITY.md`, `docs/edge-function-deployment.md`
- `config/edge-function-manifest.json`

---

## 20. PRODUCT IDENTITY VERDICT (§64)

```
CANONICAL PRODUCT ID:      NONE exposed to any client.
                           Server-only `CanonicalProduct.productKey`
                           = fnv1a(brand + first 8 sorted title tokens),
                           built on the MODE B path, consumed by nothing.
                           The de-facto working identity is the
                           NORMALIZED PRODUCT URL.

SOURCE:                    canonicalCommerce.canonicalProductKey (server, unused)
                           shoppingProvider.normalizeUrl (server, load-bearing)
                           dressingRoomCommerce.normalizePersistedCommerceUrl (client, persist)

STABILITY:                 URL       — STRONG while the retailer keeps the URL
                           productKey— UNSTABLE (title-derived)
                           id        — deterministic, but it IS the URL under a hash

CROSS-QUERY STABILITY:     PARTIAL. Identity survives if the same listing is
                           returned again, but Serper returns a ranked top-8 —
                           a watched listing can silently fall out of results
                           without changing price or availability.

CROSS-RETAILER STABILITY:  ABSENT. No UPC / GTIN / EAN / MPN anywhere in the
                           repository. `CanonicalProduct.model` is always null
                           (no provider sets `model`).

VARIANT ID:                ABSENT from the commerce contract.
                           Upstream only: KicksCrew `variants[].sku`
                           (flag-gated, collapsed to first-variant `id`).
SIZE IDENTITY:             ABSENT from the contract.
                           Parsed then discarded for Poshmark and Vinted.
COLOR IDENTITY:            ABSENT entirely. Never parsed by any provider.
                           Actively erased by canonicalProductKey.

SAME PRODUCT CLAIM:        NOT SUPPORTED across retailers.
                           SUPPORTED only as "the same listing" (URL equality).
SIMILAR PRODUCT CLAIM:     SUPPORTED — `type: 'similar'` (Brave) and
                           deterministic catalog `similarityMatches`.
                           Visual similarity BLOCKED_BY_PRIVACY_TRANSPORT.

WATCHLIST IDENTITY VERDICT: PARTIAL
```

---

## 21. PROVIDER CAPABILITY MATRIX (§65)

Only providers actually present in `157606c9`.

| Provider / Source | Default | Product ID | Variant ID | Price | Stock | Size Stock | Color Stock | Refresh by ID | Cross-Retailer Identity |
|---|---|---|---|---|---|---|---|---|---|
| **Serper Shopping** | **ON** (`SHOPPING_ENABLED != false`) | Synthetic (hash of URL) | No | Display string, **no currency field** | No | No | No | **No** — keyword search only | No |
| **Brave Web Search** | **ON** (fallback) | Synthetic (hash of URL) | No | **None** | No | No | No | **No** — keyword search only | No |
| **Poshmark** | OFF (`POSHMARK_ENABLED`) | `listingId` (real) | n/a — listing *is* the variant | Numeric + currency | Implicit only (sold listings silently filtered out) | Listing-level | Listing-level | **No** — keyword search only | No |
| **Farfetch3** | OFF (`FARFETCH3_ENABLED`) | `internalProductId` (real) | No | `productPrice.final` numeric + ISO currency | No | No | No | **By URL** (`/searchByURL`) — no `/search` endpoint exists (404, proven live) | No |
| **KicksCrew** (sneaker route only) | OFF (`KICKSCREW_ENABLED`) | first-variant `sku` or `product.id` | **Upstream `variants[]` exists**, discarded by the adapter | **Lowest variant price** + currency | No | No | No | **By URL** (`/description/byurl`) | No |
| **`kickscrew-sneaker-description` Edge Fn** | Deployed, `verify_jwt=true` | raw upstream | raw upstream (unparsed) | raw upstream | No | No | No | **By URL, client-callable** (origin-locked) | No |
| **`product-search-deals` (RapidAPI)** | Deployed, `verify_jwt=true` | raw upstream, **unnormalized** | unknown | raw upstream | unknown | unknown | unknown | **No** — `q` only | No |
| **`search-vinted-secondhand`** | Deployed, `verify_jwt=true` | `id`/`itemId` | n/a (1-of-1) | string + currency | No | `size` parsed | No | **No** — query only | No |
| **`nike-shoe-details`** | Deployed but **experimental** — header: upstream 404 for tested URLs, *"do not wire into production flows"* | — | — | — | — | — | — | By URL (unproven) | No |
| **`product_catalog` table** | Staging synthetic seed only | `external_product_id` | No | `price numeric` + `currency` | `availability` column, default `'unknown'` | No | No | By row id | No |
| **`similarClothesProvider`** | **Not wired** — BLOCKED_BY_PRIVACY_TRANSPORT; vendor 502 | — | — | — | — | — | — | — | Not same-product evidence |

---

## 22. EXISTING SAVE / PERSISTENCE MAP (§66)

```
EXISTING SAVED PRODUCT AUTHORITY:
  NONE at product grain. Three adjacent authorities exist:
    (a) saved_scans            — scan grain, with a frozen purchase_options[] snapshot
    (b) dressing_room_items    — product grain, but collaborative/shareable semantics
    (c) wardrobe_wishlist_intents — wardrobe-item grain, free tier, all flags OFF,
                                    explicitly "no commerce, no price tracking"

SERVER PERSISTENCE:
  saved_scans (RLS, soft-delete only)                                     — LIVE
  dressing_rooms / dressing_room_items (RLS, participant model)           — LIVE
  wardrobe_wishlist_intents (RLS incl. DELETE)                            — table exists; writer flag-gated OFF
  user_closet_items (RLS + has_active_k_plus())                           — K+, staging
  product_catalog (no RLS policy; documented as expected)                 — staging synthetic

CLIENT PERSISTENCE:
  services/library.js — expo-file-system JSON manifest, MAX 25 records per
    actor partition, atomic tmp/bak swap, ownership via actorContext
  services/free-tier/freeTierStorage.ts — AsyncStorage, versioned envelope,
    device-scoped, explicitly "no backend sync"

SYNC:
  saved_scans        — services/savedScansCloud.ts, gated by CLOUD_SAVED_SCANS_ENABLED
  free-tier stores   — services/free-tier/freeTierSupabaseSync.ts + freeTierSyncQueue.ts,
                       gated by four EXPO_PUBLIC_FREE_TIER_BACKEND_* flags, ALL default false
  closet             — Track B B2b/B2c client sync (K+)

RLS:
  Uniform own-row pattern. Newest and strictest: user_closet_items —
  auth.uid() + has_active_k_plus() on SELECT/INSERT/UPDATE, no DELETE policy,
  BEFORE INSERT/UPDATE triggers re-stamping user_id / row_version / timestamps,
  revoke-all-then-narrow-grant.

ACCOUNT DELETION:
  Dual registry (lib/account-deletion/user-data-resources.json  +
  supabase/functions/_shared/deletion/userDataResources.ts), parity enforced by
  __tests__/deletionRegistryParity.test.js. Executed by the worker-secret
  process-account-deletions function with post-purge residual verification.
  Storage prefixes registered separately in STORAGE_RESOURCE_TEMPLATES.

CAN WATCHLIST EXTEND IT?:
  NO. See §17. A distinct, K+-gated, user-scoped Watch resource is required.
```

---

## 23. WATCHLIST PERSISTENCE RECOMMENDATION (§67)

*Recommendation only. Nothing below is created, migrated, or deployed by this audit.*

```
NEW PERSONAL DATA CLASS REQUIRED:   YES
NEW TABLE REQUIRED:                 YES (1 required, 2 recommended)
NEW OBSERVATION RESOURCE REQUIRED:  YES (recommended, bounded)
NEW STORAGE REQUIRED:               NO
NEW EDGE FUNCTION REQUIRED:         YES (1)
NEW SCHEDULER REQUIRED:             YES (external, operator-configured) — Tier 2 only
```

**NEW PERSONAL DATA CLASS — YES.**
"Products this user is considering buying, and the price they will buy at" is a
new class of personal data: it is commercial intent, it is durable, and it is
more sensitive than either a scan or a closet item. It must be registered in
the deletion registry (both mirrors), covered by the privacy export, and
declared in the privacy policy surface.

**NEW TABLE — YES.**
No existing table can carry it without destroying its own semantics (§17, §31).
The Watch table is the minimum. It must follow `user_closet_items` exactly.

**NEW OBSERVATION RESOURCE — YES (recommended).**
Required to *evidence* "dropped from $248 to $179" rather than assert it. Must
be bounded three ways: meaningful-changes-only, daily-coalesced, fixed per-watch
cap (§34). A single-table latest-observation-only design is an acceptable
smaller first step, at the cost of never being able to show a "from" price.

**NEW STORAGE — NO.**
Watchlist persists remote image URLs, never image bytes. It must **not** copy
retailer images into `style-library-images` — that would add a storage prefix to
the deletion registry and a media-privacy surface for no product gain.

**NEW EDGE FUNCTION — YES, exactly one.**
A `watchlist-refresh` function that (a) resolves a bounded batch of watches via
a bounded claim RPC, (b) refreshes each by URL enrichment where the host allows
it and by MODE B evidence re-discovery otherwise, (c) evaluates the
deterministic change rules, and (d) writes results. It should be worker-secret
gated (`verify_jwt = false` + header secret, constant-time compare) for the
Tier-2 sweep and additionally reachable as an authenticated user-scoped refresh
for Tier 1. It must be added to `config/edge-function-manifest.json`
`expectedFunctions` or the governed edge-inventory gate will fail.

A **second narrow backend change** is needed but is not a new function: expose
a governed, host-allowlisted "enrich this URL" request on the commerce
authority, because `selectEnrichmentCandidates` currently derives candidates
server-side from discovery only (§21).

**NEW SCHEDULER — YES, for Tier 2 only, and it is external.**
There is no in-repo scheduler and this audit does not recommend creating the
first one in-database. Mirror `process-account-deletions`: the function is in
source, the schedule is operator configuration. **Tier 1 (user-open refresh)
needs no scheduler at all and should ship first.**

---

## 24. MONITORING RECOMMENDATION (§68)

```
EXISTING SCHEDULER:            ABSENT (no pg_cron, no pg_net, no scheduled Edge
                               Function, no Render cron, no GH Actions cron)

EXISTING BACKGROUND AUTHORITY: EXTENDABLE — the worker-secret Edge Function
                               pattern is live and proven twice:
                                 process-account-deletions
                                   (x-deletion-worker-secret, constant-time
                                    compare, app_config kill switch + dry-run,
                                    claim_deletion_requests_for_purge)
                                 kplus-reconcile-revenuecat
                                   (x-kplus-reconcile-secret,
                                    list_kplus_pending_revenuecat_sync,
                                    limit clamped to [1, 200])

PRODUCT REFRESH METHOD:        1. URL enrichment where the host allows it —
                                  enrichFarfetchProductByUrl / enrichKicksCrewProductByUrl
                                  (1 upstream call, precise)
                               2. MODE B evidence re-discovery + normalized-URL
                                  re-match everywhere else
                                  (2–4 upstream calls, imprecise;
                                   absence ⇒ "no longer listed", NOT "out of stock")

EXPECTED PROVIDER CALL PATTERN:
                               Linear in active watches. No batching exists.
                               No cross-watch cache benefit (both caches are
                               per-isolate in-memory; the MODE B key is an
                               evidence fingerprint, not a URL).
                               20 watches ⇒ 20 refreshes ⇒ 20–80 upstream calls
                               depending on how many are URL-enrichable.

RECOMMENDED V1 REFRESH MODEL:  Tier 1 — user-open refresh, bounded and debounced.
                               Tier 2 — at most once daily, flag-gated,
                                        worker-secret sweep in small bounded batches.
                               No high-frequency polling. No per-watch schedules.
                               Any cadence faster than daily requires measured
                               provider quota data that does not exist yet.
```

No rate limits are invented. Serper ($0.30/1000, 2500 free queries) and the
RapidAPI real-time-product-search tiers are the only figures in the repo, and
they are vendor-advertised, not measured. Brave, Poshmark, Farfetch3 and
KicksCrew quotas are **UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED**.

---

## 25. NOTIFICATION MAP (§69)

```
CURRENT NOTIFICATION AUTHORITY: NONE
PUSH AVAILABLE:                 NO   (no expo-notifications, no plugin, no token table)
LOCAL AVAILABLE:                NO   (no expo-notifications)
PREFERENCES:                    NO   (usePermissionPreferences is a placeholder
                                      returning backend_not_connected; the
                                      Notifications onboarding card was removed
                                      in Build 33)
DEEPLINK:                       YES  (kscan:// + expo-router; applinks limited to
                                      /rooms; a /watchlist/[id] route resolves
                                      through the default handler with no
                                      +native-intent change)
GROUPED EVENT SUPPORT:          N/A  (nothing to group with — but the change
                                      engine should emit pre-collapsed events so
                                      grouping is not a later retrofit)
WATCHLIST EXTENSION NEEDED:     ENTIRE SUBSYSTEM:
                                  - expo-notifications dependency + app.json plugin
                                  - iOS/Android push credentials + EAS config
                                  - a push-token resource (user-scoped, RLS,
                                    deletion-registered, revocable per device —
                                    user_device_sessions is the nearest precedent)
                                  - a real notification-preferences store
                                    (extend privacy_settings; do NOT create a
                                    parallel preferences system)
                                  - permission request UX (re-introducing what
                                    Build 33 removed)
                                  - a delivery path from the refresh worker
```

**This is an ARCHITECTURAL DECISION (§78): general notification architecture.**
It is not Watchlist's to design unilaterally, because the first notification
system in the product sets the pattern for every feature after it. C0 does not
solve it.

---

## 26. CLOSET INTELLIGENCE RESULT (§70)

```
DUPLICATE RISK:          PARTIAL — safe as "you may already own something
                         similar", with the matched items shown.
                         Authority: services/free-tier/duplicateDetector.ts
                         (deterministic attribute scoring, category-gated) +
                         server-derived ownership provenance
                         (attachmentProvenance.ts: "saving does not prove
                         ownership. Never 'owned'").

COMPATIBILITY:           PARTIAL — qualitative only.
                         eliseCompatibilityScoring.ts is deterministic
                         ("Numeric scores are never taken from model output"),
                         but it scores a bounded shortlist
                         (40 → 24 → 10) that can be partial.

EXACT ITEM COUNT CLAIMS: UNSAFE — DO NOT MAKE.
                         Retrieval is capped and can report partialFailure;
                         the Closet is local-first with K+-gated cloud sync.
                         "Works with exactly 11 things you own" is fake precision.

WARDROBE GAPS:           WEAK — NOT SUFFICIENT for a Watchlist claim.
                         analyzeWardrobeGap computes role coverage over the
                         SHORTLIST, not the wardrobe, and flags partialInventory
                         when inventoryCount < 3.

SIGNATURE STYLE USEFUL?: MARGINAL for V1.
                         user_style_profiles / signature-style server authority
                         exists (Track B B4) and is deterministic and
                         server-derived — a legitimate future enrichment for
                         "does this fit how you dress", but it adds nothing to
                         the watch loop itself. Defer.

NEW CLOSET INFRA REQUIRED: NO
```

Closet stays strictly downstream: **Watch product → observation → optional
Closet annotation.** Closet must never participate in determining what is
watched.

---

## 27. REUSE MAP (§72)

**REUSE UNCHANGED**
- `shoppingProvider.normalizeUrl`, `isAggregatorDestination`, `selectRetailerDestination`
- `commerceDestination.isSafeCommerceUrl`, `selectCommerceDestination`
- `dressingRoomCommerce.normalizePersistedCommerceUrl`, `formatCommercePrice`, `cleanText`
- `canonicalCommerce.parseOfferPrice` (the price-parse authority)
- `commerceHydration.fetchDeferredCommerce` / `buildCommerceOnlyBody` (MODE B refresh)
- `enrichFarfetchProductByUrl`, `enrichKicksCrewProductByUrl`
- `kplus_has_active_entitlement`, `has_active_k_plus()`, `KPlusGate`, `useKPlusEntitlement`
- `user_closet_items` RLS + trigger + grant pattern (as a template)
- Deletion registry (both mirrors) + `deletionRegistryParity` test
- `process-account-deletions` worker shape (worker secret, constant-time compare, `app_config` kill switch, dry-run, bounded claim RPC)
- `ProductShelf` card + `canAddProductToDressingRoom` eligibility gate
- `kplusTelemetry` allowlisted-event sink pattern
- expo-router file-based routing + `kscan://` scheme
- v124 ranking, v125 query construction, retailer-neutrality invariants — **consume, never touch**

**EXTEND NARROWLY** (each is one small, reviewable change)
1. **Governed URL-enrichment request** on the commerce authority: allow a
   caller to request enrichment of a host-allowlisted product URL, instead of
   only server-derived `selectEnrichmentCandidates`.
2. **Carry `size` / `condition` / `retailer` / `providerProductId` through
   `normalizeToRecommendedProduct`** — the providers already parse them and the
   router drops them. This is additive, does not change ranking, and is the
   prerequisite for any future variant work. *(Optional for V1; required before
   Job C is ever reconsidered.)*
3. **Notification preferences** as fields on the existing privacy/preferences
   surface, not a new system.
4. **Deletion + privacy-export registries** — add the Watch resources.
5. **`config/edge-function-manifest.json`** — declare `watchlist-refresh`.

**BUILD NEW** (genuinely Watchlist-specific primitives only)
- Watch resource (user intent + latest observation inline)
- Watch observation resource (bounded, meaningful changes only)
- Deterministic meaningful-change engine (price delta, target-price crossing, listing-resolvability transition, per-cycle collapse)
- `watchlist-refresh` Edge Function (batch refresh + evaluate)
- Watchlist home + Watch detail routes and their client store
- Watch telemetry events (following the `kplusTelemetry` allowlist pattern)

**DO NOT BUILD**
- A second canonical product identity
- A second commerce provider client
- A second save/favourite system
- Watchlist-specific retailer ranking, preferred-vendor routing, or affiliate favouritism
- A second K+ entitlement gate
- A second preferences system
- A second scheduler (Tier 2 reuses the external worker pattern)
- New Closet similarity infrastructure
- A universal buy score or wardrobe value score
- Variant/size/color watch fields the pipeline cannot populate
- Unbounded observation history

---

## 28. COLLISION MAP (§73)

| Shared Surface | Current Authority | Watchlist Needs | Other Active Work Could Touch It? | Watchlist Action |
|---|---|---|---|---|
| **Commerce product identity** | `canonicalCommerce.ts`; de-facto the normalized URL | A durable per-offer reference | **No** — no active branch touches it | **CONSUME.** Adopt the URL contract; add no identity. |
| **Commerce normalization** | `shoppingProvider.RecommendedProduct` + `scanCommerceRouter.normalizeToRecommendedProduct` | Optionally, passthrough of already-parsed `size`/`retailer`/`providerProductId` | **No** | **EXTEND ADDITIVELY ONLY.** No field removed, no field reinterpreted, no ranking effect. |
| **Commerce ranking** | v124 identity ranking, `commerceRelevance*.ts` | Nothing | **No** | **DO NOT TOUCH.** Watchlist never re-ranks. |
| **Provider routing** | `scanCommerceRouter` fan-out + `commerceFunnelConfig` deadlines | A refresh entry point | **No** | **CONSUME.** Refresh reuses MODE B and the two URL adapters. No new provider, no new order. |
| **Closet** | `user_closet_items` + Elise ownership provenance + `duplicateDetector` | Read-only enrichment | Track B closet branches are merged into the authority; VTO/Packing do not alter closet authority | **CONSUME READ-ONLY.** No new closet infra. |
| **K+** | `user_entitlements` / `k_plus`, `kplus_has_active_entitlement`, `has_active_k_plus()`, `KPlusGate` | Tier gate on the Watch resource and the entry point | **Yes, mildly** — VTO ships its own `vtoEntitlement.ts`; Packing shares `KPlusGate` | **CONSUME.** Use the RLS wrapper + `KPlusGate`. Do **not** add a third gate implementation. |
| **Notifications** | **NONE** | The whole subsystem | No | **ARCHITECTURAL DECISION REQUIRED (§78).** Do not design unilaterally in C0. |
| **Navigation** | expo-router file routes; `HomeLuxuryTechV1` tiles; `library.tsx` two-section chrome | A home tile + two routes | **Yes** — Packing also edits `HomeLuxuryTechV1.tsx` and `constants/featureFlags.ts` | **ADD, DON'T RESTRUCTURE.** New route files + one tile. No new tab, no third library section. Expect trivial text conflicts with Packing. |
| **Telemetry** | `scan_commerce_events` (anonymous, service_role); client allowlist sinks | Watch funnel + refresh outcome events | No | **MIRROR THE PATTERN.** New allowlisted events; never widen `scan_commerce_events` (adding a user id or a price to it would change its privacy class). |
| **Edge function manifest / CI gate** | `config/edge-function-manifest.json` + governed inventory gate | Declare one new function | **Yes** — `fix/phase2b4-governed-edge-inventory-v1` repairs this gate | **MERGE THE FIX FIRST**, then declare. |
| **Deletion registry** | dual mirror + parity test | Register 2 resources | No | **EXTEND BOTH MIRRORS TOGETHER** or CI fails. |

---

## 29. SECURITY GAP MAP (§74)

| Risk | Classification | Basis |
|---|---|---|
| **Cross-account watches** | **ALREADY PROTECTED** (pattern exists; must be applied) | `user_closet_items` RLS + identity-stamping triggers + revoke/grant discipline; K+ ledger records live staging proof that cross-account read returns empty and direct mutation returns `42501`. |
| **Product identity spoofing** | **EXTENSION NEEDED** | No existing rule says "a Watch may only be created from a governed commerce result". A client could otherwise POST an arbitrary URL and make the refresh worker fetch it. Required: origin the Watch from a real commerce response and re-validate through `normalizePersistedCommerceUrl` at write time. |
| **Variant collision** | **BLOCKING for variant claims; ACCEPTED for listing claims** | §13. There is no authority to fix it with, so V1 must not make variant claims. Explicitly a product-copy constraint, not a code fix. |
| **Malicious metadata** | **ALREADY PROTECTED** | Length clamps + `str()` server-side; `cleanText()` control-char stripping client-side; `escapePromptData()` on any prompt path. |
| **Unsafe URLs** | **ALREADY PROTECTED** | Three independent HTTPS-only validators rejecting non-HTTPS, credentials, loopback/RFC1918/link-local; the persist-time one also rejects signed storage paths, `x-amz-*`/`x-goog-*` and JWT-shaped values. |
| **Stale products** | **EXTENSION NEEDED** | Nothing today models "this offer stopped resolving". Required: `last_observed_at` surfaced in the UI, plus an N-consecutive-failure degradation to "no longer listed" instead of continuing to show a stale price. |
| **Notification spoofing** | **EXTENSION NEEDED** (whole channel is new) | Deep links must carry only the watch id; the detail screen loads from the RLS-scoped row. No price, URL or retailer in a link parameter. |
| **Unbounded history** | **EXTENSION NEEDED** | No existing per-user append-only store to inherit bounds from. Required: meaningful-changes-only + daily coalescing + fixed per-watch cap (§34). |
| **Unmetered commerce refresh** | **EXTENSION NEEDED** *(additional finding)* | MODE B is `verify_jwt=false`, returns before the per-user quota check, and is bounded only by an **in-memory per-isolate** IP+UA window of 40/10min. A refresh path built on it inherits that weakness and multiplies it by watch count. Watchlist refresh must be authenticated, K+ gated, and metered per user. |

---

## 30. PERFORMANCE / COST MAP (§75)

```
CURRENT COMMERCE LOOKUP COST:
  MODE A/B fast path — bounded at FAST_COMMERCE_DEADLINE_MS = 1,900 ms,
    early exit at FAST_COMMERCE_SUFFICIENT_RESULTS = 3.
  Deferred enrichment — ENRICHMENT_DEADLINE_MS = 6,000 ms,
    MAX_ENRICHMENT_CANDIDATES = 2.
  Measured provider latencies recorded in source:
    Poshmark ~13.9 s (Phase 3 probe), Farfetch3 ~3.0 s, KicksCrew ~2.6 s,
    per-provider timeout ceiling 4,500 ms (Serper/Brave) / 4,000 ms (enrichment).
  No monetary cost is measured anywhere in the codebase.

KNOWN PROVIDER LIMITS:
  Serper                  — "2,500 free queries"; "~$0.30 per 1000 queries"
                            (repo doc, vendor-advertised, not measured)
  RapidAPI real-time-
    product-search        — Basic "100 requests / month" hard limit;
                            free plan "1000 requests per hour";
                            Pro ~$2.50/1000; PAYG ~$5.00/1000 (repo doc)
  Brave                   — UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED
  Poshmark (RapidAPI)     — UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED
  Farfetch3 (RapidAPI)    — UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED
  KicksCrew (RapidAPI)    — UNKNOWN — MEASUREMENT / PROVIDER DOCUMENTATION REQUIRED

CAN REFRESH BY ID:
  NO by product id / SKU for every provider.
  YES by URL for Farfetch3 and KicksCrew only (both default OFF).
  Everything else must re-run evidence discovery.

BATCHING:
  NONE. Every adapter is single-subject. No batch endpoint exists on any provider in use.

CACHE:
  Two, both per-isolate in-memory Maps, neither shared and neither durable:
    shoppingProvider CACHE — key = lowercased query, TTL 1 h
    commerceResultCache    — key = structured-evidence fingerprint,
                             TTL 10 min, max 200 entries, oldest-first eviction
  Neither can deduplicate two users watching the same listing, because neither
  is keyed by URL.

MODEL CALLS REQUIRED FOR MONITORING:        0
MODEL CALLS REQUIRED FOR CLOSET ENRICHMENT: 0 (duplicate hints are deterministic);
                                            1 optional stylechat-generate call
                                            only for narrative advice, never in
                                            the poll loop

INSTRUMENTATION GAPS (all must be closed before any cadence is chosen):
  - No price is ever recorded anywhere → the price-change rate is unmeasured,
    so no meaningful-change threshold can be justified.
  - scan_commerce_events is anonymous and carries no price, URL or product id.
  - No per-provider cost or quota counter exists in source.
  - No measurement of how often a given listing URL survives a repeat query
    (the "falls out of the top 8" risk in §11 is unquantified).
  - Both caches are unobservable across isolates — hit rate at fleet level is unknown.
```

No dollar values are invented. Every figure above is either a source constant
or an explicitly-attributed repo document.

---

## 31. BUILD BRANCH RECOMMENDATION (§76)

```
RECOMMENDED IMPLEMENTATION ROOT:
  feature/build34-kplus-smart-watchlist-v1

BRANCHED FROM:
  origin/integration/backend-kplus-complimentary-staging-v1 @ 157606c9

CONVENTION BASIS:
  The direct sibling precedent — feature/build34-kplus-packing-intelligence-v1
  — uses exactly this naming shape and exactly this base.
```

Watchlist is a **sibling**, not a descendant. Do **not** branch from
Wardrobe Concierge, Packing Intelligence, or any VTO branch. If Packing or VTO
merge into the shared authority before Watchlist starts, re-cut from the updated
authority; do not merge a sibling feature branch into Watchlist.

**One sequencing note:** merge `fix/phase2b4-governed-edge-inventory-v1`
(`a9bc3c3c`) into the authority before Watchlist declares its Edge Function, or
the governed edge-inventory CI gate will fail on the new function.

---

## 32. RECOMMENDED BUILD TRAIN (§77)

The initial hypothesis is close, but the live architecture argues for **two
changes**: identity is not a build step (it is a *constraint* discovered here,
and the narrow contract extension belongs with the refresh work), and
**notifications must move earlier** because they are the largest unknown and
they gate whether the feature is a watchlist at all.

```
K5-C1  Watch contract + commerce reference binding
       Define the Watch as an OFFER identified by a governed normalized URL.
       Reuse normalizePersistedCommerceUrl / selectCommerceDestination.
       Write down the claim boundary: listing-level only, no variant, no stock.
       No persistence yet.

K5-C2  Persistent Watch state + user intent  (K+ gated)
       One Watch resource, user_closet_items pattern verbatim.
       Intents: JUST WATCHING and BUY UNDER $___ only.
       Pause (status) + delete (soft) land here — Jobs I and J are free.
       Register in BOTH deletion registry mirrors + privacy export.

K5-C3  Observation / price / availability refresh
       Governed host-allowlisted URL-enrichment request (the one narrow
       commerce extension). MODE B evidence re-discovery + URL re-match fallback.
       watchlist-refresh Edge Function, Tier 1 (authenticated, user-open,
       metered) only. Bounded observation resource.
       Declare the function in config/edge-function-manifest.json.

K5-C4  Meaningful-change engine
       Deterministic, no LLM. Price delta (same-currency guard), target-price
       crossing, listing-resolvability transition with N-failure degradation.
       Per-cycle collapse to ONE event per watch, so grouping is never a retrofit.

K5-C5  Notifications + user controls          ← MOVED EARLIER (was C6)
       The largest unknown in the whole plan and the thing that decides whether
       this is a watchlist or a bookmark list. Running it before enrichment
       means the feature is either real or honestly descoped before more is
       built on top. Depends on the §78 architectural decision being taken.
       Push dependency + plugin, token resource, preferences on the existing
       privacy surface, permission UX, watch-id-only deep links.

K5-C6  Closet intelligence enrichment          ← MOVED LATER (was C5)
       Read-only, qualitative, deterministic. Duplicate hints + ownership
       provenance. No counts, no gaps, no score. Cleanly droppable if C5 or C7
       runs long — which is exactly why it should not precede them.

K5-C7  Tier 2 background sweep + security + cost + staging
       Worker-secret sweep on the process-account-deletions shape, flag-gated,
       daily at most, bounded batches, app_config kill switch, dry-run.
       Close the instrumentation gaps from §75 and only then choose a cadence
       and any passive threshold.

K5-C8  Independent hostile audit
       Cross-account, forged/unsafe URL, SSRF via refresh, variant-collision
       copy review, stale-price presentation, unbounded growth, notification
       deep-link spoofing, retailer-neutrality regression.
```

**Do not implement any of this.** C0 is complete at this document.

---

## 33. ARCHITECTURAL STOP CONDITIONS (§78)

```
ARCHITECTURAL DECISION REQUIRED
```

One decision genuinely blocks a trustworthy Watchlist, and it is **not** a
commerce decision:

**1. GENERAL NOTIFICATION ARCHITECTURE — BLOCKING.**
K Scan has no push, no local notifications, no token storage, no notification
preferences, and Build 33 deliberately removed the Notifications onboarding
card. Watchlist would be the first feature to introduce all of it, and whatever
it introduces becomes the pattern for every later feature. That is an
owner/architecture decision about the product's outbound-messaging posture,
its permission UX, and its push vendor — not a decision a feature build should
make unilaterally. **C0 does not solve it.**

Two further items are **decisions to record, not blockers**, because a narrow
V1 can proceed without changing either authority:

**2. Commerce contract passthrough (NON-BLOCKING, additive).**
Carrying `size` / `condition` / `retailer` / `providerProductId` through
`normalizeToRecommendedProduct` is purely additive and touches no ranking. It is
optional for V1 and mandatory before Job C is ever reconsidered. It should be
proposed to the commerce authority owner rather than taken by Watchlist.

**3. Metered, authenticated commerce refresh (NON-BLOCKING, recommended).**
MODE B is currently unauthenticated, pre-quota, and bounded only by an
in-memory per-isolate IP+UA window. Watchlist should **not** inherit that
posture for a recurring refresh; it should route refresh through an
authenticated, K+-gated, per-user-metered path. This is Watchlist's own
function to build, so it is not a change to the commerce authority — but the
owner should know the underlying path's posture.

**Not required to change:** canonical Commerce authority, retailer-neutral
ranking, provider routing, K+ authority, Closet authority, Scanner contracts.
Watchlist consumes all six unchanged.

---

## 34. SPECIAL IDENTITY VERDICT (§79)

```
SMART WATCHLIST PRODUCT IDENTITY
— PARTIAL
— V1 MUST BE NARROWED TO TRUSTED PROVIDERS / CLAIMS
```

Listing identity (normalized product URL) is strong enough to watch a specific
offer at a specific retailer and to detect a price change on it. Product-family
identity is a title-token hash and is not strong enough for cross-retailer
claims. Variant identity does not exist at all. V1 must therefore watch
**offers**, speak only about **listings and prices**, and make no statement
about size, color, stock, or "the same product elsewhere".

---

## 35. FINAL C0 VERDICT (§80)

```
K+ SMART WATCHLIST K5-C0 READ-ONLY AUDIT COMPLETE
— CONDITIONAL BUILD
— PRODUCT / VARIANT IDENTITY LIMITS REQUIRE NARROW V1
```

The identity limits are navigable by narrowing the claim, so this is not
BLOCKED on identity. It is **CONDITIONAL** on two things being accepted before
K5-C1 opens:

1. **V1 watches offers, not products, and not variants.** No size, color, stock
   or same-product-elsewhere claim ships.
2. **The general notification architecture decision (§78) is taken by the
   owner.** Without it, K5-C1 through C4 still produce real value — a K+
   watch list with refreshed prices and an honest "last checked" — but the
   product promise *"K Scan keeps watching the decision for you"* is not met
   until something can reach the user.

STOP. No code written. No migration created. No table created. No Edge Function
deployed. No staging or production data written. No notification job created.
No EAS run. No Watchlist implementation begun.
