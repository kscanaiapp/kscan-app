# Commerce V2 — PR A Owner Review Packet: Retailer Truth

Build 35 Commerce V2, PR A (`Commerce V2: retailer identity and shared
retailer presentation`). This is the mandatory owner checkpoint the plan
requires before PR B/C content may merge (Build 35 §24, §89). PR B/C are
built as stacked commits on the same branch/PR against this frozen contract
in the meantime (§24, §75) — nothing here blocks that work from continuing,
only from merging ahead of this review.

**Verdict requested:** `RETAILER TRUTH APPROVED` or `REVISIONS REQUIRED`.

---

## 1. Semantic-repair table (§13, §89)

| Surface | Old value | Old meaning | New value | Authority | Outcome |
|---|---|---|---|---|---|
| `components/ProductShelf.tsx` `getRetailer()` | `[retailer, brand, source, merchant, store]` — brand checked before source/merchant/store | AMBIGUOUS → effectively BRAND-as-RETAILER; a brand-only product showed the brand name in the "where to buy" slot | `[retailer, source, merchant, store]` — brand removed entirely | This audit, live-shelf finding A.1 | **FIXED** (`__tests__/commerce/sellerTruthRepairs.test.js`) |
| `services/dressingRoomCommerce.ts` `normalizePurchaseOptions()` | `[retailer, brand, merchant, store, source]` — brand checked second, ahead of merchant/store/source | AMBIGUOUS → BRAND-as-RETAILER, **persisted** into Dressing Room / Saved Scan snapshots (`CanonicalPurchaseOption.retailer`) | `[retailer, merchant, store, source]` — brand removed entirely | This audit, persisted-data finding A.2 (the more consequential one) | **FIXED** (`__tests__/commerce/sellerTruthRepairs.test.js`) |
| `services/dressingRoomCommerceCard.ts` `resolveRoomCommerceCard()` | Nulls `retailer` when it string-equals `brand` | Existing, narrower guard against the same class of bug (exact-match only) | Unchanged | Pre-existing in codebase | Left in place — still useful defense-in-depth, no longer the only guard |
| `RecommendedProduct.source` (`supabase/functions/scan-identify/shoppingProvider.ts`) | Explicitly documented as "retailer identity, not brand" | SELLER-RETAILER (also doubles as PROVIDER label via per-adapter literal matching) | Unchanged — backend already correct | Pre-existing | No repair needed |
| `RecommendedProduct.brand` (`shoppingProvider.ts`) | Manufacturer brand, "never derived from source" | BRAND (correctly isolated) | Unchanged | Pre-existing | No repair needed |
| `components/scan-results/types.ts` `mapRawProductToPurchaseOption()` | `raw.retailer \|\| raw.source \|\| 'Retailer'` | SELLER-RETAILER, no brand fallback | Unchanged — already the cleanest path in the app | Pre-existing | No repair needed (this is the shipped ScanResultV2 surface) |
| `CommerceWatch.source` (persisted Watch) | Always server-derived from `WATCH_PROVIDER_REGISTRY` via URL domain; client-sent `listing.source` is parsed but never read | SELLER-RETAILER, server-authoritative | Unchanged | Pre-existing | No repair needed — confirms client-side conflations never reached persisted Watch data |
| `__tests__/watchlistAndroidPushConfig.test.js:291-299` | Calls `serper`/`brave` (search APIs) "retailer" alongside real retailers, in test language only | Working-vocabulary conflation of PROVIDER and RETAILER | Not touched (would require editing a Watchlist-lane-owned test outside this lane's file ownership, §64) | This audit, Finding B | **Recorded, not fixed** — flagged for the Watchlist lane; does not affect runtime behavior |

Full audit evidence (file:line citations for every finding): see the two
research artifacts this PR A was built from,
`commerce-surface-audit.md` and `commerce-contracts-audit.md`
(session scratchpad — available on request; findings are reproduced above
and in code comments at each repair site).

---

## 2. Retailer registry (§17, §89.D)

`services/commerce/retailerRegistry.ts`, version 1. Every entry is backed by
a current commerce adapter, the secondhand provider, or a domain that
recurs across this repo's own commerce test fixtures — **no retailer was
invented** (§17).

| retailerKey | displayName | domain(s) | commerceType | logo | rights basis | evidence |
|---|---|---|---|---|---|---|
| `farfetch` | Farfetch | farfetch.com | retail | none (monogram `F`) | n/a — no logo shipped | `farfetch3Provider.ts`, `WATCH_PROVIDER_REGISTRY` |
| `kickscrew` | KicksCrew | kickscrew.com | retail | none (monogram `K`) | n/a | `kicksCrewProvider.ts`, `WATCH_PROVIDER_REGISTRY` |
| `poshmark` | Poshmark | poshmark.com | resale | none (monogram `P`) | n/a | `poshmarkProvider.ts` |
| `vinted` | Vinted | vinted.com | resale | none (monogram `V`) | n/a | `SecondhandItem.source === 'vinted'` (`types/scan.ts`) |
| `nordstrom` | Nordstrom | nordstrom.com (covers `shop.nordstrom.com` via subdomain match) | retail | none (monogram `N`) | n/a | Recurs across `__tests__/phase3CommerceAuthWeather.test.js`, `__tests__/dressingRoomUxMaturity.test.js`, `__tests__/externalUrlOpenSafety.test.js` |

**Logo rights table:** every entry ships `logoAsset: null` /
`logoRightsBasis: null` today. Zero retailer logo files exist anywhere in
the repo (confirmed by audit); none were sourced by web search, scraping,
hotlinking, or a logo API (§19, forbidden explicitly). All five retailers
render via the monogram fallback (`RetailerIdentity`, §20) until the owner
provides or approves a real asset per
`assets/commerce/retailers/README.md`.

---

## 3. Domain mapping behavior (§16, §78, §89.D)

`resolveRetailerIdentity` (`services/commerce/retailerIdentity.ts`) only
uses a domain when **all** of: no declared seller field, the purchase URL
passes `isSafeCommerceUrl` (reused from `commerceDestination.ts` — HTTPS,
no credentials, no private host), the URL is not an aggregator destination
(reused `isAggregatorDestination`), and the hostname (or a subdomain of it)
is in the committed registry. Verified by
`__tests__/commerce/retailerIdentity.test.js` and
`__tests__/commerce/retailerRegistry.test.js` (46 + resolver tests, all
passing):

- Known merchant domain → resolves (`farfetch.com`).
- Marketplace subdomain → resolves via apex domain (`shop.nordstrom.com` → `nordstrom`).
- Redirect/aggregator host (Google Shopping) → stays unknown, never becomes "Google".
- Unmapped real domain → stays unknown, never becomes a fabricated retailer from the hostname.
- Shared/generic storefront host → stays unknown.
- Credentialed/unsafe URL → domain is never even inspected.

---

## 4. Negative controls executed (§77-§80, §89)

All in `__tests__/commerce/retailerIdentity.test.js` and
`__tests__/commerce/sellerTruthRepairs.test.js`:

- **§77 seller truth**: `brand=Nike, retailer=Farfetch` → resolves `Farfetch`, never `Nike`. A brand-only offer never resolves any retailer. Brand is never read even when it collides textually with a real retailer name.
- **§78 domain truth**: known/redirect/subdomain/unknown/shared-host domain cases all behave as listed above.
- **§79 logo truth**: `RetailerIdentity`'s logo lookup is a static per-`retailerKey` map (`__tests__/commerce/retailerIdentityComponent.test.js`); with zero real entries populated today, retailer A structurally cannot render retailer B's logo — there is nothing to cross-wire.
- **§80 ranking unchanged**: resolving identity never mutates or reorders the offer list; identical input produces identical output on repeat calls, independent of registry key iteration order.

---

## 5. What PR A deliberately did NOT do

- No commerce-card visual redesign (PR B, §22, §45).
- No wiring of `RetailerIdentity`/`resolveRetailerIdentity` into ProductShelf/PurchaseOptionsPanel/Watchlist JSX yet — PR A ships the shared authority; PR B/Watchlist lane adopt it (§21, §63).
- No changes to ranking, offer ordering, or which offers are shown.
- No new retailer added beyond what current adapters/fixtures already evidence.
- No logo asset added — none has a rights basis yet.

---

## 6. Acceptance (§91)

- RETAILER TRUTH: PASS (two conflations found and fixed; see §1 above)
- BRAND ≠ RETAILER: PASS (resolver structurally never reads `brand`; component structurally never reads `.brand`)
- REGISTRY: PASS (5 entries, all evidence-backed, O(1) keyed lookup)
- DOMAIN MAPPING: PASS (safe + non-aggregator + registry-gated; subdomain-aware)
- LOGO RIGHTS: PASS (zero unauthorized logos; monogram fallback for all)
- MONOGRAM FALLBACK: PASS
- RETAILER NEUTRALITY: PASS (registry presence/order has no ranking effect — proved by §80 negative control)
- RANKING UNCHANGED: PASS

---

## 7. Fixture-edit evidence (closure §7)

Four fixture expectations in `__tests__/fixtures/commerce/offers.js` were
changed from `commerceType: null` to `commerceType: 'retail'` during PR A.
This section is the required owner-verdict evidence for those edits.

**Order of events matters, and is stated plainly:** the implementation was
changed FIRST, for a stated semantic reason, and the fixtures were then
brought into line with the corrected rule. The first draft of
`resolveRetailerIdentity` returned a single frozen `UNKNOWN_IDENTITY`
constant on the unresolved-retailer path, which zeroed *every* output field
— including `commerceType`. That discarded a fact the offer itself had
declared. The resolver was corrected to carry the declared `commerceType`
through on all paths (see the `declaredCommerceType` comment in
`services/commerce/retailerIdentity.ts`), and these four fixtures then
followed. No expectation was edited merely to match whatever the code
happened to emit.

| Scenario ID | Input `commerceType` | Old expected | New expected | Semantic rule | Why the old expectation was wrong | Negative control |
|---|---|---|---|---|---|---|
| `unknown_retailer_unmapped_domain` | `'retail'` (declared on the offer) | `null` | `'retail'` | A declared retail/resale fact is about the TRANSACTION and survives an unresolved seller | Conflated "we cannot name the seller" with "we do not know whether this is retail or resale" — two independent facts | `unknown_retailer_no_url` (no declared `commerceType` → stays `null`) |
| `aggregator_destination_no_declared_field` | `'retail'` (declared) | `null` | `'retail'` | Same rule; refusing the aggregator domain affects the SELLER only | The aggregator refusal is a retailer-identity decision; it says nothing about the transaction type the offer declared | `brand_only_never_becomes_retailer` (no declared `commerceType` → stays `null`) |
| `shared_host_unmapped` | `'retail'` (declared) | `null` | `'retail'` | Same rule; an unregistered host blocks naming the seller, not reading the declared type | Dropping the declared value would have been a silent loss of provider truth | `unknown_retailer_no_url` |
| `unsafe_destination_domain_fallback_refused` | `'retail'` (declared) | `null` | `'retail'` | Same rule; rejecting an unsafe URL is a safety decision about the destination | Safety rejection must not also erase an unrelated declared fact | `brand_only_never_becomes_retailer` |

### The three required proofs

Verified behaviourally (see `__tests__/commerce/retailerIdentity.test.js`
and the checks below):

1. **DECLARED `commerceType` may be honored as presentation truth.**
   `{retailer:'Farfetch', commerceType:'retail'}` → `retail`.
   A declared value also OUTRANKS the registry: `{retailer:'Farfetch',
   commerceType:'resale'}` → `resale`, not the registry's `retail`.
2. **UNKNOWN `commerceType` remains unknown.**
   `{retailer:'Some Boutique'}` (unregistered, nothing declared) → `null`.
   `{}` → `null`. Nothing manufactures a type out of nothing.
3. **Retailer identity does not fabricate `commerceType` — with one
   documented, bounded exception the owner should see explicitly.** For the
   five REGISTERED retailers only, the registry supplies its own stable
   classification when the offer declared none (`{retailer:'Poshmark'}` →
   `resale`, because Poshmark is a resale marketplace as a whole). This is a
   committed, reviewable registry fact (`commerceType` on each registry
   entry, documented there as "only when stable/known for this retailer as a
   whole"), not an inference from the offer. An UNREGISTERED retailer never
   gains a classification this way. If the owner prefers strict declared-only
   semantics, deleting the `?? entry.commerceType` fallback in
   `resolveRetailerIdentity` is a one-line change with no other consumer.
