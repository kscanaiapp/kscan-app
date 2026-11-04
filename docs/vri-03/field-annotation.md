# VRI-03 §5 — Gemini scan field annotation

Source tree: `ci/vri-03-instruction-retrieval` @ base `dd82d40d` (CI-03). Line numbers refer to that tree.
Read-only annotation; nothing here changes behavior.

## 0. Which configuration is annotated

Repository defaults (the source constants, not any deployed environment):

| Control | Source default | Where |
|---|---|---|
| Quality tune (v120) | ON | `scan-identify/qualityTuneConfig.ts:21` |
| Scanner intelligence (v121) | ON | `scan-identify/scannerIntelligenceConfig.ts:21` |
| Commerce relevance (v122) | ON | `scan-identify/commerceRelevanceConfig.ts:24` |
| Commerce identity (v124) | OFF | `scan-identify/commerceIdentityConfig.ts:30` |
| Commerce retrieval enrichment (v125) | OFF | `scan-identify/commerceRetrievalConfig.ts:32` |
| Commerce funnel (v127, deferred MODE B commerce) | ON | `scan-identify/commerceFunnelConfig.ts:33` |
| Image product mission (system instruction) | OFF | `scan-identify/scanImageProductMission.ts:14,24` |

Deployed environments may override any of these with secrets. This annotation does not describe a deployed state.

Three image request modes reach Gemini, chosen by the client request:

* `multi_item_detection` — first pass, up to 5 candidates, commerce skipped.
* `selected_item` — second pass on the candidate the client selected; its output feeds commerce.
* `legacy_single_item` — one pass on the dominant item; its output feeds commerce.

With the funnel ON, commerce runs in a follow-up commerce-only request (MODE B): the client posts the sanitized
`identification` back (`index.ts:1588-1610`), the quality gate runs again (`index.ts:2175`), and the fast path retrieves
(`scanCommerceRouter.ts:988`).

## 1. Instruction / prompt annotation

| Item | Status | Evidence (file:line) |
|---|---|---|
| Fashion-expert **system instruction** | **Absent by default.** Present only behind `SCAN_IMAGE_PRODUCT_MISSION_V1_ENABLED` (default OFF). | `system_instruction` is attached only when `imageMission` is non-null: `index.ts:2863-2868,2890`; mission text `scanImageProductMission.ts:28-70`; null when disabled `scanImageProductMission.ts:96` |
| Persona vs bare prompt | **Role statement in the user turn, not an expert persona.** "You are K Scan AI's fashion identification engine." | `index.ts:367` (legacy), `index.ts:694` (multi-item), `index.ts:916` (selected-item) |
| Few-shot examples, detail level | **Legacy only: 4 text-described examples with full JSON output** (blazer, floral dress, sneakers, non-fashion). Multi-item: one inline shape example. **Selected-item: none.** No image few-shots anywhere. | `index.ts:483-683`; `index.ts:719-736`; `index.ts:909-942` |
| Searchable-attribute guidance: silhouette | Present (legacy, one line); field requested in selected-item schema | `index.ts:379`; `index.ts:815` |
| …fabric/material appearance | Present as "material" (legacy). Speculation prohibited by quality-tune addendum. Not framed as *appearance*. | `index.ts:379`; `index.ts:184`; mission (OFF) says "material appearance" `scanImageProductMission.ts:44-46` |
| …construction | Present (legacy "distinctive construction details"); **selected-item schema has no `distinctive_features` unless v124 (OFF)** | `index.ts:379`; `index.ts:806-833` vs `index.ts:865` |
| …pattern | Present | `index.ts:379`; `index.ts:813` |
| …era / style | **Absent** (only `style_tags`, no era/decade guidance); `vintage` is actively filtered as filler | `index.ts:415`; `commerceRelevanceQueries.ts:72` |
| Synonym generation | **Absent.** No instruction asks for alternate garment names (e.g. moto/biker, trainer/sneaker). The legacy `search_queries` (3 phrasings) is the closest thing and it is discarded (§2). | `index.ts:421,470-474` |
| Exact vs similar intent | **Absent by default.** Mission (OFF) has "EXACT ORIGINAL ITEM FIRST / SIMILAR MATCHES NEXT"; v124 (OFF) adds `exact_item_hypothesis`. | `scanImageProductMission.ts:33-46`; `index.ts:874-907` |
| Structured attributes vs category string | **Structured** (item_type, subtype, color, material, silhouette, fit, …) plus legacy `attributes` object | `index.ts:400-424`; `index.ts:789-839` |
| Per-attribute confidence | **Absent.** One global `confidence_score`; `logo_confidence` only for logo. v124 (OFF) adds `brand_confidence`, `exact_match_confidence`. Colour/material certainty is *derived deterministically*, not emitted. | `index.ts:823,822`; `index.ts:862-864`; `commerceRelevanceQueries.ts:351-361` |
| Multi-object | **Present** as a separate first-pass call (1-5 items, deterministic order, bounds). Legacy mode forces one dominant item. | `index.ts:694-741,743-787`; `index.ts:377,384` |
| Brand / logo only when visible | **Present** (prompt + quality-tune addendum + quality gate suppression) | `index.ts:380`; `index.ts:185`; `index.ts:926-927`; `scannerQualityGate.ts:576-601,691-718` |
| Material uncertainty | **Partially present:** "use null/unknown" rule; speculative materials suppressed downstream. No explicit "material appearance vs fibre" uncertainty field. | `index.ts:687`; `scannerQualityGate.ts:605-616` |
| Synonyms (output field) | **Absent** | — |

## 2. Every Gemini output field: used / discarded / partially used

"Retrieval" means the text that reaches a provider query. "Rank" means `scoreProductAgreement` / filters. The default
commerce query on the shipped path is built by `buildCategoryCommerceQueries` (`commerceRelevanceQueries.ts:346`),
reached through `buildWeightedCommerceQueries` → `relevanceRoute` branch (`qualityTuneCommerce.ts:191-204`) from
`resolveCommerceQueries` (`scanCommerceRouter.ts:805-867`).

### 2a. `identification.*` (legacy + selected-item)

| Field | Emitted by (legacy / selected-item schema) | Status on default commerce path | Where consumed or not |
|---|---|---|---|
| `visual_observation` | yes / yes (required) | **Partially used** — display + verbosity penalty only; never retrieval or rank | `scannerQualityGate.ts:675-680` |
| `item_type` | yes / yes (required) | **Used** — category template route, query garment term when no subtype, category filter, agreement category score, Black-owned category equality | `commerceRelevanceQueries.ts:370,390`; `qualityTuneCommerce.ts:519-521,454-475`; `commerceRelevanceAgreement.ts:23`; `black-owned-discovery/engine.ts:36` |
| `subtype` | yes / yes (required) | **Used** — primary garment term in every template; agreement subtype score; Black-owned head-noun match | `commerceRelevanceQueries.ts:369,384,399,415,430`; `commerceRelevanceAgreement.ts:24`; `black-owned-discovery/engine.ts:45-46` |
| `primary_color` | yes / yes (required) | **Used** — colour terms (certainty-gated), agreement colour score | `commerceRelevanceQueries.ts:351-365`; `commerceRelevanceAgreement.ts:25` |
| `secondary_colors` | yes / **not in schema** | **Discarded** for retrieval/rank on default path (only v120 QT-off builder reads `[0]`) | `scanCommerceRouter.ts:468` (QT-off only) |
| `pattern` | yes / yes | **Partially used** — accessories template only; agreement pattern/detail score | `commerceRelevanceQueries.ts:372,433`; `commerceRelevanceAgreement.ts:28` |
| `material_estimate` | yes / yes | **Used, gated** — suppressed at low/moderate band or when speculative | `commerceRelevanceQueries.ts:357-367`; `scannerQualityGate.ts:605-616,697-717` |
| `silhouette` | yes / yes | **Partially used** — apparel template (unless oversized/minimalist), bag shape; agreement silhouette score | `commerceRelevanceQueries.ts:385,408-413`; `commerceRelevanceAgreement.ts:27` |
| `fit` | yes / yes | **Partially used** — apparel only and only if it matches `cropped|wide-leg|slim|relaxed` | `commerceRelevanceQueries.ts:379,388` |
| `length` | yes / **not in schema** | **Partially used (legacy only)** — apparel, only `cropped|midi|maxi|mini`; never emitted on selected-item | `commerceRelevanceQueries.ts:380,389` |
| `sleeve_length` | yes / not in schema | **Discarded** — explicitly excluded from footwear/bag; never used in apparel | `commerceRelevanceQueries.ts:77-79` |
| `neckline_or_lapel` | yes / not in schema | **Discarded** | `commerceRelevanceQueries.ts:77-79` |
| `closure` | yes / not in schema | **Discarded** on default path (v125 OFF) | — |
| `distinctive_features` | yes / **not in schema (v124 only)** | **Partially used** — `[0]` only, footwear toe/heel regex heuristics; internal-catalog similarity tags; Black-owned evidence title is built from *catalog* features, not these | `commerceRelevanceQueries.ts:176,192`; `similarityMatcher.ts:126`; v125 path (OFF) `commerceRelevanceQueries.ts:466` |
| `style_tags` | yes / not in schema (v124 only) | **Discarded** for retrieval/rank on default path; trimmed by gate; internal-catalog similarity tags | `scannerQualityGate.ts:618-630`; `similarityMatcher.ts:122` |
| `occasion_tags` | yes / not in schema | **Discarded** (display pass-through only) | allowlist `index.ts:277` |
| `visible_brand_text` | yes / yes | **Used as evidence** — brand verification input; brand reaches query only when verified | `brandEvidence.ts`; `commerceRelevanceQueries.ts:226-230,513` |
| `logo_detected` | yes / yes | **Used as evidence** (brand verification) | `scannerQualityGate.ts` / `brandEvidence.ts` |
| `brand_guess` | yes / yes | **Partially used** — nulled unless supported (`scannerQualityGate.ts:576-601,691-718`); verified brand prefixes the query (`commerceRelevanceQueries.ts:512-513`); agreement +5 (`commerceRelevanceAgreement.ts:29`) | |
| `logo_brand`, `logo_description`, `logo_confidence` | no / yes | **Used as evidence** (brand verification only) | `brandEvidence.ts`; `scannerQualityGate.ts:576-578` |
| `confidence_score` | yes / yes (required) | **Partially used** — telemetry and client display; **not** an input to the quality band, query detail level, or ranking | `scanIntelligenceCapture.ts:92`; `_shared/scanHelpers.ts:302-303,353`; band computed from attributes `scannerQualityGate.ts:632-688` |
| `search_queries` | yes (3 phrasings) / not in schema | **Discarded.** Overwritten by the quality gate with one label (`scannerQualityGate.ts:722-727`) and the category-template path never reads it. Only the QT-off builder and the v120 non-relevance path read it. | `scannerQualityGate.ts:722-727`; `scanCommerceRouter.ts:447-453` (QT-off); `qualityTuneCommerce.ts:256-281` (unreached when relevance ON) |
| `non_fashion` | yes / yes (required) | **Used** — short-circuits commerce | `scanCommerceRouter.ts:392`, fast path `scanCommerceRouter.ts:1012-1017` |
| `styling_suggestions` | yes / not in schema | **Discarded** for commerce (display only) | allowlist `index.ts:279` |
| `scan_quality_note` | yes / not in schema | **Discarded** for commerce (display only) | allowlist `index.ts:271` |
| `brand_confidence`, `exact_item_hypothesis`, `exact_match_confidence` | no / v124 only (OFF) | **Not emitted on default path**; when v124 ON: ranking evidence; when v125 ON: query strategy | `index.ts:862-864`; `commerceRelevanceQueries.ts:316-341` |

### 2b. `attributes.*` (legacy contract)

| Field | Status | Where |
|---|---|---|
| `category`, `itemType` | **Used** as fallbacks for `item_type` / `subtype`; overwritten by gate sync | `commerceRelevanceQueries.ts:369-370`; `scannerQualityGate.ts:730-741` |
| `colorPalette[0]` | **Used** as colour fallback | `commerceRelevanceQueries.ts:353-355` |
| `materialEstimate` | **Used** as material fallback | `commerceRelevanceQueries.ts:360` |
| `silhouette`, `pattern` | **Used** as fallbacks | `commerceRelevanceQueries.ts:371-372` |
| `texture`, `occasion`, `styleTags` | **Discarded** for commerce (sanitized and returned) | allowlist `index.ts:241-250` |
| `confidenceScore` | Display / telemetry only | `_shared/fashionIdentificationV2.ts:669` |
| `attributes.color`, `attributes.material`, `attributes.brand` | **Dead reads** — query builders read them, but `sanitizeAttributes` never emits these keys | reads `commerceRelevanceQueries.ts:352,360`, `scanCommerceRouter.ts:458,466,471`; allowlist `index.ts:241-250` |

### 2c. `multi_item_detection` output

| Field | Status | Where |
|---|---|---|
| `detectedGarments[].label/category/subtype/item_type/primary_color/visual_observation` | **Used** — candidate chips; category/subtype seed the selected-item prompt and route | `multiItemGarments.ts:188-202`; `index.ts:909-918,2818-2831` |
| `bounds` | **Used** — selected-item prompt locates the garment | `index.ts:913,919` |
| `confidenceScore` | Display / ordering only | `multiItemGarments.ts:188,202` |
| (commerce) | **Skipped by design** on this pass | `index.ts:740` (prompt), commerce-skipped meta |

## 3. What this means for the question

The instruction already asks for most of the searchable attributes, but **the default path throws away the parts
most useful to retrieval**:

1. Gemini's own `search_queries` never reach a provider (`scannerQualityGate.ts:722-727`).
2. On the shipped two-pass flow, the selected-item response schema *cannot* carry `distinctive_features`,
   `style_tags`, `length`, `closure`, `neckline_or_lapel`, `secondary_colors` or `search_queries` unless v124 is ON
   (`index.ts:806-833`). The apparel template's `length` slot is therefore always empty there.
3. No synonym or alternate-name generation exists, and only ONE query is issued on the fast path. The computed
   fallback query is never sent (`scanCommerceRouter.ts:1191` hard-codes `fallbackUsed: false`).
4. `confidence_score` does not inform query specificity; the band is derived from attribute presence.

These are hypotheses for H1–H3, not measured causes. Section C of the PR explains why they could not be measured.
