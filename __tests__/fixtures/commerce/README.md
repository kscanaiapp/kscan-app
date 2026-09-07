# Commerce Evaluation Corpus V1

The Commerce Truth Harness for K Scan AI. A deterministic, versioned test
corpus that becomes the shared test authority for Commerce V2 (retailer
identity, commerce cards, purchase options). Built as Build 35 test
infrastructure — it does not change any Commerce, Scanner, Watchlist, VTO,
Closet, Elise, Packing, or Concierge behavior.

Full narrative: `docs/commerce-corpus/01-commerce-shape-census.md` (field
census + findings) and `docs/commerce-corpus/02-final-report.md` (verdicts,
PR C recommendation, findings ledger, regression results).

## Purpose

Before this corpus, Commerce V2 had no shared answer to questions like "does
K Scan know the difference between brand and retailer?" or "how often can
two offers actually be grouped safely?" This corpus makes those questions
mechanically answerable — as fixtures, a validator, measurement utilities,
and negative controls — rather than something each PR re-decides ad hoc.

## Directory structure

```
__tests__/fixtures/commerce/
  README.md              (this file)
  manifest.json           (generated — see "How to add a scenario")
  manifest.schema.json     (hand-maintained schema; single source of truth for enums)
  offers/                  retail-resale, shop-offer-identity
  products/                product-image, product-identity
  retailer-identity/       brand vs retailer vs provider
  domains/                 domain-resolution (URL safety + retailer identity)
  watchlist/               watchability, watch-offer-identity
  attribution/             affiliate-attribution
  pricing/                 price-currency, customer-claim-safety
  grouping/                safe-grouping, must-not-group, where-to-buy
  multi-item/              per-garment commerce
  failures/                failure-states
  scale/                   generated 10/25/50-offer sets
  mutations/               mutation-negative-control records
  accessibility/           accessibility-data (semantic facts only)

tools/commerce-corpus/
  buildManifest.js         regenerates manifest.json from every fixture file
  buildCoverageReport.js   regenerates artifacts/commerce-corpus-coverage.json
  validateCorpus.js        independent validator (CLI + importable checks)
  generateScaleCorpus.js   deterministic scale-corpus generator (seed: kscan-commerce-corpus-v1)
  lib/                     shared loaders (privacy guard reuse, manifest/fixture validation,
                            identity-coverage measurement, production-module loader for tests)

__tests__/commerce-corpus/
  *.test.js                the executable suite (node --test __tests__/commerce-corpus/*.test.js)
```

Fixture DATA lives under `__tests__/fixtures/commerce/` (note: the repo's
own test runner, `scripts/run-all-tests.js`, deliberately never executes
anything under a directory literally named `fixtures` — this is why the
executable tests live in the sibling `__tests__/commerce-corpus/` directory
instead, and why `manifest.json`'s `inputFixture` is a pointer into a data
file rather than the fixture files themselves being tests).

## Manifest schema

`manifest.json` is **generated**, not hand-maintained — run
`node tools/commerce-corpus/buildManifest.js` after adding or editing any
fixture file, then commit the regenerated `manifest.json`. Its shape is
governed by `manifest.schema.json`; every scenario carries:

| Field | Meaning |
|---|---|
| `scenarioId` | Stable, kebab-case, referenced by tests — never an array index |
| `category` | One of the enum values in `manifest.schema.json` |
| `description` | One sentence, what this scenario proves |
| `inputFixture` | `relative/path.json#scenarioId` pointer into the category file |
| `expectedOutcome` | A copy of the fixture record's own `expected` field |
| `tags` | From the fixed vocabulary (see `manifest.schema.json`) |
| `evidenceClass` | `SOURCE-SHAPE` or `SYNTHETIC` (never `OBSERVED-SHAPE` — see below) |

Every fixture DATA file (e.g. `retailer-identity/brand-retailer-provider.json`)
shares one shape: `{ commerceCorpusFixtureVersion: 1, category, records: [...] }`,
where each record carries `scenarioId`, `description`, `evidenceClass`,
`tags`, `input`, `expected`, and a `notes` field citing the real source
file:line this scenario is grounded in (or explaining why it's `SYNTHETIC`).
Mutation records (`mutations/mutation-negative-controls.json`) instead carry
`mutationOf`, `mutatedField`, `originalValue`, `mutatedValue`, `violationType`.

## Evidence classes

- **OBSERVED-SHAPE** — sanitized from an actual runtime/Staging response.
  **Not used anywhere in this corpus.** This lane had no Staging/runtime
  access (`STAGING_OBSERVED_SHAPE: UNAVAILABLE`); `validateCorpus.js` fails
  any scenario that claims it.
- **SOURCE-SHAPE** — derived from a real type/adapter/contract/test that
  exists in this repo today, but not observed at runtime. Most of this
  corpus is SOURCE-SHAPE (66 of 112 scenarios).
- **SYNTHETIC** — intentionally constructed to exercise a boundary or
  failure case with no real-source analogue (46 of 112 scenarios).

Never blend SYNTHETIC coverage into a real-data readiness claim — the
identity-coverage/grouping-readiness report keeps these two counted
completely separately, and states explicitly that (with no OBSERVED-SHAPE
evidence at all) every number describes the corpus's own composition, never
production prevalence.

## PR A/B/C mapping

Tagged via `pr-a-support` / `pr-b-support` / `pr-c-support` (a scenario may
carry more than one):

- **PR A — Retailer Identity**: retailer semantics, brand ≠ retailer ≠
  provider, domain truth, logo/fallback states, retailer concentration.
- **PR B — Commerce Cards**: price/currency, Retail/Resale, Shop, Watch
  eligibility, image/failure states, attribution preservation, accessibility
  semantic inputs.
- **PR C — Purchase Options**: offer identity, safe grouping, must-not-group,
  Where to Buy, multi-item/per-garment commerce.

## Retailer-truth doctrine (PR A)

Brand, retailer, and commerce provider/network are three independent facts
and must never collapse into one another. Brand is the manufacturer; the
retailer is who is actually selling this specific offer; the provider is
which commerce API surfaced the listing (never a ranking or display input).
When a retailer cannot be determined, it must render as **unknown** — never
as the brand, and never as the provider's own name.

**Finding F1** (recorded, not fixed in this lane — see the final report):
three real call sites in source resolve "who is the retailer" from the same
raw record with three different fallback chains, and two of them
(`components/ProductShelf.tsx`'s `getRetailer`, and the persisted-normalizer
in `services/dressingRoomCommerce.ts`) fall back to **brand** when retailer
is absent — directly violating this doctrine. See
`retailer-identity/brand-retailer-provider.json#ri-fallback-divergence-finding`
for the exact reproduction, and `mutations/mutation-negative-controls.json#mut-brand-substituted-as-retailer`
for the corresponding negative control.

This corpus may use stable fixture values like `retailerKey: "nordstrom"`
for test data. It does **not** create or own the production retailer
registry, logo mapping, or `RetailerIdentity` component — those belong to
Commerce V2 (spec Section 15).

## Currency doctrine (RP-110, PR B)

The canonical rule lives in `services/dressingRoomCommerce.ts`'s
`formatCommercePrice`/`normalizeCommerceCurrency` (deliberately re-stated,
not shared via import, in two more places for real module-boundary reasons
— see `docs/commerce-corpus/01-commerce-shape-census.md` §6). Never guess a
currency: an undeclared currency renders as a bare number, never `$`, never
`USD`. Currency validity is checked only as a 3-letter shape, not against
the real ISO-4217 list — a well-formed-but-fake code like `XYZ` is accepted
by `Intl.NumberFormat` itself and rendered using the code as its own symbol
(joined with a non-breaking space) rather than being treated as unknown —
see `pricing/price-currency.json#price-unknown-currency-code` (Finding F5).

## Watch identity doctrine (PR B/C)

A Watch is one OFFER at one retailer, identified by its canonical URL —
never a product, never a variant (`types/watchlist.ts`). Watch eligibility
(`watchCapability: 'refreshable_listing'`) is server-authored only, and is
gated by a small registry of providers with a real re-observation-by-identity
adapter (today: Farfetch and KicksCrew only — every other provider,
including the one Resale provider, Poshmark, is always `'unsupported'`).
Watching offer A must never carry offer B's identity — see
`watchlist/watch-offer-identity.json` and the corresponding
`mut-watch-a-becomes-watch-b` negative control.

## Identity / grouping doctrine (PR C — the most load-bearing doctrine here)

Safe grouping requires an **exact** trusted identity match — never a fuzzy
one (same brand, similar title, same image, same category, etc. all KEEP
SEPARATE; see `grouping/must-not-group.json`, 9 mandatory cases).

**Finding F2** (the central input to the Grouping Readiness verdict): no
production type carries a governed, cross-retailer-comparable exact product
identifier (no GTIN/SKU/UPC/EAN anywhere in shipped schema). The one
mechanism that attempts cross-retailer grouping,
`canonicalProductKey` (`supabase/functions/scan-identify/canonicalCommerce.ts`),
is dormant (its output, `canonicalProducts`, is computed but consumed by no
client) and is a **heuristic** — brand + up-to-8 normalized title tokens,
deliberately excluding retailer — which the codebase's own comments already
flag as merging colorways and being unstable under a retailer re-title.
`__tests__/commerce-corpus/groupingDoctrine.test.js` calls this real,
production function directly on this corpus's own must-not-group fixture
and empirically proves it would incorrectly merge them.

Result: `EXACT_GROUPING_READINESS: NOT_YET`, `PR C RECOMMENDATION: DEFER`.
See the final report for the full verdict and its citation.

## Affiliate / attribution doctrine (PR B)

`AFFILIATE_AUTHORITY: ABSENT`. No affiliate ID, click ID, tracking ID, or
network ID is ever minted anywhere in source; `affiliateUrl` is a passthrough
field slot only, always `null` in every real fixture in `data/catalog.json`.
This corpus never fabricates an affiliate ID — every attribution scenario is
either a truthful no-attribution case or a URL-safety case.

## Price freshness

`PRICE_FRESHNESS_AUTHORITY: PARTIAL`. Freshness timestamps
(`observedAt`/`lastCheckedAt`) exist at the Watchlist layer and in the
dormant backend v127 canonical layer, but are absent on the shapes that
render ordinary shelves (`CanonicalPurchaseOption`, `PurchaseOption`,
`WatchCandidate`). Commerce V2 may display a provider price as an offer
fact; it may not claim that price is "current" from those shapes.

## Privacy / sanitization

Every write path in `tools/commerce-corpus/` runs the reused privacy guard
(`tools/commerce-corpus/lib/privacyGuard.js`, a thin re-export of
`tools/fashion-match-quality/schema/privacyGuard.js` — the same reuse
precedent `tools/canonical-product-identity/` already established).
`validateCorpus.js` fails closed on any violation anywhere in the manifest
or any fixture file. `__tests__/commerce-corpus/privacyBoundary.test.js`
proves the guard actually refuses hostile synthetic fixtures (JWTs, API
keys, session IDs, emails, phone numbers, credential-shaped URLs, etc.) — and
also documents, rather than hides, the guard's real limitation: it has no
generic email/phone VALUE-shape pattern, only exact key-name matches, so a
real email address under an unrecognized key name would not be caught by
value alone. Keep fixture field names conventional for this reason.

## How to add a scenario

1. Add a record to the appropriate category file under
   `__tests__/fixtures/commerce/` (or create a new category file if none
   fits — then add the category to `manifest.schema.json`'s enum).
2. Ground it: cite the real file:line it's derived from in `notes`, or mark
   it `SYNTHETIC` and say why.
3. Run `node tools/commerce-corpus/buildManifest.js` and commit the
   regenerated `manifest.json`.
4. Run `node tools/commerce-corpus/buildCoverageReport.js` and commit the
   regenerated `artifacts/commerce-corpus-coverage.json`.
5. Run `node --test __tests__/commerce-corpus/*.test.js` — if your scenario
   is wired to a real production function (price/URL/watch/grouping), add
   or extend the relevant `*Truth.test.js`/`*Doctrine.test.js` file so the
   corpus stays a truth harness, not just self-referential data.

## How to run validation

```
node tools/commerce-corpus/validateCorpus.js        # structural + privacy validator (CLI)
node --test __tests__/commerce-corpus/*.test.js      # full executable suite
node tools/commerce-corpus/generateScaleCorpus.js    # regenerate scale/*.json deterministically
node tools/commerce-corpus/buildCoverageReport.js    # regenerate artifacts/commerce-corpus-coverage.json
```

## Scale generator

`tools/commerce-corpus/generateScaleCorpus.js` produces `scale/scale-{10,25,50}.json`
under a fixed named seed (`kscan-commerce-corpus-v1`) via a small
dependency-free `mulberry32` PRNG — no unseeded `Math.random()` anywhere.
Re-running the generator against the same seed reproduces the committed
files byte-for-byte (`__tests__/commerce-corpus/scaleCorpus.test.js` proves
this on every run). Each set's offers carry a `sourceIndex` field so tests
can prove commerce presentation never reorders them.

## Corpus versioning

`commerceCorpusVersion: 1` in `manifest.json`. Breaking schema changes
(a new required scenario field, a changed evidence-class definition, etc.)
require incrementing this. Individual scenarios are not separately versioned.

## Success criterion

Another Commerce V2 agent should be able to read this file plus
`docs/commerce-corpus/01-commerce-shape-census.md` and
`docs/commerce-corpus/02-final-report.md`, and know what retailer truth,
price truth, safe Shop/Watch behavior, legitimate affiliate handling, safe
grouping, and Retail/Resale look like — without inventing a single fixture
or silently upgrading weak evidence.
