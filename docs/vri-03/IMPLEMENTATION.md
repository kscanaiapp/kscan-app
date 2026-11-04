# VRI-03 implementation (ADDENDUM 04, build-first)

Build status is separate from effectiveness. **Customer-tested effectiveness: NOT MEASURED.** No real-product retrieval
improvement is claimed. Every change is behind its own default-OFF sub-flag. Nothing is deployed, enabled or merged.

## Flags

`vri-03-scan-improvements`, resolved once per request at each entry point by
`supabase/functions/_shared/vri03/scanImprovementsFlag.ts`. A change is effective only when the master switch is on,
the caller is in the cohort and its sub-flag is on. Cohorting uses the verified, non-anonymous user id. Anything
malformed fails closed.

| Env | Change |
|---|---|
| `VRI03_SCAN_IMPROVEMENTS_ENABLED`, `VRI03_SCAN_IMPROVEMENTS_COHORT_PERCENT` | master switch and cohort size (0–100) |
| `VRI03_H1_INSTRUCTION_ENABLED` | H1 |
| `VRI03_H2_SCHEMA_PARSER_ENABLED` | H2 |
| `VRI03_H3_QUERY_NORMALIZATION_ENABLED` | H3 |
| `VRI03_H4_FILTER_RERANK_ENABLED` | H4 |
| `VRI03_H4B_BLACK_OWNED_MATCH_ENABLED` | H4b |

## What changed

| | Change | Where | Defect addressed (§5 / C) |
|---|---|---|---|
| H1 | Searchable-attribute instruction appended to the existing image prompts (legacy single item, multi-item detection, selected item). It covers target selection, subtype, colours, silhouette, texture/material *appearance*, construction, brand only when visibly confirmed, distinctive features, and 2–3 retail search phrasings including an alternate garment name. The base prompt constants are untouched and remain the fallback. TextScan is unchanged. | `scan-identify/vri03ScanImprovements.ts` `withVri03Instruction`; `index.ts` prompt assembly | No expert attribute guidance, no synonyms, no exact/similar framing on the default path |
| H2 | The selected-item `responseSchema` gains optional `secondary_colors`, `length`, `closure`, `distinctive_features`, `style_tags`, `search_queries`. `required` is unchanged and existing (v124) definitions win. Every field is already on the server sanitizer *and* the client allowlist, so no parser or mobile change is needed. | `withVri03SelectedItemSchema`; `index.ts` generationConfig | The shipped two-pass flow could not emit these fields at all |
| H3a | The quality gate keeps its concise label as `search_queries[0]` and appends up to 2 of Gemini's own phrasings. A phrasing is dropped if it names any brand the gate did not verify, if it uses luxury/dupe filler, or if it is longer than 8 words. | `scannerQualityGate.ts` (`vri03PreserveModelQueries`) | Gemini's `search_queries` were overwritten |
| H3b | Deterministic garment-synonym rewrite (moto↔biker, trainers↔sneakers, jumper/pullover→sweater, trousers/slacks→pants …) | `synonymVariantQuery` | Synonyms discarded |
| H3c | Fast path: on a thin shelf (fewer than 3 valid products) with at least 700 ms left of the **existing** 3 s deadline, send **exactly one** fallback query to the primary shopping provider. The query is chosen in this order: model phrasing, synonym rewrite, computed v122 fallback. | `scanCommerceRouter.ts` `getFastCommerceResults` | Fast path computed a fallback and never sent it |
| H4 | Fast path scores the whole bounded pool (≤ Serper 8 + Poshmark 10) **before** truncating to 10, instead of cutting in provider order first | `getFastCommerceResults` | Poshmark candidates were cut before ranking |
| H4b | Black-owned discovery fetches and matches synonym subtype keys (moto jacket ↔ biker jacket, trainer ↔ sneaker …), bounded at 6 indexed lookups (was 4). A different head noun still never matches. Eligibility, verification windows, freshness, markets, approved domains, attribute agreement, the ≥75 threshold and ownership labels are **unchanged**. | `black-owned-discovery/{validation,engine,handler,index,contracts}.ts` | Exact-subtype SQL match missed synonym-named verified inventory |

Cache isolation: a cohort request never reads or writes a non-cohort shelf. The fast-path cache key gets a
`|vri03:HH` suffix, and the Black-owned cache key gets a `vri03` element; both keys are unchanged when the flags are off.

## Integrity

* **No fabricated products.** H1/H2 ask Gemini for attributes only; the instruction never asks for products or prices.
  Every shown product still comes from a provider response or a catalog row. The tests assert that every output URL
  was returned by the stubbed provider.
* **No ownership-label change.** `ownershipFor` and every eligibility check in `engine.ts` are untouched. Tests show
  that expired, stale, wrong-market, unapproved-link and weak rows stay excluded with H4b on.
* **No brand fabrication.** Preserved phrasings that name a suppressed brand are dropped; the test case is
  "Gucci black moto jacket".

## Cost and latency implications (estimates, unmeasured)

| Change | Gemini calls | Provider calls | Estimated effect |
|---|---|---|---|
| H1 | +0 | +0 | About +300 input tokens on the selected-item call and about +60 on detection: ≈ +$0.0005 per scan at $1.50/M. |
| H2 | +0 | +0 | About +60–150 output tokens on the selected-item call: ≈ +$0.0005–$0.0011 per scan at $7.50/M, and longer generation time. **H1+H2 together may exceed the +5% cost and latency targets.** Measure with the cohort log before widening; keep OFF if they do. |
| H3 | +0 | **≤ +1 Serper**, only on thin shelves | No added wall-clock beyond the existing 3 s fast-path deadline. Provider cost: INSUFFICIENT EVIDENCE (no prices supplied). |
| H4 | +0 | +0 | Scores ≤ 18 items instead of 10; negligible CPU |
| H4b | +0 | +0 paid; ≤ +2 indexed DB lookups | Inside the existing 1.2 s discovery timeout |

## Instrumentation (cohort only, counts only)

* `[scan-identify] vri03_gemini_usage`: request mode, model, attempts, prompt/output/thinking **token counts** from
  the response already in hand, elapsed time, and H1/H2 state. This makes cost per scan measurable for the cohort.
* `[scan-identify] vri03_commerce`: H3/H4 state, shelf size, provider call count, whether the fallback was used, pool
  size before filtering, commerce-only duration.
* `[scan-identify] vri03_fallback`: fallback source (model_query / synonym / computed_fallback), result count, shelf
  size, duration.

No query text, product titles, images or user ids are logged. Engagement and no-match frequency are already
captured by the existing `scan_commerce_events` and client analytics. No new table or migration was added.

## Not done / blockers

* Effectiveness is unmeasured. That needs a Staging deploy under separate release authorization, a cohort, and
  customer testing.
* The Gemini schema/prompt changes have not been exercised against the live model. Tests cover shape, flag-off
  identity and integrity, not model quality.
* Preserving the weak-band "plausible exact" candidates in `selectByAgreementCoverage` was not changed: no evidence yet.
