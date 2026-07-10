# Real-Scan Feedback Template v1

Use one block per real-device scan when validating match quality on App Staging
(Android v15 / iOS build 6 dev build, Metro or installed build). Copy the block,
fill it in, and keep notes in this file or a sibling. This is for catching
wrong-category leakage, color mismatches, and empty-state behavior with real
photos against the sparse staging catalog.

---

## Per-scan block

```
scan label:
expected category:
actual category:
expected item type:
actual item type:
expected color:
actual color:
ProductShelf shown: YES/NO
first product category:
first product name:
first product color:
wrong-category result: YES/NO
confidence label:
scan_quality_note:
screenshot captured: YES/NO
raw photo retained: NO
notes:
```

---

## How to read the results

- **wrong-category result = YES** is the most important failure to report: the
  shelf showed a product from a different category than the scanned item. With
  exact category isolation active, this should be NO. If it is YES, capture the
  scan label, the actual vs expected category, and the first product.
- **ProductShelf shown = NO** is expected and correct for: non-fashion items,
  unknown/very-low-confidence scans, and any category with zero catalog rows
  (e.g. `pants`, `top`, or `blazer` if unseeded). Note which case applies.
- **first product color** vs **actual color**: a mismatch here is a *sorting*
  observation, not a leakage bug — the catalog is sparse and may not have the
  scanned color in that category.
- **confidence label** (High/Medium/Low) and **scan_quality_note** (blurry/dark/
  far/partial) should be consistent — a quality note should never read as High.

---

## Privacy guidance (Zero-Knowledge Architecture)

- **raw photo retained: NO** — always. Do not upload raw user/scan photos into
  git or any shared location.
- Do **not** upload raw face-containing scans. If a screenshot contains a face,
  **crop or obfuscate** it before attaching.
- Do **not** paste raw base64 / image payloads into feedback.
- Do **not** capture license plates, bystanders, or other people's PII.
- Screenshots should show the **result UI** (AnalysisCard + ProductShelf), not
  the raw camera frame, wherever possible.

This aligns with K Scan's Zero-Knowledge Architecture and on-device PII masking
position: feedback records *outcomes and labels*, never raw imagery or PII.
