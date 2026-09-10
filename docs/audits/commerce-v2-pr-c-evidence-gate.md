# Commerce V2 — PR C Evidence Gate

Build 35 §49-50, §57-61, §76. Measured against real production commerce
types and code paths (not synthetic data) before deciding PR C's scope.

---

## 1. Trusted identity coverage (§49)

Measured directly against the live offer shapes (not the fixture corpus,
which is illustrative, not measured production traffic):

- **`RecommendedProduct`** (`supabase/functions/scan-identify/shoppingProvider.ts`,
  the production offer shape scan-identify returns): no `sku`, `gtin`,
  `upc`, `ean`, or retailer-catalog-id field exists on the type at all. Its
  `id` is synthetic for most providers — Poshmark's real `listingId` when
  present, otherwise a positional hash; Farfetch's real
  `internalProductId` when present, otherwise a hash of the URL; Serper and
  Brave (generic web-search results) carry no retailer product id at all.
- **`CanonicalPurchaseOption`** (`types/canonicalDressingRoomItem.ts`, the
  Dressing Room persistence shape) does carry a `productId` field, but it
  is populated from that same provider-dependent id, and is **explicitly
  excluded** from the system's own persistence-diffing logic
  (`services/library.js` `purchaseOptionsFingerprint`) as "provider
  bookkeeping" that "churns between otherwise identical responses" — i.e.
  the codebase's own dedup logic already does not trust this id as stable.
- **`PurchaseOption`** (`components/scan-results/types.ts`, what the
  shipped ScanResultV2 surface actually renders) has no product-identity
  field at all.
- A real GTIN/SKU/MPN/retailer-SKU schema **does** exist —
  `tools/canonical-product-identity/schema/identitySchema.js` — but it is a
  standalone research lab (`tools/canonical-product-identity/`, its own
  generator/resolver/corpus, entirely synthetic fixtures) with **zero
  imports from any production path** (`supabase/functions/scan-identify/`,
  `services/`). It is prior-art / a design reference only, and per §51 is
  explicitly excluded from being reused for grouping (this is very likely
  "the PR #318 experimental resolver" §51 names).

**Verdict: NUMBER OF REAL CROSS-RETAILER GROUPS = 0 measurable.** No
production offer carries a governed stable identity (GTIN/UPC/EAN, or a
retailer SKU trusted enough to key a cross-retailer match) that this lane
is permitted to use. The one opportunistic id that exists is provider-
dependent, absent for two of five live providers, and is already treated
as untrustworthy by the codebase's own persistence layer.

**RETAIL / RESALE MIX** of what the two multi-offer-capable providers
return: Farfetch and Nordstrom-style Serper results are retail; Poshmark
and Vinted are resale — both classifications are already carried
truthfully per-offer via `commerceType` (unaffected by this gate).

---

## 2. PR C coverage gate verdict (§50)

**GROUPED PURCHASE OPTIONS: DEFERRED — IDENTITY COVERAGE.**

Zero production offers carry a trusted, governed stable identity. Building
a grouped "4 purchase options, 2 retail and 2 resale" cross-retailer
experience today would require either (a) inventing a match — forbidden,
§51 lists title/brand+title/image-similarity/embeddings/LLM/fuzzy matching
all as explicitly disallowed grouping signals — or (b) reusing the
`tools/canonical-product-identity` resolver, which §51 also forbids by
name. Neither is available, so PR C ships only the truthful features that
do not depend on grouping (§50), listed below.

---

## 3. Full Look gate (§57-61)

**PER-GARMENT COMMERCE: PRESENT.** Verified directly:

- `services/multiItemCommerce.ts` (`fetchMultiItemCommerce`) dispatches one
  independent commerce request per detected garment in parallel and
  returns `Map<candidateId, ItemCommerceCard>` — one card per garment, each
  with its own `bestMatch`/`alternatives`. A per-candidate failure never
  affects another candidate's card.
- `components/scan-results/MultiItemCommerceSection.tsx` already renders
  exactly the §59 shape: one block per detected garment (jacket, skirt,
  boots, …), each with its own BEST MATCH / ALTERNATIVES purchase-option
  panels (Retail/Resale badge now included per PR B), each with
  independent Shop/Watch actions. Its own header comment states the
  contract in these words: "garment-organized, never retailer-organized."

Per §60, this already IS the Full Look surface the plan describes — it is
inline within the scan result rather than a separate sheet/modal, which
§60 explicitly allows ("reuse an existing sheet/modal/navigation pattern
**if suitable**"). Building a second, separate "Full Look" modal that
duplicates this exact per-garment/per-offer structure would violate §60's
own "must not duplicate Scanner analysis" requirement and §51's ban on
inventing a parallel architecture where a real one already exists.

**Verdict: FULL LOOK: PRESENT (as MultiItemCommerceSection, shipped).** No
new Full Look surface is built in PR C.

---

## 4. What PR C ships (§50, §76)

Given the gate above, PR C is scoped to what §50 allows without grouping:

- **Where to Buy** (§54-56) — a neutral retailer-count summary built from
  whatever offers are actually present for one item, ordered by first
  appearance in the existing ranked offer stream (no new ranking).
  `services/commerce/whereToBuy.ts` + `components/commerce/WhereToBuySummary.tsx`.
- **Single-item purchase-option detail** — already shipped
  (`PurchaseOptionsPanel`, adopted onto the shared retailer/commerce-exit
  authority in PR B). Nothing new needed.
- **Retail/Resale presentation** — already shipped in PR B.
- **Full Look** — already shipped as `MultiItemCommerceSection`; no new
  surface built, per §3 above.

This is the §76 "success, not failure" outcome the plan explicitly
anticipates: **PR C: SINGLE-ITEM PURCHASE OPTIONS + WHERE TO BUY ONLY**,
with grouped cross-retailer purchase options recorded as deferred pending
real stable-identity coverage, not built on invented matching.
