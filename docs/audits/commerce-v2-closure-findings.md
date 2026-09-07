# Commerce V2 — Closure Pass Findings

Build 35 closure pass. Truth and certification only: no new Commerce
features, no visual redesign, no fuzzy identity, no new provider, no
Production mutation, no merge.

All evidence below is **SOURCE-PROVEN** (read from the code on the certified
HEAD) unless a line is explicitly marked **PENDING-RUNTIME**, which means it
cannot be settled without live provider credentials this lane does not hold.

---

## 1. Affiliate / revenue path truth (P0)

### Per-adapter table

Every reachable Commerce route, traced from the upstream response field to
the URL the Shop action opens.

| Provider / adapter | Upstream URL field | Raw merchant or tracked | Tracking authority | Parameters / redirect authority | Preserved by K Scan? | Revenue path proven? |
|---|---|---|---|---|---|---|
| **Serper** (`shoppingProvider.ts` → `google.serper.dev/shopping`) | `it.productLink`, falling back to `it.link` | Raw merchant destination (`productLink`); `link` is the Google Shopping product page, deprioritized as an aggregator | None. Serper is a SERP-data API; K Scan holds no publisher/affiliate account with it or with any merchant | K Scan adds nothing. `normalizeUrl` strips only `utm_*`, `gclid`, `fbclid`, `msclkid`, `mc_eid`, `mc_cid`, `_hsenc`, `_hsmi` | Yes — any non-ad-click query param, including a genuine affiliate parameter, survives byte-identical | **NO** |
| **Brave** (`shoppingProvider.ts` → `api.search.brave.com`) | `r.url` | Raw web result | None | Same `normalizeUrl` | Yes | **NO** |
| **Poshmark** (`poshmarkProvider.ts`, RapidAPI search) | `item.url` → `normalizeUrl` | Raw `poshmark.com` listing | None. RapidAPI key is a data-access key, not a publisher ID | Same `normalizeUrl` | Yes | **NO** |
| **Farfetch3** (`farfetch3Provider.ts`, RapidAPI enrichment) | n/a — enrichment only; the URL is the already-discovered one passed in as an argument | Raw `farfetch.com` product URL | None | URL is passed through untouched | Yes (identity function) | **NO** |
| **KicksCrew** (`kicksCrewProvider.ts`, RapidAPI enrichment) | n/a — same enrichment pattern | Raw `kickscrew.com` product URL | None | Passed through untouched | Yes | **NO** |
| **Vinted secondhand** (`search-vinted-secondhand`) | `record.listingUrl ?? listing_url ?? itemUrl ?? url ?? web_url` | Raw `vinted.com` listing | None | Same `normalizeUrl` | Yes | **NO** |
| **Sneaker marketplace links** (`SneakerReference.marketplaceLinks.{stockx,goat,flightClub}`) | Upstream-supplied strings | Raw marketplace URLs | None | Not constructed by K Scan — no template, no tag | Yes | **NO** |

### The stripping question, answered precisely

Three separate URL normalizers exist, and only one of them touches the URL
that ships to the client. This distinction is the whole answer:

1. **`shoppingProvider.normalizeUrl`** — **applied to the shipped
   `productUrl`.** Strips ad-click/analytics params only (`utm_*`, `gclid`,
   `fbclid`, `msclkid`, `mc_eid`, `mc_cid`, `_hsenc`, `_hsmi`). It contains
   **no affiliate-network parameter** (`ref`, `affiliate_id`, `irclickid`,
   `clickid`, `tag`, …), so a genuine affiliate parameter would survive.
2. **`scanCommerceRouter.normalizeProductUrl`** — strip list DOES include
   `ref`, `source`, `affiliate_id`, `irclickid`, `clickid`, `campaign` — but
   its only call site is `dedupeProductsByUrl` (`scanCommerceRouter.ts:715`),
   where the result is used **solely as a `Set` dedupe key**; the pushed
   product keeps its original untouched `productUrl`.
3. **`qualityTuneCommerce.canonicalizeUrlForIdentity`** — same affiliate-ish
   strip list, and its own doc comment says *"Canonicalize URL for identity
   only — do not use as client-facing URL."*

So the affiliate-stripping that exists is confined to identity/dedupe keys
and never reaches the shipped destination. Client-side, `openCommerceOffer`
opens the URL byte-identical (pinned by a test).

### Verdict

**AFFILIATE REVENUE PATH: ABSENT** (SOURCE-PROVEN)

Corroborating negative evidence: no affiliate-network name, publisher ID,
click-ID minting, or partner env var exists anywhere in the repo or in
`.env.example`; no client-side code appends a tag, ref, or partner param to
any URL; every provider credential is a data-access key.

> **P0 BUSINESS MODEL GAP — AFFILIATE MONETIZATION NOT IMPLEMENTED**
>
> Every reachable Shop destination today is an untracked merchant or
> marketplace URL. K Scan earns nothing on a completed purchase. This is a
> commercial gap, not a code defect — the URL handling is correct and
> already preservation-safe.

One caveat stated honestly: whether a given upstream `productLink` ever
*happens* to arrive already carrying a third party's affiliate parameters is
**PENDING-RUNTIME**. It does not change the verdict, because such attribution
would belong to whoever generated it, never to K Scan.

**Narrowly scoped follow-up recommendation (not built here):** a single
`affiliateDestination(offer)` seam immediately before `openCommerceOffer`,
which — only for merchants under a signed program — rewrites the destination
through that program's documented deep-link format. It needs, in order: (1) a
signed affiliate/network agreement, (2) a credential store for the publisher
ID, (3) a per-merchant allowlist so an unenrolled merchant is never rewritten.
No code should be written before (1) exists.

---

## 2. Commerce click / exit telemetry

Can a Shop tap answer WHO / FROM WHICH SURFACE / WHICH RETAILER / WHICH OFFER
/ WHEN, without prohibited PII or raw URLs? Today: no.

- No client-side Shop/Watch tap event exists anywhere (repo-wide grep for
  `commerce_exit`, `shop_click`, `watch_click`, `buy_click`: zero).
- `scan_commerce_events` is **request-level** discovery telemetry (one row
  per `scan-identify` call) and its own header forbids storing
  product/image/purchase URLs. It cannot answer "which offer was clicked",
  and re-purposing it would violate its stated contract.
- `user_commerce_watch_events` is a Watch price-change history, not a tap.
- PostHog is wired for other domains only, and `posthogClient.core.ts`
  carries its own documented unresolved consent-authority caveat.

**SHOP CLICK TELEMETRY: ABSENT**

Per owner direction, Commerce was **not** wired into PostHog in this lane.
`recordCommerceExitEvent` in `services/commerce/commerceExit.ts` remains the
single future insertion seam, already receiving the bounded payload the
preferred follow-up would send (action, retailerKey, commerceType,
sourceAuthority, surface) with no raw URL, query string, image, PII, or
affiliate secret.

---

## 3. Provider identifier retention audit

The question is not "does the normalized offer carry an identifier" (PR C
already answered no) but **"do providers return identifiers K Scan drops?"**

| Provider | Identifier present upstream? | Identifier retained? | Trust level | Cross-retailer value? | Action |
|---|---|---|---|---|---|
| **KicksCrew** | **YES** — `product.variants[0].sku`, read by `extractSku()` (`kicksCrewProvider.ts:146-151`) | **Collapsed, not retained as an identifier** — `const id = sku \|\| product.id \|\| productUrl` (`:181`). `KicksCrewProduct` declares no `sku` field, so downstream a real SKU is indistinguishable from a URL fallback | **High** — a sneaker SKU is a manufacturer style code | **HIGH** — the one genuinely cross-retailer key found | Preserve as a typed `sku` field |
| **Farfetch3** | **YES** — `data.internalProductId` (`farfetch3Provider.ts:181`) | Collapsed into `id` the same way | High within Farfetch | **LOW** — retailer-scoped, not a shared product key | Preserve as retailer-scoped id |
| **Poshmark** | **YES** — `item.listingId` (`poshmarkProvider.ts:196`) | Collapsed into `id` | High for the listing | **NONE** — identifies a listing, not a product | Preserve as listing id only |
| **Vinted** | **YES** — `record.id / itemId / item_id` (`search-vinted-secondhand/index.ts:181`) | Collapsed into `id` | High for the listing | **NONE** | Preserve as listing id only |
| **Serper** | **UNVERIFIED** — the adapter references no identifier field, so presence upstream cannot be proven from source | n/a | n/a | Would be high if GTIN/productId is returned | **PENDING-RUNTIME** — capture one real response and check |
| **Brave** | **NO** — generic web results | n/a | n/a | None | None |

### Two consumers are already waiting for fields nothing populates

- `qualityTuneCommerce.productIdentityKey` (`:308-318`) builds a
  `sku:{retailerId}|{sku}` key with type `retailer_sku` — reading `rec.sku` /
  `rec.SKU` / `rec.retailerId`, none of which any adapter writes. The
  strongest identity tier in the ranking layer is therefore **unreachable in
  production**, and KicksCrew's real SKU is sitting one field away from it.
- `canonicalCommerce.toOffer` (`:150`) reads
  `rec.providerProductId ?? rec.productId` — also never written, so
  `providerProductId` is always `null` on a live canonical offer.

### Verdict

**IDENTITY SUBSTRATE: PARTIAL** — more precisely *present-but-collapsed*.
Real identifiers arrive from four of six adapters and are captured, but every
one is flattened into the generic `id` field at the adapter boundary, losing
the semantics that would make it usable. Only the KicksCrew SKU has genuine
cross-retailer value.

**This makes the next identity lane ADAPTER ENRICHMENT, not a new data
source.** The minimal, honest scope: add optional typed `sku` /
`retailerProductId` fields to `RecommendedProduct`, populate them where the
adapter already extracts the value, and let the existing
`productIdentityKey` tier light up. That is a provider-truth change, not a
matching algorithm, and it is explicitly NOT built in this closure pass.

**GROUPED COMMERCE remains DEFERRED** — one high-value identifier from a
single sneaker adapter is not a cross-retailer substrate. Re-evaluate after
adapter enrichment lands and coverage can be measured for real.

---

## 4. Persisted read-path safety (legacy retailer data)

### The two data classes, proved separately

| Data class | Affected? | Evidence |
|---|---|---|
| **Dressing Room / Saved Scan** | **AFFECTED** | `normalizePurchaseOptions` (pre-repair) wrote `record.brand` into `retailer`; that output is persisted into `saved_scans.purchase_options` and room snapshots, and is read back verbatim by `savedScansCloud.ts:238,328`. The PR A repair changed only what NEW writes produce. |
| **Watchlist** | **UNAFFECTED** | `commerce-watch-refresh/index.ts:395,456` always persists `p_source: watchProviderForUrl(safeUrl)`. The client-sent `listing.source` is parsed into the request type and never read again. A client-side conflation was structurally incapable of reaching `user_commerce_watches`. |

### The five questions

1. **Does stored retailer survive indefinitely?** Yes — nothing rewrites
   historical rows.
2. **Does the new resolver trust the stored value?** It did. Under the
   approved live resolver a stored `retailer: "Ganni"` is a declared field
   and resolves to "Ganni" — the legacy lie renders today. Pinned by a test.
3. **Can retailer be re-derived from a governed canonical URL?** Yes, when
   that URL is safe, non-aggregator, and lands on a **registered** domain.
   That URL is what Shop actually opens, so it outranks a contradicting
   free-text label.
4. **Can stale bad data be recognized without false correction?** Only
   partially — and the remediation is scoped to exactly the part that can.
5. **Does remediation change ownership, product identity, or URL?** No.
   Presentation only; the stored record is not mutated (pinned by a test).

### Remediation applied — option A, read-time re-derivation

`resolvePersistedRetailerIdentity()` (`services/commerce/retailerIdentity.ts`),
used by the three surfaces that render stored commerce snapshots:
`ProductShelf`, `PurchaseOptionsPanel`, `dressingRoomCommerceCard`.

It overrides a stored label **only** when the row's own governed purchase URL
is safe, is not an aggregator, and resolves to a registered retailer domain
that disagrees with the label. It refuses in every other case — unregistered
domain, aggregator destination, unsafe URL, no URL, or a label that already
agrees. It never reads brand, title, or image, and uses no fuzzy or LLM
matching. Eleven tests pin both the correction and each refusal.

**The approved PR A resolver contract is unchanged.**
`resolveRetailerIdentity` still resolves declared-first; the persisted-aware
function is additive and separately named, so the **RETAILER TRUTH: APPROVED**
ruling stands (closure §12) and no re-approval is requested.

### Residual limitation — Decision Memo

- **QUESTION:** what to do about legacy rows whose purchase URL is on an
  *unregistered* domain, where brand-as-retailer cannot be deterministically
  contradicted?
- **AFFECTED DATA:** rows in `saved_scans.purchase_options` and Dressing Room
  snapshots written before the PR A repair, whose URL host is not one of the
  five registered retailers. Volume is **PENDING-RUNTIME** — this lane has no
  Staging DB read.
- **EVIDENCE:** the registry holds five domains; most real merchants are
  outside it, so read-time correction cannot reach most legacy rows.
- **OPTIONS:** (a) accept as a documented legacy limitation; (b) grow the
  registry, which widens deterministic coverage with no new logic;
  (c) bounded additive migration that recomputes `retailer` for stored rows
  whose URL resolves; (d) heuristic brand↔hostname comparison — **rejected**,
  it is exactly the fuzzy correction the plan forbids.
- **SAFE DEFAULT:** (a) + (b).
- **RISK:** a legacy row keeps showing a brand where a seller belongs. It is
  cosmetic and never affects the destination, the price, or the Watch.
- **REVERSIBILITY:** full — the remediation is a pure read-time function.
- **RECOMMENDATION:** accept (a) now, pursue (b) as registry entries earn
  evidence. Revisit (c) only if a Staging count shows material volume.

**Final state: NEW WRITES — closed. LEGACY READS — remediated where
deterministic, owner-hold for the remainder.**

---

## 5. Price freshness

No scan-time offer type (`RecommendedProduct`, `PurchaseOption`,
`CanonicalPurchaseOption`) carries `observedAt` / `fetchedAt` / `updatedAt` /
any provider timestamp. Only the Watch domain has one
(`lastCheckedAt` / `observedAt`), written by the refresh worker.

**PRICE FRESHNESS: ABSENT** for scan-time commerce.

No staleness threshold was invented. Commerce displays the provider-returned
price and — verified across the Commerce surfaces this lane owns — makes none
of the forbidden claims: no "Current Price", "Updated", "Verified Price",
"Fresh", or "Best Price". ("In Stock" is rendered only from a provider-declared
`availability` field, never inferred.) The correct next step is upstream
observation authority, not a 24h/48h rule.

---

## 6. TextScan currency defect — FIXED

**P1 — CURRENCY TRUTH — CLOSED.** Owner widened the diff fence after this was
reported; the fix below was then applied exactly as specified, with no
scope beyond it. `services/textScanEdge.ts` is the one path added to this
lane's allowed set.

**What changed:** the local `formatPrice` is deleted. `normalizeProductPrice`'s
numeric branch now delegates to `formatCommercePrice` — the canonical client
currency authority — instead of restating the rule.

| Input | Before | After |
|---|---|---|
| `29.99`, no currency | `$29.99` (invented USD) | `29.99` |
| `29.99`, `'USD'` | `USD29.99` (code as symbol) | `$29.99` |
| `29.99`, `'eur'` | `eur29.99` | `€29.99` |
| `1200`, `'JPY'` | `JPY1200.00` | `¥1,200` (no minor units) |
| `29.99`, `'US Dollar'` | `US Dollar29.99` | `29.99` (free text is not a currency) |
| `0` / `-5` | `$0.00` / `$-5.00` | no price rendered |

The provider-formatted **string** branch is deliberately unchanged: a
provider's own price string still passes through verbatim (`'$2,590'` stays
`'$2,590'`). That is this path's intended behaviour, and it is the one place
textScanEdge differs from `formatCommercePrice`, so it is asserted explicitly
rather than left implicit.

**Regression coverage, verified to fail against the pre-fix code:**
- `__tests__/textScanCanonicalPath.test.js` — five tests driving the real
  shipped path (`analyzeTextWithEdge` with a mocked Supabase): undeclared
  currency renders bare, declared ISO codes render as real currencies,
  free-form currency text is refused, provider strings pass through, zero and
  negative prices render nothing. Four of the five fail against the old code.
- `__tests__/commerceCurrencyTruth.test.js` — a structural pin (no `'$'`
  fallback, no local rule, must delegate) plus an anti-drift table pinning the
  numeric branch to `formatCommercePrice` across 8 amounts × 12 currencies.
  The structural pin fails against the old code.

This makes textScanEdge the **third** client formatter held to the RP-110
authority, alongside `formatCommercePrice` and `formatPriceLabel`.

### Original report (retained for the record)

**P1 — CURRENCY TRUTH**

- **LOCATION:** `services/textScanEdge.ts:53-56` (`formatPrice`), reached via
  `normalizeProductPrice` (`:66`), rendered by `app/text-scan/index.tsx`
  (retail / resale / similar product sections).
- **CURRENT BEHAVIOR:** `const symbol = currency?.trim() || '$'` then
  `` `${symbol}${price.toFixed(2)}` ``. Two defects: (a) an undeclared
  currency renders as **`$`**, inventing USD — the exact RP-110 anti-pattern
  the canonical formatters were built to remove; (b) a *declared* ISO code is
  concatenated as if it were a symbol, producing `USD29.99`.
- **REACHABILITY:** the numeric branch only. A pre-formatted string price
  (what Serper returns) short-circuits earlier, so live impact is bounded to
  numeric/catalog-shaped prices — real, but not the common path.
- **EXPECTED BEHAVIOR:** delegate to the canonical authority. An undeclared
  currency renders as the bare amount; a declared ISO-4217 code renders via
  `Intl.NumberFormat`.
- **PROPOSED MINIMAL FIX:** delete the local `formatPrice` and have
  `normalizeProductPrice` call `formatCommercePrice`
  (`services/dressingRoomCommerce.ts`) — a two-line change, no new formatter.
- **REGRESSION TEST:** extend `__tests__/commerceCurrencyTruth.test.js`'s
  existing anti-drift table to cover this third client formatter, so it can
  never diverge again.
- **DIFF-FENCE IMPACT:** `services/textScanEdge.ts` is the TextScan edge
  client, outside this closure lane's originally allowed paths.

**OWNER FENCE-WIDENING: GRANTED.** The fix above was then applied. No broader
TextScan audit was performed and no other TextScan behaviour was touched —
the only production change is the price formatter delegation.

---

## 7. Branch topology / release governance finding

Recorded, not repaired — this is release governance, not Commerce.

- **CURRENT MASTER SHA:** `688dc35e` (92 commits, tip dated 2026-08-14,
  ending at PR #170).
- **ACCEPTED BUILD 35 SHA:** `219f27aa` (PR #327; ~1,208 commits reachable).
- **COMMON ANCESTOR STATUS:** **none.** `git merge-base` between the two
  returns nothing — they are unrelated histories, not merely diverged.
- **WHY TOOLING SELECTED MASTER:** the lane was dispatched with a branch name
  but no pinned base SHA, so the session branched from the repository's
  default branch. Nothing in the dispatch could have detected that the
  default branch was not the lane's real trunk.
- **RISK:** any lane dispatched this way builds against a codebase that does
  not contain the work it is meant to extend. Here it was caught by the
  plan's own ancestor gate before any code was written; a lane without such a
  gate would have shipped a plausible-looking but unmergeable branch.
- **RECOMMENDED REPOSITORY GOVERNANCE FIX:** either make the accepted Build
  35 lineage the repository default branch, or retire/clearly mark `master`
  as historical. Until then, **every build lane must be dispatched with an
  exact base SHA**, and every lane should assert that SHA is an ancestor of
  its HEAD before starting.

No branch was deleted, force-updated, or repaired by this lane.

---

## 8. Logos

**RIGHTS-CLEARED LOGOS: 0. MONOGRAM FALLBACK: ACTIVE.** No logo was sourced,
downloaded, or bundled in this pass.

Whether existing provider agreements expose approved merchant-logo assets or
brand-media terms is **PENDING-RUNTIME / OWNER**: this lane has no access to
the RapidAPI, Serper, or Brave contracts, and the repo contains no licensing
documentation for any of them. Worth checking before commissioning artwork —
several commerce APIs include merchant logo URLs under their own terms.
