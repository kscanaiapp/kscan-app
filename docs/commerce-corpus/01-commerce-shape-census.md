# Commerce Shape Census

Build 35 — Commerce Evaluation Corpus V1. This document is the required
Section 12 deliverable: an inventory of the Commerce-domain data shapes that
actually exist in source today, as of the corpus's base commit (see
`README.md` "Source Authority"). It exists so the corpus's fixtures can be
labeled `SOURCE-SHAPE` honestly instead of guessed.

`STAGING_OBSERVED_SHAPE: UNAVAILABLE` — no Staging credentials or read path
were available in this lane's environment (Section 13). Nothing below is
`OBSERVED-SHAPE`. Every finding is either `SOURCE-SHAPE` (derived from a real
type/adapter/contract/test) or explicitly marked as absent/unverified.

Method: direct inspection of the repository at the corpus's base commit —
no runtime execution, no Staging calls, no mutation.

---

## 0. There is no single canonical Product/Offer type

The codebase has **at least six** independent, partially-overlapping shapes
for "a commerce listing," each with its own field-alias fallback chain. This
is itself a census finding (Finding F1 in the ledger): the same underlying
fact ("what retailer sold this") is represented and resolved differently
depending on which shape a given screen or persistence path uses.

| Shape | File:line | Layer |
|---|---|---|
| `RecommendedProduct` | `supabase/functions/scan-identify/shoppingProvider.ts:15-45` | backend wire |
| `CanonicalOffer` / `CanonicalProduct` / `CanonicalCommerce` (v127) | `supabase/functions/scan-identify/canonicalCommerce.ts:18-51` | backend, dormant (see §6) |
| `RankedScanProduct` | `types/scanIdentification.ts:175-184` | client wire (loose bag) |
| `CanonicalPurchaseOption` / `CanonicalDressingRoomItem` | `types/canonicalDressingRoomItem.ts:26-96` | client, persisted |
| `Product` (render) | `components/ProductShelf.tsx:47+` | client, UI |
| `ProductMatch` / `PurchaseOption` / `WatchCandidate` / `ScanResultV2` | `components/scan-results/types.ts:8-108` | client, UI |
| `ProductMatchSnapshotSource` | `types/styleObjects.ts:108-141` | client, snapshot |

---

## 1. Field-by-field census

Legend for prevalence: since no `OBSERVED-SHAPE` runtime sample exists, prevalence is reported as **STRUCTURAL** (the field's optionality as declared in its type) rather than a claim about how often real traffic populates it. Do not read STRUCTURAL as a runtime frequency claim.

| Field | Semantic meaning | Source authority | Evidence class | Structural prevalence |
|---|---|---|---|---|
| `id` / `offerId` | Per-listing identifier, provider- or request-scoped | `shoppingProvider.ts:15`, `canonicalCommerce.ts:19` | SOURCE-SHAPE | COMMON (required in most shapes) |
| `title` | Listing display title | all shapes | SOURCE-SHAPE | COMMON |
| `displayName` | Alternate title alias | `types/scanIdentification.ts:179`, `titleOf()` fallback chain, `components/scan-results/types.ts:239-243` | SOURCE-SHAPE | OPTIONAL (alias, not primary) |
| `brand` | Manufacturer/label of the garment | `RecommendedProduct.brand?`, `CanonicalProduct.brand` | SOURCE-SHAPE | OPTIONAL |
| `retailer` | Seller of record for this specific offer | no dedicated type; a bare `string` field resolved via **three different, inconsistent fallback chains** — see Finding F1 below | SOURCE-SHAPE | OPTIONAL, AMBIGUOUS |
| `merchant` / `store` | Alternate retailer-field aliases, read only by the `ProductShelf`/persisted-normalizer fallback chains | `components/ProductShelf.tsx:167`, `services/dressingRoomCommerce.ts` retailer resolution | SOURCE-SHAPE | RARE |
| `source` / `provider` | Which commerce API/provider answered (`serper`, `brave`, `poshmark`, …) | `ShoppingResult.provider` (`shoppingProvider.ts:49`), `CanonicalOffer.source` | SOURCE-SHAPE | COMMON. **Never a ranking input** (`canonicalCommerce.ts:20` comment) |
| `price` | Offer price, `string \| number \| null` | canonical formatter: `formatCommercePrice`, `services/dressingRoomCommerce.ts:120-151` | SOURCE-SHAPE | COMMON, but no dedicated `Price` type exists |
| `currency` | ISO-4217-shaped 3-letter code, or absent | `normalizeCommerceCurrency`, `services/dressingRoomCommerce.ts:99-104` | SOURCE-SHAPE | OPTIONAL. Validated as "3 letters", **not** checked against the real ISO-4217 list (a fake code like `XYZ` normalizes successfully) — Finding F5 |
| `imageUrl` (+ `image_url`/`thumbnail`/`thumbnailUrl`) | Listing image | `services/dressingRoomCommerce.ts` alias chain | SOURCE-SHAPE | OPTIONAL, multiple aliases with defined precedence |
| `productUrl` (+ `product_url`/`purchaseUrl`/`url`/`link`) | The offer's own destination URL | `productUrlOf()` (`components/scan-results/types.ts:223-229`), `normalizePersistedCommerceUrl` chain | SOURCE-SHAPE | COMMON, alias precedence explicit |
| `affiliateUrl` (+ `affiliate_url`) | A URL slot fed straight through as another destination candidate | present on nearly every shape; **every entry in `data/catalog.json` has it `null`** | SOURCE-SHAPE | RARE/ABSENT at the mechanism level — see §5 |
| `commerceType` | `'retail' \| 'resale'` | `RecommendedProduct.commerceType?` (`shoppingProvider.ts:32-37`) | SOURCE-SHAPE | OPTIONAL. Only the Poshmark provider ever sets `'resale'` (`poshmarkProvider.ts:213,219`) |
| `type` | `'retail' \| 'similar'` — is this a real offer or a similar-style web link | `WatchableListing.type?` | SOURCE-SHAPE | COMMON on backend shapes; gates Watch eligibility (must be `'retail'`) |
| `watchCapability` | `'refreshable_listing' \| 'unsupported'`, server-authored | `types/watchlist.ts:57`, derived by `deriveWatchCapability` (`watchlistCapability.ts:77-86`) | SOURCE-SHAPE | OPTIONAL, additive-only field |
| `availability` | Free-text-ish availability signal | `WatchableListing.price?`, `availabilityLabel()` (`components/scan-results/types.ts:213-221`) normalizes only `in_stock`/`out_of_stock` variants | SOURCE-SHAPE | RARE, AMBIGUOUS (free text, only two normalized outcomes) |
| `providerProductId` / `productId` / `external_product_id` | Provider-issued identifier for the listing | `CanonicalOffer.providerProductId` (`canonicalCommerce.ts:23`), `CanonicalPurchaseOption.productId` alias chain (`dressingRoomCommerce.ts` ~line 250) | SOURCE-SHAPE | OPTIONAL. Provider-scoped, **not** a cross-retailer key (see Finding F2) |
| `SKU` / `GTIN` / `UPC` / `EAN` | Universal product identity codes | **not present in any real production type** — only in the research lab `tools/canonical-product-identity/lib/offerFactory.js:16-46`'s invented `RetailOffer` | N/A in production; SYNTHETIC if used | ABSENT from production schema |
| `observedAt` | When this price/listing fact was captured | `CanonicalOffer.observedAt` (`canonicalCommerce.ts:32`, backend v127, dormant); `CommerceWatchEvent.observedAt` (`types/watchlist.ts:44`); `user_commerce_watches.last_checked_at` | SOURCE-SHAPE | PARTIAL overall — see §7. **ABSENT** on `CanonicalPurchaseOption`, `PurchaseOption`, `WatchCandidate`, `RankedScanProduct` |
| `canonicalUrl` | The Watch's identity key | `CommerceWatch.canonicalUrl` (`types/watchlist.ts:23`); DB unique index on `(user_id, canonical_url)` | SOURCE-SHAPE | COMMON within the Watchlist subsystem only |

---

## 2. Finding F1 — retailer resolution is not consistent (three divergent fallback chains)

This directly answers the Section 9 diagnostic question *"Does the same retailer resolve consistently?"* — **No.** Three call sites resolve "who is the retailer" from a raw record, each with a different fallback order:

1. `getRetailer()`, `components/ProductShelf.tsx:165-172`
   `[retailer, brand, source, merchant, store]` — first non-empty string wins.
   **Falls back to brand as retailer.**

2. `normalizePurchaseOptions()` (persisted normalizer), `services/dressingRoomCommerce.ts` (~line 221-226)
   `[retailer, brand, merchant, store, source]` — first non-empty string wins.
   **Falls back to brand as retailer**, and does so *before* falling back to
   `source` (the actual provider identity), so a record with brand but no
   retailer is persisted with the brand printed into the retailer field.

3. `mapRawProductToPurchaseOption()`, `components/scan-results/types.ts:288-294`
   `[retailer, source, literal 'Retailer']` — **does not** fall back to
   brand; falls back to the provider `source`, then to the placeholder
   string `'Retailer'`.

4. `mapLegacyToV2()`'s `similarFinds` mapping, `components/scan-results/types.ts:364-368`
   `[retailer, source, undefined]` — leaves retailer genuinely `undefined`
   when absent. This is the one path that matches the corpus's retailer-truth
   doctrine (Section 14: "Never make brand fallback the expected behavior").

**Product implication**: two of four real call sites will silently print a
brand name into a retailer slot when the provider never named a retailer.
This is a real defect relative to the doctrine this corpus encodes. Per the
Diff Fence (Section 52), **this finding is recorded, not fixed, in this
lane** — see `docs/commerce-corpus/02-final-report.md` §N (Findings Ledger).
The corpus's `retailer-identity` fixtures encode the *correct* doctrine
(brand ≠ retailer; unknown stays unknown) as the expected outcome, and
separately include a fixture pair that reproduces this exact divergence so a
future PR A change can be regression-tested against it.

## 3. Finding F2 — the only cross-retailer grouping mechanism is fuzzy, dormant, and self-flagged as unsafe

`canonicalProductKey()` (`supabase/functions/scan-identify/canonicalCommerce.ts:133-141`)
groups listings by `brand + up-to-8 normalized title tokens` — explicitly
*not* by any exact identifier, and explicitly *excluding* retailer/provider
from the key ("including either would make the same product from two
retailers group apart, which is the exact behavior this model exists to
fix" — comment at lines 126-132).

This is wired into `buildCanonicalCommerce()`, called in production at
`supabase/functions/scan-identify/index.ts:2161` and exposed on the response
as `canonicalProducts` (line 2244) — **but no client code reads
`canonicalProducts`** (confirmed absent from `commerceHydration.ts` and every
other normalizer). It is shipped but dormant.

The codebase's own Watchlist code explicitly declines to reuse it, for
exactly the reason this corpus's must-not-group doctrine (Section 28) would
predict:

> "`canonicalProductKey` (a brand+title-token hash) is explicitly NOT used
> here — it groups colorways together and is unstable under a retailer
> re-title." — `supabase/functions/scan-identify/watchlistCapability.ts:9-11`

**Product implication**: there is no exact, trusted, cross-retailer product
identity in production source today. The one mechanism that attempts
cross-retailer grouping is a heuristic that the team's own comments already
flag as capable of merging distinct colorways/variants — precisely the
must-not-group failure mode this corpus tests for (Section 28: "same brand +
similar title", "same product family but different model"). This is the
central input to the Grouping Readiness verdict (`02-final-report.md` §G).

## 4. Retail vs Resale

`commerceType?: 'retail' | 'resale'` exists on `RecommendedProduct`
(`shoppingProvider.ts:32-37`, comment: "must never carry a ranking bonus or
penalty (retailer-neutrality is a hard rule)"), propagated onto
`WatchableListing`/`WatchCandidate`. Only the Poshmark provider sets it to
`'resale'` (`poshmarkProvider.ts:213,219`); every other provider leaves it
unset (not `'retail'` by default — genuinely absent). A separate, older
"secondhand" search path (`services/secondhand.js`,
`components/SecondhandShelf.tsx`) exists in parallel and does not use
`commerceType` at all. No dedicated `Retail`/`Resale` type alias exists
anywhere; it is a repeated two-value string literal union.

## 5. Affiliate/attribution — mechanism ABSENT

`affiliateUrl`/`affiliate_url` is a field **slot** present on nearly every
shape and read as a fallback destination candidate
(`services/library.js:417`, `services/api.js:111`,
`services/dressingRoomCommerce.ts`, `services/vto/vtoCommerceGarment.ts:68`),
but:

- Every real fixture in `data/catalog.json` (~60 entries) has it `null`.
- No affiliate ID, click ID, tracking parameter, or network/partner ID is
  ever minted anywhere. Grep for
  `affiliateId|clickId|trackingId|networkId|utm_|partnerId` across the whole
  repository returns zero hits.
- `services/commerceDestination.ts` treats `affiliateUrl` as just another
  untrusted candidate URL to safety-check (HTTPS-only, no embedded
  credentials, no private host) before opening — it never appends or strips
  tracking parameters, because there is no revenue-attribution system to
  operate on.

`AFFILIATE_AUTHORITY: ABSENT`. The corpus's `attribution` fixtures therefore
contain only truthful no-attribution and URL-safety cases (Section 25); no
affiliate ID/network ID is fabricated anywhere in this corpus.

## 6. Price/currency formatting — one canonical rule, deliberately triplicated

Canonical statement: `formatCommercePrice(price, currency)`,
`services/dressingRoomCommerce.ts:120-151` ("RP-110"). Behavior:

- `price` is `null`/`undefined` → `null`.
- A finite positive numeric price with a valid 3-letter currency code →
  `Intl.NumberFormat` currency string (e.g. `$29.99`).
- A finite positive numeric price with **no** valid currency → the bare
  number, `numeric.toFixed(2)` — **never** a `$` sign, **never** a USD
  guess, **never** a locale-based guess.
- A non-positive, zero, or zero-like string price (`'0'`, `'0.00'`,
  `'$0.00'`) → `null`.
- A pre-formatted provider string passes through untouched.

This exact rule is restated (not imported) in two more places, by design:
`formatPriceLabel` (`components/scan-results/types.ts:153-182` — comment
explains the restatement is required by a VTO module-boundary CI check, not
accidental drift) and `formatOfferPrice`/`normalizeCurrencyCode`
(`supabase/functions/scan-identify/offerCurrency.ts:29-64`, backend). All
three are kept honest by a shared cross-check test,
`__tests__/commerceCurrencyTruth.test.js`, which runs the client formatters
over one input table and fails the moment they disagree.

**Finding F5**: currency validity is checked only as "exactly 3 letters",
never against the real ISO-4217 code list — a well-formed-but-fake code
(e.g. `XYZ`) normalizes successfully and would render via
`Intl.NumberFormat`'s fallback behavior. Recorded, not fixed, in this lane.

## 7. Price freshness authority — PARTIAL

- **PRESENT** at the Watchlist layer: `user_commerce_watches.last_checked_at`,
  `CommerceWatchEvent.observedAt` (DB column `observed_at`).
- **PRESENT** at the backend v127 canonical-grouping layer:
  `CanonicalOffer.observedAt`, stamped once per request
  (`canonicalCommerce.ts:177`) — a request-time stamp, not a genuine
  per-provider capture time, and (per Finding F2) not consumed by any
  client today.
- **ABSENT** at the layer that actually renders/persists most shelves:
  `CanonicalPurchaseOption`, `PurchaseOption`, `WatchCandidate`,
  `RankedScanProduct`/`RecommendedProduct` carry no freshness timestamp at
  all.

`PRICE_FRESHNESS_AUTHORITY: PARTIAL`. See `02-final-report.md` §H for the
product implication.

## 8. Multi-item / per-garment commerce — PRESENT

`services/multiItemCommerce.ts` (`fetchMultiItemCommerce`, whole file) fans
out one commerce request per detected garment candidate (up to 5,
`Promise.allSettled`-isolated so one item's failure never affects another's
card), producing a `Map<candidateId, ItemCommerceCard>` — genuinely
independent `{ status, bestMatch, alternatives, retryable }` per garment, not
a merged result. 11 dedicated test files exist
(`__tests__/multiItemCommerce*.test.js`). `PER_GARMENT_COMMERCE: PRESENT`.

## 9. Watch and Shop offer identity — both are URL-keyed, by design

- **Watch**: `CommerceWatch.canonicalUrl` is the identity
  (`types/watchlist.ts:20-36`); DB enforces uniqueness on
  `(user_id, canonical_url)`
  (`supabase/migrations/20260830150000_user_commerce_watches.sql`).
  `WatchCandidate` is derived at render time "from the SAME canonical record
  this row is rendered from" (`components/scan-results/types.ts:19-33`,
  `303-309`) specifically to prevent one row's Watch action from acquiring
  another row's identity (named as bug class `DEF-WL-07` in source
  comments). Eligibility (`watchCapability`) is server-authored only,
  limited to two registered providers with a real re-observation path
  (`farfetch`, `kickscrew` — `watchlistCapability.ts:54-61`); Serper, Brave
  and Poshmark listings are always `'unsupported'`.
- **Shop**: `selectCommerceDestination()`
  (`services/commerceDestination.ts:77-85`) picks the first HTTPS,
  credential-free, non-private-host URL from a record's own candidate list,
  preferring a non-aggregator destination when one is safe and available.
  There is no cross-offer URL substitution anywhere in this path — an unsafe
  or malformed candidate is skipped individually rather than causing
  fallback to a *different offer's* URL.

## 10. Existing fixtures/tests

No `__tests__/fixtures/*commerce*` convention existed before this corpus.
~30 commerce/watchlist test files already exist at `__tests__/*.test.js`
(see agent research notes; not reproduced here to avoid duplication) plus
backend edge-function tests colocated under
`supabase/functions/scan-identify/*.test.ts`. None of them constitute a
manifest-driven evaluation corpus; they are unit tests of individual
functions.

## 11. Reused infrastructure pattern — `tools/fashion-match-quality/` and `tools/canonical-product-identity/`

Both labs are "research/engineering lab, not a production feature" (their
own README language) and share one privacy guard
(`tools/fashion-match-quality/schema/privacyGuard.js`, imported directly by
`tools/canonical-product-identity/schema/identitySchema.js:15`). This corpus
follows the same precedent:

- **Reused directly (implementation)**: the privacy guard's key-deny-list +
  value-shape-regex approach (JWT-shaped strings, credential-shaped URLs,
  tokens, emails) is generic enough, and the repo already treats
  cross-lab-import of this specific file as acceptable practice.
- **Reused as pattern only, not implementation**: manifest/report
  structure, evidence-class-validated fixtures, content-hashed baseline
  immutability, and an independent validator that re-derives checks rather
  than trusting a "PASS" claim. The *implementation* is new
  (`tools/commerce-corpus/`) because Commerce Corpus scenarios have a
  different schema (`scenarioId`/`category`/`tags`/`evidenceClass` vs. match
  quality's `fixtureId`/`corpusTier`/`captureProfile`/`groundTruth`) and a
  different domain (retailer/price/offer truth vs. scan match-quality
  scoring) — see Section 7's "REUSE PATTERN NOT IMPLEMENTATION" instruction.
  `tools/canonical-product-identity/`'s invented `RetailOffer` shape
  (`gtin`/`mpn`/`sellerType`/…) is a **research proposal**, not production
  schema, and is not treated as source authority for this census (Section 0
  table marks GTIN/SKU/UPC/EAN as ABSENT from production).

---

## 12. Summary table for Section 55 report reuse

| Question | Answer |
|---|---|
| Brand vs retailer known? | Doctrine exists; **2 of 4** real call sites violate it (Finding F1) |
| Same retailer resolves consistently? | **No** — three divergent fallback chains |
| Unknown retailer stays unknown? | Only in `mapLegacyToV2`'s `similarFinds` path |
| Retail/Resale represented truthfully? | Yes, but only Poshmark ever sets Resale |
| Watch attached to exact listing? | Yes — `canonicalUrl`-keyed, DB-unique, render-time-derived from the same record |
| Shop opens exact offer? | Yes — per-offer URL selection, no cross-offer fallback |
| Currency truthful? | Yes, by rule (RP-110); currency-code validity itself is shallow (Finding F5) |
| Price freshness authority? | PARTIAL |
| Affiliate parameters ever fabricated? | No mechanism exists to fabricate them from (ABSENT) |
| Exact cross-retailer identity? | None in production; only mechanism is fuzzy + dormant (Finding F2) |
| Per-garment commerce exists? | PRESENT |
