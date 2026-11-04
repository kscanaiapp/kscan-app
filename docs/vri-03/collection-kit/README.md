# VRI-03 collection kit (owner action)

The benchmark cannot start until a human supplies real scans and what Google surfaced for them. Claude cannot invent
either, and the gate (`supabase/functions/_shared/vri03/benchmark/manifestGate.ts`) rejects items without them.

## What to collect: 15–30 items, target 24

For each item:

1. **Capture** one real scan photo (camera or gallery) of a fashion item. The subject consents under the existing
   image-consent policy. Record an opaque consent evidence id. Never use a name or email.
2. **Strip identifiers before storing:** crop or blur faces, bystanders, screens, house numbers and plates; remove
   EXIF (location, device). Store the image only in governed eval storage outside git. Compute its SHA-256.
3. **Google lookup:** run Google visual search (Lens) on the same stored image. Keep the item only if Google shows a
   **real, in-stock, product-level page** for the target item, not a search page. Record the retailer domain, the
   product title as written on the page, the date and the market.
4. **K Scan check:** keep the item only if K Scan returned nothing acceptable for it (no result, or wrong category).
   Do this through the normal app. Do not run extra scans for it.
5. **Strata:** single- or multi-object scene, garment or accessory, brand visible or not, and whether Google's
   product is from a brand in the authorized Black-owned inventory (yes / no / unknown). For multi-object scenes,
   write which item is the target ("the red bag, lower left").
6. **Two reviewers** confirm category, subtype and strata. Disagreements are adjudicated, or the item is dropped.

Aim for at least 8 single-object, 8 multi-object, 8 garment and 8 accessory items. The gate accepts fewer per
stratum but reports them as `underpowered`.

## Files

| File | Use |
|---|---|
| `intake.csv` | One row per item while collecting (spreadsheet-friendly) |
| `failure-set.manifest.template.json` | The manifest shape the gate validates; `items[]` is filled from the intake sheet |
| `results-labeling.csv` | After each benchmark arm, two reviewers label every retrieved candidate and shown result: `exact_match`, `visually_similar_acceptable`, `wrong_category` or `no_result` |

## Must not appear anywhere in the manifest

Names, emails, user, actor or device ids, file paths, EXIF or GPS, signed URLs, image bytes, faces. The gate fails
on identifier-shaped keys and values, so a passing manifest is safe to commit.

## What the operator also needs before the first billed call

These are checked by `preflight.ts`. Each missing item is a stop condition:

* A **Staging-scoped Gemini key** available to the operator environment and attested as Staging. It is never committed.
* The Production project ref supplied locally as a **forbidden** ref, so the run refuses it.
* A **dedicated test actor** with a consent evidence id.
* The governed image root mounted.
* The owner's spend confirmation given **directly in the operator session**.
* The ledger file carried between runs, so the $20 ceiling is global across all VRI-03 benchmarking.

Serper and Poshmark calls are counted exactly. Their cost stays **INSUFFICIENT EVIDENCE** until per-query prices are
supplied.
