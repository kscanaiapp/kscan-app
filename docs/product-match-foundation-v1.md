# Product Match Foundation V1

Status: **dormant foundation, not deployed.** Feature flag off, no provider
credentials wired, absent from the governed edge-function manifest, no database
writes. Nothing about production behaviour changes on this branch.

Primary goal: improve product-match accuracy.
Secondary goal: stop product retrieval from adding unacceptable scan friction.
Accuracy wins ties — see [Latency must not touch confidence](#latency-must-not-touch-confidence).

---

## 1. Where this branch comes from

`master` is **not** the product lineage. The repository holds two lines that
forked at `a601adf` (2026-06-11) and have not been merged since:

| | `master` line | mobile app line |
|---|---|---|
| head at time of writing | `08f0d0e` | `f5fb946` (`validation/android-build25-prebuild-readiness`) |
| `supabase/functions/scan-identify/` | 4 files — a *gateway* refactor | 34 files — the commerce/quality/provider modules |
| relationship to production | **not deployed** | **deployed as v141, byte-for-byte** |

Verified mechanically, not by inspection: the deployed source of every function
was downloaded with `supabase functions download`, hashed with
`git hash-object --no-filters`, and looked up in the object database.

| deployed function | version | verdict |
|---|---|---|
| `scan-identify` | 141 | **exact** — all 25 modules + 5 `_shared` dependencies present as identical blobs on the app line |
| `stylechat-generate` | 84 | **exact** — all 31 files |
| `product-search-deals` | 71 | **drift** — app-line source + an uncommitted account-guard hotfix (26 diff lines) |
| `search-vinted-secondhand` | 7 | **drift** — same hotfix pattern (24 lines); absent from `master` entirely |
| `kickscrew-sneaker-description` | 70 | **drift** — secret renamed to `KICKSCREW_RAPIDAPI_KEY`, uncommitted |
| `nike-shoe-details` | 68 | **drift** — an "experimental, do not wire into production" warning was deleted, uncommitted |

The four drifted functions are the standalone provider proxies. Their deployed
source matches **no commit in the repository**. `security/provider-edge-auth-hardening`
contains a much larger hardening rewrite of the same four, which is also not what
is deployed. None of them is on the `scan-identify` retrieval path, so this phase
does not depend on them — but they are unreproducible from source today, and that
should be closed before anyone edits them.

Corroboration: `config/edge-function-manifest.json` records
`_shared/catalogRetrieval.ts` at sha256 `36df6c3c86cbed1d…`, which is exactly the
hash of the file downloaded from production.

**Base commit: `f5fb946`.** Note that `hotfix/android-elise-attach-first`
(`e63d594`) is a *sibling*, not an ancestor: both descend from `4d0ceb4`. This
branch does not contain that hotfix, and merging in either direction is trivial
because product-match adds only new files.

---

## 2. What production looks like today

From `scan_commerce_events` (n = 54) and `scan_intelligence_events` (n = 113),
read-only:

**Retrieval is a sequential cascade.** `providers_tried` shows ordered attempts —
`[farfetch, serper]`, `[kickscrew, farfetch, serper]`, `[farfetch, serper, brave]` —
each `await`ed before the next. Total latency is the *sum* of the attempts.

**The specialists almost never win.** `provider_outcome` is `serper` in
essentially every completed row. KicksCrew and Farfetch are paid for in latency
and then discarded. `recommended_product_sources` is `["Serper"]` and nothing
else, across every row.

**Measured latency.**

| | p50 | p95 |
|---|---|---|
| `commerce_duration_ms` | 1.3–2.0 s | ~3.0 s |
| `total_duration_ms` | 5.4–10.8 s | 8.2–12.8 s |

Retrieval is not the dominant cost — identification is. That matters for target
setting: the first-useful target is achievable inside the current commerce
budget, and the way to reach it is to stop *serializing*, not to cut providers.

**Multi-item scans retrieve nothing.** 19 `multi_item_detection` rows completed
with `provider_outcome = 'none'` and zero products. That is a coverage gap, not
a latency problem.

**`saved_scans` carries no products.** 25 rows, 0 with `products`, 0 with
`purchase_options`. The columns exist and are unpopulated.

**`product_catalog` in production is 100% test data.** All 14 rows are
`source = 'TEST'`, retailers `K Scan Demo Catalog` / `TEST_RETAILER_A` /
`TEST_RETAILER_B`, brand `KSCAN_TEST`. The table is world-readable
(`Public read product catalog`, `qual = true`, roles `{anon, authenticated}`),
`_shared/catalogRetrieval.ts` documents catalog products as "primary in v1", and
`avg(catalog_count) = 3.10` with 51 of 58 Serper-provider scans retrieving at
least one row.

They have not reached users: `recommended_product_sources` is never anything but
`["Serper"]`, because the similarity matcher's threshold-60 filter excludes them.
**That is an accident of tuning, not a control.** One threshold change surfaces
`KSCAN_TEST` products to real users. `normalize.isTestCatalogRow` filters them
explicitly here; the production rows themselves are an owner decision (see
[Open items](#open-items)).

---

## 3. What was built

All under `supabase/functions/product-match/`, plus a contract, a migration, a
benchmark and tests.

### Canonical contracts — `contracts.ts`

Three levels, because the three questions have different answers and different
evidence:

```
ProductFamily    "the thing itself"       Nike Air Force 1 '07
ProductVariant   "which one"              …, Triple White
ProductListing   "where you can get it"   …, on Farfetch, $115
```

Today's flat product array collapses all three, which is why two retailers
selling one shoe read as two matches and why a colourway mismatch is
indistinguishable from a different model.

Keys are **derived, never assigned** (`identity.ts`): pure functions of
normalized text, no UUID, no clock, no database. Two runs over the same provider
output produce identical keys, which is what makes the benchmark reproducible
and lets dedupe run without persistence.

### Normalization — `normalize.ts`

Structural adapters for every source already reachable in production:
`RecommendedProduct` (Serper/Brave), `FarfetchProduct`, `KicksCrewProduct`, and
`product_catalog` rows. **No new providers.**

The adapters match on field shape rather than importing the `scan-identify`
types, so `scan-identify`'s governed dependency closure is untouched. The cost is
one structural test per adapter, which the suite pays.

A brand hint is credited **only when the listing text independently carries it**.
Otherwise a hint would manufacture brand evidence out of nothing, and brand
evidence is load-bearing for `LIKELY_EXACT`.

### Conservative dedupe — `dedupe.ts`

Three rules, strongest first:

1. same canonical product URL → same **listing** (exact)
2. same exact product identifier → same **variant** (exact)
3. same family key **and** same colourway → same **variant** (derived, bounded)

Rule 3 never crosses families and never fires when either colourway is unknown —
unknown is not agreement. Image URL, price and title edit-distance are **never**
merge signals; two different colourways are closer in string distance than two
spellings of one.

Listings are grouped, never discarded. A second retailer for the same variant is
information — price, availability and retailer are the useful part.

Aggressive dedupe fails invisibly (a real listing vanishes and the output cannot
show that it existed); conservative dedupe fails visibly and recoverably. Without
a labelled dataset, only one of those is safe to ship.

### Evidence and tiers — `evidence.ts`

| tier | requires |
|---|---|
| `EXACT` | an identifier **two id-bearing sources agree on**, plus brand agreement |
| `LIKELY_EXACT` | brand + model + colourway all agree |
| `PRODUCT_FAMILY` | brand + model agree; colourway unknown or different |
| `SIMILAR` | category agrees, plus ≥1 further attribute |
| `NO_CONFIDENT_MATCH` | everything else — returned, not hidden |

Gates are conjunctions of evidence **kinds**, never of the score. `confidence` is
computed for ordering and telemetry and can never buy a tier; a maximal
soft-evidence score stops at `LIKELY_EXACT`, and there is a test that says so.

The corroboration requirement on `EXACT` came out of the benchmark. The first
run scored `EXACT` on a single Farfetch listing, because Farfetch supplied
`ff-19334521` and the brand agreed. But that identifies a row in *Farfetch's*
database, not the item in the photograph — exactly the production exact-match
claim this phase is not supposed to make. `EXACT` now needs two id-bearing
catalogues to agree, which the scanner cannot currently arrange. It is
effectively unreachable, and that is the intended state.

### Orchestration — `orchestrator.ts`

Four guarantees, each with a behavioural test:

1. **No provider blocks the result** — own deadline, own abort signal.
2. **Eligible providers run concurrently** — wall clock is the slowest, not the
   sum. Test: three 120 ms providers complete in under 300 ms.
3. **Partial results are preserved** — whatever completed before the total
   deadline is returned and flagged `partial`, never discarded.
4. **First-useful is measured separately from complete** — and neither can
   influence a tier.

Deadlines (`config.ts`, all env-overridable):

| knob | default | rationale |
|---|---|---|
| `PRODUCT_MATCH_PROVIDER_DEADLINE_MS` | 3000 | above the observed p95 of the slowest single provider |
| `PRODUCT_MATCH_TOTAL_DEADLINE_MS` | 8000 | below the observed end-to-end p95 of the current cascade |
| `PRODUCT_MATCH_FIRST_USEFUL_TARGET_MS` | 5000 | the stated p50 target |

A per-provider deadline configured above the total is **clamped, not obeyed** —
honouring it would break the only guarantee the type makes.

#### Staged retrieval without streaming

First-useful is computed by re-evaluating the accumulated rows each time a
provider settles — the same computation a streaming transport would do at flush
time. So the number reported is the latency a staged client *would* observe. The
design is staged; the transport is not, and mobile streaming is deliberately not
required yet.

#### Latency must not touch confidence

Nothing in `evidence.ts` reads a clock or a deadline. A listing that arrived at
300 ms and one that arrived at 7 s score identically. The orchestrator may stop
waiting; it can never decide that a late-but-weak match is good enough to fill a
gap. Test: `latency never changes a tier`.

### Providers — `providers.ts`

Wraps `kicksCrewProvider.ts`, `farfetchProvider.ts` and `shoppingProvider.ts` —
all three are leaf modules with no local imports, so this adds exactly three
files to *this* function's closure and nothing to `scan-identify`'s. Being
imported by a new function does not change a module's hash.

Each executor's `enabled` mirrors the upstream module's own credential gate.
With no keys configured — the state of every environment in this phase — every
executor reports `disabled` and no upstream call is possible. **That is how "no
paid provider calls" is enforced structurally rather than by remembering.**

Serper and Brave are one executor because `getShoppingResults` implements
Serper-primary with Brave as its internal fallback, and rewriting that is a
change to the provider, not to orchestration.

### Endpoint — `index.ts`

Two independent gates, both fail-closed:

1. `PRODUCT_MATCH_ENABLED` (default `false`) → `404 FEATURE_DISABLED`. 404 not
   403, so a dormant endpoint does not confirm its own existence.
2. `x-product-match-secret` vs `PRODUCT_MATCH_INTERNAL_SECRET` → `401`. An
   **unset** secret rejects everything: unset means "not configured", never "no
   authentication required".

**The privacy boundary is unchanged.** The request accepts text attributes only —
no image bytes, no image URL, no user identifier. Unknown top-level and query
fields are *rejected*, not ignored, because an ignored field is exactly how an
image URL eventually arrives at an endpoint that documented itself as text-only.
There is a test that walks the allowlist and fails on anything image-shaped.

### Telemetry — `telemetry.ts` + migration

The event is **built and validated on every request and written on none**.
`emitProductMatchEvent` requires an injected writer; there is no default and no
env var that supplies one. Database writes are not authorized this phase.

Validating unconditionally means the privacy assertion is exercised by real
traffic from the first enabled request, rather than first exercised on the day a
writer is attached.

`assertProductMatchTelemetry` enforces categorical-only mechanically: a field
allowlist, a hex constraint on `correlation_hash`, and a scan of the serialized
event for URLs and email shapes. It throws, so a violation fails a test instead
of logging a warning nobody reads.

`supabase/migrations/20260803120000_product_match_events.sql` ships **unapplied**.
Do not `supabase db push` — this repository's migration history diverges from
production's applied versions.

### Benchmark — `tools/product-match-benchmark/` + `scripts/product-match-benchmark.js`

Offline replay of frozen provider fixtures through the real pipeline. A live run
would measure the provider and the matcher at once, so a regression in one is
indistinguishable from inventory moving underneath the other.

Governance:

- **sealed case set** — `manifest.json` holds a sha256 over every case (CRLF-
  normalized, so a Windows checkout does not break the seal for a non-reason and
  train people to reseal reflexively). A changed case without a reseal refuses
  to run.
- **no network** — the sandbox is given no `fetch` at all, and refuses non-local
  imports. Tested.
- **no fabricated results** — an unlabelled case is reported as `unlabelled` and
  excluded from accuracy. Zero labelled cases reports `accuracy: null`, not
  `1.0`.

**There is no accuracy baseline yet, and this scaffold does not claim one.**
It ships with one worked example, which is illustrative rather than ground
truth. A real baseline needs hand-labelled scans against real retailer
inventory — owner work.

---

## 4. Results

```
deno test  supabase/functions/product-match/     72 passed, 0 failed
deno check supabase/functions/product-match/*.ts clean
node --test __tests__/productMatchFoundation.test.js  16 passed, 0 failed
node scripts/product-match-benchmark.js          1/1 labelled case, exit 0
```

### Latency behaviour, measured

From the Deno suite (fake providers, real timers):

| behaviour | observed |
|---|---|
| three concurrent 120 ms providers | < 300 ms total (sequential would be ~360 ms+) |
| one 10 ms provider + one 5 s provider | returns with results; the slow one is `timeout` |
| two 10 s providers, 250 ms total deadline | returns in < 1.5 s, `deadlineExceeded: true` |
| fast + slow provider | `firstUsefulMatchMs` < 150 ms, strictly less than `completeMs` |
| identical rows, 1 ms vs 150 ms | identical tier and identical confidence |

These are orchestration measurements, not production latency. **No production
latency measurement was taken for this phase, and none of the operating targets
(p50 ≤ 5 s / p95 ≤ 8 s first-useful, p95 ≤ 10 s complete) has been verified
against production.** The deadline defaults are derived from the existing
`scan_commerce_events` baseline quoted in §2; verifying the targets requires
deployment, which is not authorized.

---

## 5. Open items

**Blocking activation** (each needs an explicit owner decision):

1. **Deploy the function.** It is deliberately absent from
   `GOVERNED_FUNCTIONS` in `scripts/edge-function-manifest-lib.js`, because
   `scripts/deploy-edge-functions.js` deploys everything the manifest governs —
   adding it there would make deployment the default rather than a decision.
   Activation order is: add to `GOVERNED_FUNCTIONS` → regenerate the manifest →
   deploy → *then* set `PRODUCT_MATCH_ENABLED=true`. Never the flag first;
   Closet Build 1 established what happens when a flag outruns its backend.
2. **Provider credentials** — until they are set, every provider is `disabled`
   and the endpoint returns `no_eligible_providers`.
3. **`PRODUCT_MATCH_INTERNAL_SECRET`** — required before any caller can reach it.
4. **Apply the telemetry migration** and attach a writer.

**Product/data decisions:**

5. **The 14 `KSCAN_TEST` rows in production `product_catalog`.** Publicly
   readable, retrieved on real scans, kept out of results only by a similarity
   threshold. This branch filters them in code; removing them from the table is
   an owner call.
6. **Four provider edge functions are unreproducible from source.** Their
   deployed bodies match no commit. Reconcile before editing any of them.
7. **Multi-item scans do no retrieval at all** (19/19 rows, zero products).
8. **No accuracy baseline exists.** Hand-labelled cases are the prerequisite for
   any claim that this improves accuracy.

**Not attempted, by scope:** new external providers, vector infrastructure,
image recipients, headless checkout, production exact-match claims, mobile
streaming transport.

---

## 6. Running it

```bash
node scripts/run-backend-tests.js product-match
```

```bash
node --test __tests__/productMatchFoundation.test.js
```

```bash
node scripts/product-match-benchmark.js
```
