# Commerce Corpus V1 — Final Report

Build 35 — Autonomous Commerce Truth-Harness Lane. This report satisfies
spec Section 55 and the Section 54 acceptance checklist.

---

## A. Authority

- **BASE BRANCH**: `integration/build35-v10-staging-certification-v1`
  (the current accepted Build 35 source authority — `origin/master` is stale
  at Aug 14 2026 and does not contain the required #327 ancestor; every
  branch that does contain it and is more recent than the integration branch
  is an open Commerce/VTO/Closet feature branch, explicitly excluded by
  Section 3, so the integration branch — not a feature branch — is the
  correct base)
- **BASE SHA**: `f30c175d74b7350e9c9c42ac9f163ac60d2ecccc`
  ("docs(avatars): certify V10 Build 35 staging source authority")
- **#327 ANCESTOR**: YES — `219f27aa0f2586d3bded1ca02f751a63d1960c48`
  ("Merge pull request #327 ... Build 35 convergence on post-repair K Scan
  source authority") is a direct ancestor of BASE SHA
  (`git merge-base --is-ancestor` confirmed)
- **WORKTREE**: CLEAN before this lane's changes; all changes below are new
  files only (no existing file modified)
- **AHEAD/BEHIND vs BASE SHA**: this branch is BASE SHA plus this lane's
  commits only
- **HEAD SHA**: see the PR — recorded at push time
- **PR**: see the PR — created as a draft against `master` per repo convention
  (opening against the integration branch is not supported by the hosting
  remote's default-branch PR flow; the diff is base-branch-relative and
  scoped exactly to the files listed in Section F)

## B. Corpus

- **VERSION**: `commerceCorpusVersion: 1`
- **TOTAL MANIFEST SCENARIOS**: 112
- **MEANINGFUL SCENARIOS** (Section 47 target 60-100, excluding the 3
  generated scale-permutation sets): **109**
- **OBSERVED-SHAPE COUNT**: 0 (forbidden in this lane — no Staging access)
- **SOURCE-SHAPE COUNT**: 66
- **SYNTHETIC COUNT**: 46 (includes the 11 mutation-negative-control records
  and the 3 generated scale sets)

Corpus size note: 112 exceeds the nominal 60-100 target. This is driven by
explicit mandatory per-category lists in the spec itself (Section 16: 13
domain-resolution cases; Section 28: 9 must-not-group cases; Section 35: ~14
failure cases; Section 39: 11 mandatory mutations), not filler — each
scenario is a distinct, cheaply-stated boundary probe, several combined into
single manifest entries where the underlying check is genuinely one
assertion over an array (e.g. `dom-subdomain-variants` covers 3 required
subdomain shapes as one scenario). No two scenarios test the same boundary
twice.

## C. Commerce shape census

See `docs/commerce-corpus/01-commerce-shape-census.md` for the full field
table and method. Headline findings:

- **No single canonical Product/Offer type** — at least 6 independent,
  overlapping shapes exist across backend/client/persisted/render layers.
- **Finding F1**: retailer resolution uses three different, inconsistent
  fallback chains across real call sites; 2 of 4 substitute brand (or the
  provider name) for retailer when the true retailer is absent — a direct
  doctrine violation, recorded not fixed (Section 52).
- **Finding F2**: the only mechanism that attempts cross-retailer product
  grouping (`canonicalProductKey`) is a brand+title-token heuristic,
  dormant/unconsumed by any client, and self-documented in source
  (`watchlistCapability.ts:9-11`) as merging colorways and being unstable
  under a retailer re-title. Empirically reproduced against the real
  function in `__tests__/commerce-corpus/groupingDoctrine.test.js`.
- **Finding F5**: currency-code validity is checked only as a 3-letter
  shape, never the real ISO-4217 list; `Intl.NumberFormat` itself accepts an
  unrecognized code like `XYZ` and renders it using the code as its own
  symbol (verified directly, not assumed).
- **Finding F6**: `services/commerceDestination.ts`'s `isSafeCommerceUrl`
  and `services/dressingRoomCommerce.ts`'s `normalizePersistedCommerceUrl`
  disagree on a signed/tracking query string (`?sig=...&expires=...`): the
  former allows it (never inspects query strings), the latter rejects it for
  any persisted commerce URL, image URLs included. Surfaced while grounding
  `product-image.json#img-signed-credential-shaped` and proven directly in
  `__tests__/commerce-corpus/urlSafetyTruth.test.js`.

## D. Staging evidence

**STAGING OBSERVED-SHAPE: UNAVAILABLE.** No Staging credentials or read path
were available in this lane's environment. Per Section 13, the census was
completed entirely from source contracts/types/adapters/tests; every
resulting fixture is labeled `SOURCE-SHAPE` or `SYNTHETIC`. All
runtime-prevalence claims (how often a field is actually populated in real
traffic, how common exact grouping actually is) remain unverified and are
stated as such throughout this report rather than estimated.

## E. Retailer truth

- **Brand authority**: real, distinct field (`brand`); never itself a
  retailer.
- **Retailer authority**: no dedicated type; a bare `string`, resolved via
  three divergent real fallback chains (Finding F1). Doctrine (this
  corpus's target, not universal current behavior): unknown stays unknown.
- **Provider authority**: real (`source`/`provider`), explicitly documented
  in source as "never a ranking input"; this corpus extends that to display
  as well (a provider name is not a retailer name).
- **Domain authority**: no repo-internal retailer registry exists yet
  (Commerce V2 owns building one, per Section 15) — this corpus's
  `retailerIdentity`/`retailerName` fields are explicitly labeled
  illustrative/SYNTHETIC wherever used; only URL *safety* classification
  (`isSafeCommerceUrl`/`isAggregatorDestination`) is grounded in a real,
  callable function.
- **Ambiguous fields**: `availability` (free-text, only two normalized
  outcomes); provider-issued `productId` (real but provider-scoped, not a
  universal identity — see Finding F2/product-identity category).

## F. Identity coverage

*(Section 29 — kept strictly separate by evidence class; no OBSERVED-SHAPE
exists to blend into, and neither bucket below is a runtime claim — see
`artifacts/commerce-corpus-coverage.json`'s `identityCoverage.evidenceNote`.)*

| | SOURCE-SHAPE (54 offers) | SYNTHETIC (144 offers) |
|---|---|---|
| % with provider-scoped ID | 9% | 62% |
| % with hypothetical exact cross-retailer ID | 0% | 1% |
| % with SKU | 0% | 0% |
| % with GTIN/UPC/EAN | 0% | 0% |
| % with no stable identity | 91% | 37% |

- Exact identity groups (2+ offers sharing an exact ID within one scenario): **2**
- Cross-retailer exact groups among those: **1** (the SYNTHETIC hypothetical
  demonstration fixture only — see Section G)
- Retail/Resale composition is corpus-composition data only (see the
  committed coverage report), not a runtime split.

SKU/GTIN/UPC/EAN are 0% in both buckets because these fields **do not exist
in any real production type** — this is a schema absence, not a low-fill-rate
field (Section 26; verified during the census, re-confirmed in
`product-identity.json#pid-gtin-sku-upc-ean-absent-from-schema`).

## G. Grouping readiness

**EXACT_GROUPING_READINESS: NOT_YET**

**PR C RECOMMENDATION: DEFER**

**GROUPING IMPLICATION**: Cannot be quantified. There is no OBSERVED-SHAPE
evidence in this lane, and — unlike price freshness or affiliate authority,
where the source-level contracts at least partially support an answer — the
source-level identity model provides **no cross-retailer exact key at all**
to count against. Stating a percentage of scans that could use a grouped
purchase-option ladder today would itself be a fabricated number: the one
real mechanism that attempts this (`canonicalProductKey`) is not exact-identity
based, so there is no honest way to say how many real offers would group
*correctly* versus *incorrectly* under it. The corpus's `groupingDoctrine.test.js`
proves, by calling the real function directly, that it would merge at least
one class of genuinely-different items (same title, different colorway) —
which is disqualifying for "supported," not merely "low coverage." Commerce
V2 PR C should not build a grouped purchase-option ladder against
`canonicalProductKey` without first introducing a real, governed, exact,
cross-retailer identity field.

## H. Price authority

**PRICE_FRESHNESS_AUTHORITY: PARTIAL**

**PRICE DISPLAY IMPLICATION**: Commerce V2 may display a provider-supplied
price as an offer fact. It may not label it "current" or otherwise imply
freshness from the shapes that render ordinary shelves
(`CanonicalPurchaseOption`/`PurchaseOption`/`WatchCandidate`/`RankedScanProduct`),
none of which carry a freshness timestamp. The Watchlist subsystem (and the
dormant backend v127 canonical layer) do carry `observedAt`/`lastCheckedAt`
— a future Commerce V2 surface consuming *that* data specifically could
truthfully say "last checked <time>", but that is a different, narrower
claim than "current price," and is out of scope for what this corpus can
license today outside the Watchlist context. This corpus does not invent a
staleness threshold (Section 20 forbids it).

## I. Affiliate authority

**AFFILIATE_AUTHORITY: ABSENT.** No affiliate ID, click ID, tracking ID, or
network ID is minted anywhere in source (zero grep hits across the
repository); `affiliateUrl` is a passthrough URL-candidate field, always
`null` in every real fixture in `data/catalog.json`. This corpus fabricates
zero affiliate IDs anywhere (`AFFILIATE_AUTHORITY.fabricatedAffiliateIds: 0`
in the committed coverage report); every attribution scenario is either a
truthful no-attribution case or a URL-safety case.

## J. Retail / Resale

Real, optional `commerceType: 'retail' | 'resale'` field
(`RecommendedProduct`); only the Poshmark provider ever sets `'resale'`
— every other provider leaves it unset (not defaulted to `'retail'`).
Ranking-neutrality between the two is an explicit, documented rule in
source. No dedicated size/condition fields exist for Resale beyond the
generic `availability`/`size`/`variant` fields every offer carries.

## K. Watchlist contract

A Watch is one offer at one retailer, keyed by `canonicalUrl`
(`types/watchlist.ts`), DB-unique on `(user_id, canonical_url)`. Eligibility
(`watchCapability`) is server-authored, gated by a two-provider registry
(Farfetch, KicksCrew only — every Resale offer today is therefore
non-watchable). One documented seam: the client-side `isWatchableListing()`
check reads only `watchCapability` and does not independently re-verify
`type === 'retail'`, unlike the server-side derivation — a real, if narrow,
gap between the two independently-implemented checks
(`watchability.json#watch-elig-similar-type-rejected`, SYNTHETIC — this
exact inconsistent-data combination was reasoned about, not observed).

## L. Per-garment Commerce

**PER_GARMENT_COMMERCE: PRESENT.** `services/multiItemCommerce.ts` produces
a genuinely independent `Map<candidateId, ItemCommerceCard>` per detected
garment, `Promise.allSettled`-isolated (one candidate's error never affects
another's card), with 11 pre-existing dedicated test files. Discovery
completed well within the 15-minute timebox (Section 33) via direct source
inspection — no ambiguity requiring the fallback path.

## M. Where to Buy readiness

Source order is preserved everywhere examined; no ranking/sorting by price
or commission was found anywhere in the codebase (confirmed by grep and by
`services/multiItemCommerce.ts`'s own comment that "ordering is final and
the client never re-sorts"). Retailer concentration (one retailer dominating
a result set) is real and unmasked — nothing in source rebalances or hides
it, and this corpus's `where-to-buy.json` fixtures make that visible and
testable rather than "corrected," per Section 32's doctrine. What Where to
Buy can honestly support today: presenting multiple real offers in their
original order, including Retail+Resale mixed, including an offer whose
retailer is unresolved. What it cannot yet honestly support: grouping those
offers as "the same product across retailers" (see Section G).

## N. Findings ledger

All recorded here per Section 52 (Diff Fence) — **none repaired in this
lane**:

1. **F1 — retailer-resolution divergence.** 3 real call sites, 3 different
   fallback orders; 2 substitute brand (or provider name) for an absent
   retailer. `components/ProductShelf.tsx:165-172`,
   `services/dressingRoomCommerce.ts` (persisted normalizer),
   `components/scan-results/types.ts:288-294`. Reproduced in
   `retailer-identity/brand-retailer-provider.json#ri-fallback-divergence-finding`.
2. **F2 — grouping mechanism is fuzzy, dormant, and self-flagged unsafe.**
   `supabase/functions/scan-identify/canonicalCommerce.ts:133-141`
   (`canonicalProductKey`), dormant since `canonicalProducts` is unconsumed
   by any client; source itself documents the colorway-merging risk
   (`watchlistCapability.ts:9-11`). Empirically reproduced in
   `groupingDoctrine.test.js`.
3. **F5 — currency-code validity is shape-only.** `normalizeCommerceCurrency`
   (`services/dressingRoomCommerce.ts:99-104`) and `Intl.NumberFormat` both
   accept a fake 3-letter code and render it as if valid. Reproduced in
   `pricing/price-currency.json#price-unknown-currency-code`.
4. **F6 — two URL-safety functions disagree on signed/tracking query
   strings.** `services/commerceDestination.ts`'s `isSafeCommerceUrl` allows
   `?sig=...&expires=...`; `services/dressingRoomCommerce.ts`'s
   `normalizePersistedCommerceUrl` rejects the identical shape for any
   persisted commerce URL (image URLs included). Reproduced in
   `urlSafetyTruth.test.js`'s "cross-module finding" test.

## O. Regression

Full governed suite (`node scripts/run-all-tests.js`), run after this lane's
changes:

- **TOTAL**: 8164
- **PASS**: 8082
- **FAIL**: 17
- **SKIP**: 65
- **KNOWN** (matches `config/test-failure-baseline.json`): 13
- **UNEXPECTED**: 4 — all 4 are in
  `__tests__/curiosityGapPerformance/labContract.test.js` and
  `labNetworkScenario.test.js` (source-binding hash / contract-mode /
  network-scenario checks), none of which touch any file this lane added or
  modified. This is the pre-existing "Build 35 Curiosity Gap CI condition"
  the task brief itself names as **outside this lane's scope** (Section 53).
  Not investigated or repaired here; not a regression this lane introduced.

This lane's own contribution: **101 new tests, 101 passing, 0 failing** —
`node --test __tests__/commerce-corpus/*.test.js`. The corpus does not widen
the shared failure baseline.

No repo-wide TypeScript typecheck script exists in `package.json`; this
lane's changes are pure JSON fixture data plus CommonJS `.js` tooling/tests
(consistent with `tools/fashion-match-quality`'s own convention), so there is
no new TypeScript surface to check.

## P. Corpus validation

- `node tools/commerce-corpus/validateCorpus.js` → **PASS** (manifest valid,
  112 fixture records, 0 privacy violations, 0 orphaned records, all 11
  mutations reference real scenarioIds)
- Negative-control evidence: `__tests__/commerce-corpus/mutationSuite.test.js`
  proves all 11 mandatory mutation types (Section 39) are present and each
  is either proven against a real production function (5 of 11: currency,
  credential-URL, shop-destination, watch-identity, fuzzy-grouping) or
  structurally proven against its original scenario's own doctrine (the
  remaining 6, where no single production authority exists to call).
- `__tests__/commerce-corpus/privacyBoundary.test.js` proves the reused
  privacy guard refuses 10 classes of hostile synthetic fixtures, never
  silently strips instead of rejecting, and — honestly, not silently —
  documents one real limitation of the reused guard (no generic email/phone
  VALUE-pattern, only exact key-name matches).

## Q. Mutations

**STAGING MUTATIONS: 0**

**PRODUCTION MUTATIONS: 0**

---

## Acceptance checklist (Section 54)

```
CORPUS VERSIONED: YES (commerceCorpusVersion: 1)
CORPUS VALIDATOR: PASS
SCENARIO IDS UNIQUE: PASS
EVIDENCE CLASSIFICATION: PASS (0 OBSERVED-SHAPE, 66 SOURCE-SHAPE, 46 SYNTHETIC)
BRAND ≠ RETAILER COVERAGE: PASS (6 scenarios + Finding F1 reproduction + mutation)
DOMAIN EDGE CASES: PASS (13 required cases across 9 scenarios)
RETAIL / RESALE COVERAGE: PASS (6 scenarios)
WATCH OFFER IDENTITY: PASS (real isWatchableListing wired; cross-offer leakage proven false)
SHOP OFFER IDENTITY: PASS (real selectCommerceDestination wired; cross-offer leakage proven false)
CURRENCY TRUTH: PASS (real formatCommercePrice wired for all 10 scenarios)
PRICE FRESHNESS STATUS: MEASURED (PARTIAL)
AFFILIATE AUTHORITY: MEASURED (ABSENT)
AFFILIATE FABRICATION: 0
SAFE GROUPING CASES: PASS (real optionFingerprint dedup + labeled hypothetical)
MUST-NOT-GROUP CASES: PASS (9 mandatory cases; 1 empirically proven against real canonicalProductKey)
IDENTITY COVERAGE: MEASURED (kept separate by evidence class)
GROUPING READINESS: CLASSIFIED (NOT_YET / DEFER)
ORDER PRESERVATION: PASS (Where-to-Buy + scale sourceIndex)
FAILURE STATES: PASS (10 scenarios, no fabricated stand-ins)
SCALE SETS: PASS (10/25/50, deterministic, byte-reproducible)
PII / SECRET BOUNDARY: PASS (10 hostile classes refused; 1 real limitation documented)
MULTI-ITEM STATUS: MEASURED (PRESENT)

COMMERCE_V2_AGENT_CAN_CONSUME_WITHOUT_INVENTING_FIXTURES:
YES
```
