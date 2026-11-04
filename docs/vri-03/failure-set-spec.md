# VRI-03 failure set — construction spec (Phase A, item count 0)

Status: **NOT BUILT. 0 labeled items.** Phase B is gated on this set and has not started.

## 1. Why no existing set qualifies

Searched in this session: `docs/`, `qa/`, `audit/`, `evals/`, `tools/`, every `supabase/functions/scan-identify/*fixture*`
reference, and the research branches on `origin`.

| Candidate | Location | Why it does not qualify |
|---|---|---|
| Scanner Accuracy Tier-A v0.3.1 (40 cases, 56 images) | `research/scanner-accuracy-v2-evals` → `evals/scanner-accuracy/` | Licensed Wikimedia/museum imagery for **identification** labels. No record of what Google surfaced, no purchasable product ground truth, and its `exactProductKnowable` stratum is listed as **missing** (`tier-a-manifest.v0.3.1.json`, `split.missingStrata`). Images live in external governed storage that is not mounted here (`imagesInGit: 0`). No recorded K Scan output exists. |
| Real Fashion Match Corpus V1 / V2 | `research/real-fashion-match-corpus-v1`, `research/build35-real-fashion-corpus-v2` → `tools/real-fashion-corpus/` | Infrastructure only. `corpus/cases/` holds only `.gitkeep`; status `INFRASTRUCTURE_COMPLETE_COLLECTION_IN_PROGRESS`. **0 real cases.** |
| Fashion Match Quality Lab | `research/fashion-match-quality-lab-v1` → `tools/fashion-match-quality/` | Synthetic fixture corpus and evaluator. Not real scans. |
| Canonical Product Identity lab | `tools/canonical-product-identity/corpus/fixtures/synthetic/` | Synthetic. |
| scan-identify unit fixtures | `supabase/functions/scan-identify/*.test.ts` | Hand-written synthetic product titles. They prove code paths, not match quality. |

None of these records the "Google found it, K Scan did not" condition the question depends on.

## 2. Inclusion rule (per item)

An item enters the set only if ALL hold:

1. A real scan image (camera or gallery) captured with consent under the existing image-consent policy. No public
   web screenshots of people. Faces, bystanders and backgrounds that identify a person are cropped or blurred
   *before* the image is stored.
2. On the same image, Google visual search surfaced **at least one real, purchasable product page** for the scanned
   item: in stock, product-level URL, not a search page. The reviewer records it with capture date and market.
3. K Scan returned **nothing acceptable** for that item: `no result` or `wrong category` on the taxonomy below.
4. Two reviewers agree on the label (taxonomy and strata). Disagreements go to an adjudicator; an unresolved item
   is excluded and logged.

Target **24 items** (bounds 15–30). The gate minimum is 15. 24 leaves room for exclusions and still gives ≥6 per
primary stratum.

## 3. Human match taxonomy (applied to the top-10 shelf)

| Label | Definition |
|---|---|
| `exact_match` | Same product (same brand + model/family; colourway may differ only if Google's product also differed) |
| `visually_similar_acceptable` | Different product a stylist would accept as a substitute: same category + subtype, and ≥3 of colour / material appearance / silhouette / pattern / distinctive construction agree |
| `wrong_category` | Results exist but none in the scanned category/subtype |
| `no_result` | Empty shelf, or only results failing the above |

Scoring: **hit** = best result on the shelf is `exact_match` or `visually_similar_acceptable`. Exact recall is reported
separately so a similar-match gain cannot hide an exact-match regression.

## 4. Strata (every item carries all of them)

| Dimension | Values | Target per value |
|---|---|---|
| Scene | `single_object` / `multi_object` | ≥8 each (reported `underpowered` below 8; gate needs ≥1 each) |
| Type | `garment` / `accessory` (bags, footwear, jewelry, eyewear, hats) | ≥8 each (reported `underpowered` below 8; gate needs ≥1 each) |
| Brand visibility | `brand_visible` / `brand_not_visible` | report only |
| Black-owned relevance | Google's product is from a brand in the authorized Black-owned inventory: `yes` / `no` / `unknown` | report only |

## 5. Per-stage drop-out record (one row per item)

For each item, record the **first** stage where the true product (or any acceptable product) is lost:

| # | Stage | Evidence needed to assign it |
|---|---|---|
| 1 | Attribute extraction | Sanitized + gated `identification` lacks or contradicts a visible attribute the Google product depends on (wrong category/subtype, missing construction, suppressed brand) |
| 2 | Query construction | Attributes are right, but the issued query omits or garbles the terms that retrieve the product (run the Google product title through the same provider manually as a control query) |
| 3 | Provider retrieval | A reasonable query was issued and the provider pool does not contain the product or any acceptable one |
| 4 | Filtering | Product is in the pool, removed by a rule. Name it: `missing_or_invalid_purchase_url`, `missing_image`, `malformed_price`, `category_mismatch`, `clear_category_conflict`, `weak_band_coverage_cap` (`commerceRelevanceDiversity.ts:176-197`), `pre_rank_cap_10` (`scanCommerceRouter.ts:1180`), `duplicate_identity` |
| 5 | Ranking | Survives filtering, ranks below position 10. Name the signal (title-only agreement, brand weight, diversity rerank) |
| 6 | Merchant verification | A *verified* Black-owned product exists in authorized inventory and is dropped by an eligibility/match rule in `black-owned-discovery/engine.ts:30-84`. Name the rule. (Verification rules themselves are recorded, never changed.) |
| 7 | Coverage | The product, and every acceptable substitute, is absent from every provider and the authorized inventory → H5 coverage finding |

Each row also records `catalog_coverage_limitation` vs `search_quality_defect` (stages 1–6 are search quality, 7 is
coverage).

## 6. Storage and privacy

* Image bytes are **never committed**. Store in the existing governed eval storage pattern (external root, resolved
  by environment variable) with SHA-256 digests in git, matching `evals/scanner-accuracy/` and DM-01 of the real
  fashion corpus.
* Manifests carry opaque item ids, digests, labels and strata only. No user ids, actor ids, signed URLs, EXIF
  location, filenames from devices, or faces.
* Google product evidence is recorded as retailer domain + product title + capture date, not screenshots.

## 7. Manifest shape (proposed, `failure-set.manifest.json`)

```json
{
  "setId": "vri-03-failure-set",
  "version": "0.0.0",
  "status": "NOT_BUILT",
  "itemCount": 0,
  "consentPolicy": "existing image-consent policy (reference by policy id when built)",
  "items": [
    {
      "itemId": "vri03-0001",
      "imageDigest": "sha256:<64 hex>",
      "strata": { "scene": "single_object", "type": "garment", "brandVisible": false, "blackOwnedRelevance": "unknown" },
      "googleEvidence": { "retailerDomain": "example-retailer.test", "productTitle": "…", "capturedAt": "YYYY-MM-DD", "market": "US" },
      "baseline": {
        "label": "no_result",
        "firstDropStage": 3,
        "dropDetail": "provider_pool_missing",
        "classification": "search_quality_defect"
      },
      "reviewers": 2,
      "adjudicated": false
    }
  ]
}
```

## 8. What it costs to build (owner action)

* Human time: about 2–3 minutes per item for capture + Google lookup + two labels, plus adjudication.
* Baseline run: one K Scan scan per item through **Staging**, with the instrumentation in
  [instrumentation-spec.md](instrumentation-spec.md). Each Staging scan makes billed Gemini calls (two per item on the
  two-pass flow), so the baseline itself needs a budget. See the cost estimate in the PR (section H).
