# Product Match — Checkpoint 2: user value and funnel hardening

Status: **dormant.** Flag off, exact claims off, no provider credentials, absent
from the governed manifest, migration unapplied, no database writes, not
deployed. Nothing about production behaviour changes on this branch.

Builds on [product-match-foundation-v1.md](product-match-foundation-v1.md).
Checkpoint 1 established the backend foundation; this checkpoint is about
whether the user gets a cleaner, more useful result — not a more complete
architecture.

---

## 1. Corrections applied from review

### The 3 s / 8 s defaults are gone

Checkpoint 1 shipped `perProviderMs: 3000, totalMs: 8000`, reasoned backwards
from the `scan_commerce_events` distribution. That was wrong for the phase.
Cutting a provider off at a tuned threshold *hides* the latency question rather
than answering it — a provider truncated at 3 s produces no evidence about why
it took 3 s.

Now:

| | Checkpoint 1 | Checkpoint 2 |
|---|---|---|
| per-provider | 3 000 ms (tuned) | 15 000 ms (hang guard) |
| total | 8 000 ms (tuned) | 20 000 ms (hang guard) |
| first-useful | 5 000 ms *target* | 5 000 ms **observational label** |

The first-useful value no longer truncates or cancels anything. It sets
`timings.firstUsefulSlow`, a label for finding slow cases in telemetry.

Every ceiling stays env-overridable. **No number here is a promotion
requirement.** A guard test (`__tests__/productMatchFoundation.test.js`) fails if
anyone reinstates a per-provider ceiling below 10 s or a total below the 9.2 s
scan baseline.

### Stage-level instrumentation is the actual deliverable

Every response now carries `timings.stages` — `plan`, `retrieve`, `normalize`,
`relevance`, `dedupe`, `tier`, `similarity` — each with a duration and an item
count. Plus:

- `sequentialEquivalentMs` — what the same providers would have cost run in
  sequence, so the benefit of concurrency is **data**, not a claim in a document
- `baselineDeltaMs` — `completeMs` against `PRODUCT_MATCH_BASELINE_SCAN_MS`
  (9 200 ms), the current end-to-end scan
- `firstUsefulSlow` — the observational label

A move from 9.2 s to 12 s is not automatically rejected. It is a question:
*which stage grew, did quality improve, was the added call useful, can it be
parallelized / cached / deferred / removed?* The stage breakdown is what makes
that question answerable. `itemCount` alongside `durationMs` separates "slow per
item" from "slow because there were 400 items", which are different problems.

### The benchmark is labelled as what it is

It prints, every run:

```
Product Match Benchmark — DIRECTIONAL offline replay
  This is a contract and logic regression suite. It is NOT an accuracy
  baseline, and no statistical claim may be made from these numbers.
```

Five cases now, one per surface. It caught a real defect again this checkpoint
(see §3). It still cannot tell you how often the pipeline is *right* about real
scans, and it does not pretend to.

### `EXACT` is no longer defined by corroboration

The durable rule is now **decisive, authoritative identity evidence**. Two
routes satisfy it:

- `authoritative_product_id` — a verified GTIN/UPC/EAN, a manufacturer style
  code, or a first-party manufacturer record. **Sufficient alone. No second
  provider required.**
- `corroborated_product_id` — the same identifier from two independent
  id-bearing catalogues. The stand-in available today.

Corroboration is *evidence of* authority, not the definition of it. No wired
source currently produces an authoritative identifier; the kind is declared now
so a future authoritative feed is a source change rather than a tier-logic
rewrite.

Separately, `PRODUCT_MATCH_EXACT_CLAIMS_ENABLED` defaults **off** and downgrades
a would-be `EXACT` to `LIKELY_EXACT`. The evidence array is left untouched, so
the downgrade is legible: a reader sees `corroborated_product_id` under a
`LIKELY_EXACT` tier and understands exactly what happened. The gate and the
policy are separate functions because they answer different questions — "is this
evidence decisive" and "are we willing to say so in production yet" — and the
rule must be provably correct while the claim is still switched off.

---

## 2. Closet similarity is advisory, permanently

This is the correction with the most machinery behind it, because it is the one
where being wrong costs a user something irreplaceable.

```
dedupe.ts            "are these two RETAILER LISTINGS the same product?"
                     wrong answer costs: a duplicate row
                     may therefore: merge, collapse, pick a winner

closetSimilarity.ts  "is what you scanned something you ALREADY OWN?"
                     wrong answer costs: the user loses an item they wanted
                     may therefore: point it out, and nothing else
```

The output is `potentialSimilarItem: true`. **There is no `isDuplicate` field
anywhere in the contract**, and a governance test walks `closetSimilarity.ts`,
`contracts.ts` (comments stripped) and every property name in the JSON schema to
keep it that way. A second test asserts the module contains no merge or delete
verb.

Each comparison carries:

- the new scan image **and** the existing item image, side by side
- named reasons (`same_brand`, `same_normalized_color`, `same_model_tokens`, …)
  rather than a bare score — the user is being asked to judge, and "87% similar"
  does not help them judge
- `existingItemSource`: `closet` or `recent_scan`
- `resolution: 'user_required'` — always
- **all six actions, always**: `reject_new_scan`, `add_to_closet`,
  `keep_in_recent_scans`, `delete_existing_item`, `shop_identified_product`,
  `keep_both`

`keep_both` is explicit rather than implied by dismissal, so "these really are
two different items" is a recordable answer instead of an absence of one. The
module never decides an action is inapplicable; eligibility is the client's
business, and pre-filtering the choices would be deciding for the user.

Prompting requires **two** agreements including at least one stronger than
category. Category alone would flag every coat against every other coat, and a
prompt the user dismisses every time trains them to dismiss the one that matters.

No database access: candidates are passed in by the caller, who owns the closet.
That keeps this endpoint free of user-scoped reads and makes the logic testable
without a database.

A directional case asserts the property that matters most:
`expectedListingCount: 1` **alongside** `expectedPotentialSimilarItems: 1`.
Recognising that the user may already own an item must not suppress the shopping
result, because "you own this" and "here is where to buy it" are both answers
they might want.

---

## 3. The user-facing retrieval work

### Category-aware query generation

The deployed scanner builds one weighted query string from whatever attributes
it has. That conflates "what is this item" with "how do I search a retailer for
it", and when the result is bad nothing records which signal was responsible.

Queries are now built per **named strategy**, ordered per **category route**:

| route | leads with | why |
|---|---|---|
| footwear | `visible_brand_model` | sneakers *are* their model name, and retailers index them that way |
| outerwear / garment | `material_silhouette_category` | most have no model name; "wool coat double breasted" retrieves, "Zara coat" does not |
| bag / accessory | brand when visible, shape otherwise | in between |

A strategy whose required signals are absent returns `null` rather than a
degraded string. A `brand_model` query with no brand is not a weaker brand
query — it is a different query wearing the wrong label, and it would make the
retrieval report lie about what was known.

`visible_brand_model` requires text actually **read off the garment** and can
never be satisfied by an inferred brand.

**A Checkpoint 1 bug fixed here:** the old `buildProviderQuery` returned early on
a caller-supplied query, so whenever the caller passed anything at all, the
strongest identity strategies were never tried. A caller-supplied query now
*leads* the plan without suppressing the rest.

### Controlled fallback

At most **one** fallback query, only when the primary pass returned fewer than
three usable listings, and only using a strategy that was not already run. The
trigger is the result count alone — **never elapsed time**. A fallback triggered
by a latency budget would be exactly the trade this phase is not making:
spending a provider call to fill a gap the clock created rather than one the
evidence created.

### Relevance and category-conflict rejection

Two separate mechanisms, deliberately not merged:

1. **Category conflict — hard rejection.** Scan says footwear, listing is
   unambiguously a bag → rejected. No score rescues it; a wrong-category result
   is not a weak match, it is a different product.
2. **Relevance score — soft floor.** Removes listings sharing nothing with the
   query beyond having been returned by a search engine.

Conflating them produces the classic failure where a "relevant-looking"
accessory outranks the actual garment because it shares more title tokens.

A third rule rejects **accessories to** the product — cleaner, spray, shoe
trees, laces, hangers, dust bags. These pass a category check ("shoe cleaner"
genuinely is footwear-adjacent), so they need their own rule.

An unrecognizable listing route never conflicts with anything, and a low-signal
query admits rather than emptying the result set — the population with the
fewest known attributes is the one most in need of a "similar item" answer.

Every rejection is **counted by reason** and surfaced in `retrieval`:
"we found 40 things and threw away 31 for category conflict" is the single most
useful diagnostic when a category's results look wrong, and it is invisible if
the rejections are silent.

### Commerce-listing grouping

Listings are grouped by retailer within a variant: *"Farfetch, from $115
(2 listings)"* instead of three near-identical rows. Nothing is discarded —
dedupe decides what is the same thing, grouping decides how the survivors are
arranged. `representativePrice` is verbatim from the strongest listing, never
parsed or compared numerically, because V1 has no currency model and a
"lowest price" across unparsed strings would be a claim the data cannot support.

### The benchmark caught a second real defect

`coat-unbranded-material-led` initially expected the plan
`material_silhouette_category + brand_color_category`. The pipeline produced
`material_silhouette_category + category_color` — because the coat query has no
brand, so every brand strategy correctly declined. **The implementation was
right and the fixture expectation was wrong**, which is the fixture doing its
job: it forced the "a strategy without its signals returns null" rule to be
stated out loud rather than assumed.

---

## 4. Production test-catalog exclusion gate

`catalogExclusion.ts` is a named, deterministic, independently testable
boundary — not a filter call buried in a provider.

Six named rules (`source_marked_test`, `brand_marked_test`,
`retailer_marked_test`, `external_id_test_prefix`, `demo_catalog_retailer`,
`non_production_url`), each reported individually so a rejection can be
explained and a false positive traced to one rule. The last rule catches
RFC 2606 / 6761 reserved hosts — `example.com`, `.test`, `.invalid`, `localhost`
— which can never resolve to a live store.

All 14 real production rows are pinned as a **frozen fixture inside the module**,
so if someone later loosens a rule, the failing test names the actual row that
would have escaped. `normalize.isTestCatalogRow` delegates here; there is
exactly one implementation.

Exclusions are **counted** and surface in `retrieval.testCatalogExclusions` and
in telemetry. An exclusion nobody can count is an exclusion nobody notices has
stopped working.

This is containment, not cleanup. Removing the rows from production requires
owner approval and is still open.

---

## 5. Multi-item retrieval failure — attributed

**Cause: deliberate orchestration skip.** Not a defect in the request contract,
query generation, or response mapping.

`supabase/functions/scan-identify/index.ts:2991`:

```
} else if (useMultiItemDetectionProvider) {
  console.log('[scan-identify] commerce_skipped reason=multi_item_detection_only …');
  finalRecommendedProducts = [];
  finalSimilarityMatches  = [];
  shoppingMeta = { provider: 'none', …, commerceSkipped: true,
                   reason: 'multi_item_detection_only' };
}
```

By design: a multi-item scan detects garments for the user to **select**, and
commerce runs on the follow-up `selected_item` request. The 19/19 zero-product
rows are the design working as written.

**But the funnel is leaking, and that is the real finding:**

| request_mode | events | completed | with products | last seen |
|---|---|---|---|---|
| `multi_item_detection` | 23 | 19 | **0** | **2026-08-03** |
| `selected_item` | 11 | 10 | 8 | **2026-07-30** |

Multi-item detection is in active use *through today*. The selection step that
would actually retrieve products **has not fired in four days**. Users are
running multi-item scans and not reaching the step where products appear — so in
the observed window, a multi-item scan is a dead end for retrieval regardless of
the backend being correct.

Not fixed in this checkpoint, which is backend-only and touches no scanner UI.
The next investigation is client-side: whether the selection affordance is
discoverable, whether it survives navigation, and whether `selected_item`
requests are failing before they reach `scan_commerce_events`.

---

## 6. Deployed source drift — capture and plan

Full diffs captured at
[docs/evidence/deployed-drift-20260803/](evidence/deployed-drift-20260803/README.md),
with a six-step reconciliation plan.

Summary: three of the four drifted functions carry genuine uncommitted
fixes (a bundler-related account-guard fix in two, a credential separation in
one). The fourth, `nike-shoe-details`, had a *"do not wire into production"*
warning deleted with nothing recording who decided the upstream endpoint was
fixed — that one needs investigation before the deletion is accepted.

The release blocker is not the changes; three are improvements. It is that
**the repository is not currently a description of what is running**, so a
redeploy from a clean checkout would silently revert all four and reopen the
account-guard hole.

`product-match` does not call any of them — it reaches `kicksCrewProvider.ts`,
`farfetchProvider.ts` and `shoppingProvider.ts` inside the governed
`scan-identify` closure, verified byte-for-byte against production.

---

## 7. Results

```
deno test  supabase/functions/product-match/          119 passed, 0 failed
deno check supabase/functions/product-match/*.ts      clean
node --test __tests__/productMatchFoundation.test.js   25 passed, 0 failed
node scripts/run-backend-tests.js                     242 passed, 0 failed
node scripts/check-edge-function-parity.js            PASS
node scripts/product-match-benchmark.js               5/5 directional, exit 0
```

### Latency behaviour, measured offline

| behaviour | observed |
|---|---|
| three concurrent 120 ms providers | < 300 ms total |
| `sequentialEquivalentMs` vs `completeMs` | strictly greater — concurrency benefit is in the data |
| stage rows present, in execution order | `plan, retrieve, normalize, relevance, dedupe, tier, similarity` |
| `baselineDeltaMs` | equals `completeMs − 9200`, negative on a fast local run |
| `firstUsefulSlow` with a 1 ms threshold | `true`, and the result is still returned intact |
| identical rows at 1 ms vs 150 ms | identical tier, identical confidence |

**No production latency measurement was taken.** These are orchestration
measurements against fake providers. Nothing here verifies a target against
production, and no target is claimed — verification requires deployment, which
is not authorized.

---

## 8. Still open

**Blocking activation**, in this order (flag last — a flag reaches production
faster than a deploy): add to `GOVERNED_FUNCTIONS` → regenerate manifest →
deploy → set `PRODUCT_MATCH_ENABLED=true`. Then provider credentials,
`PRODUCT_MATCH_INTERNAL_SECRET`, and the telemetry migration with a writer.

**Release blockers:**

1. Reconcile the four drifted deployed functions (§6).
2. Remove the 14 `KSCAN_TEST` rows from production `product_catalog` — the code
   gate makes this non-urgent, not unnecessary.
3. Client-side attribution of the multi-item selection funnel leak (§5).

**Still missing:**

4. **No accuracy baseline.** Five directional cases are a regression suite. Hand
   labelling real scans against real retailer inventory remains the prerequisite
   for any claim that accuracy improved.
5. **No production latency data** for this pipeline. The stage instrumentation
   exists to collect it; nothing has collected it.
6. **Cross-platform staged result behaviour** — the design is staged, the
   transport is not. No mobile client consumes this yet.
7. **`scan-identify` does not call `/product-match`.** The endpoint is reachable
   and correct in isolation; wiring the scanner to it is a separate change.

**Not attempted, by scope:** new external providers, vector infrastructure,
image recipients, headless checkout, production exact-match claims, mobile
streaming transport.

---

## 9. Running it

```bash
node scripts/run-backend-tests.js product-match
```

```bash
node --test __tests__/productMatchFoundation.test.js
```

```bash
node scripts/product-match-benchmark.js
```
