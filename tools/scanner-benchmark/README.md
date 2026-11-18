# Scanner benchmark (Build 42)

Offline, reproducible evaluation set and scorer for the Scanner accuracy and confidence engine.
Research tooling: nothing here is imported by the app or by any Edge Function, and nothing here
calls a paid provider.

## Layout

| Path | Purpose |
|---|---|
| `manifest/cases.v1.json` | Benchmark cases: provenance, licence, attribution, SHA-256, split, stratum, labels, label sources |
| `manifest/curation.v1.json` | Every Commons candidate considered and why it was kept or rejected |
| `lib/manifest.mjs` | Manifest contract and validator |
| `lib/destination.mjs` | Merchant-link classifier (independent of `scan-identify`) |
| `lib/judge.mjs` | Deterministic title judges: exact product, alternative grade, brand claim, category |
| `lib/metrics.mjs` | Metrics: exact-match precision, false exact-match rate, probable precision, exact-product recall@k, alternative relevance, merchant-link validity, actionable latency, identification, provider cost |
| `adapters/archivedLiveCertification.mjs` | Scores archived Build 35 live-certification reports with the same metrics |
| `scripts/fetch-assets.mjs` | Re-downloads source images to a folder **outside** the repo and verifies SHA-256 |
| `scripts/derive-variants.py` | Deterministic difficult-condition variants (low light, blur, occlusion, rotation, compression, overexposure) |
| `scripts/score-archived.mjs` | CLI for the archived adapter |
| `scripts/plan-live-run.mjs` | Request, quota and cost projection for a live Staging run (prints a plan; executes nothing) |

Tests: `__tests__/scannerBenchmark/` (run by `scripts/run-all-tests.js`).

## Reproduce the image set

```
node tools/scanner-benchmark/scripts/fetch-assets.mjs <asset-root-outside-repo>
python -I tools/scanner-benchmark/scripts/derive-variants.py <asset-root-outside-repo> tools/scanner-benchmark/manifest/cases.v1.json
```

Images are Wikimedia Commons files under CC0, public domain, CC BY or CC BY-SA (NonCommercial,
NoDerivatives and unrecognised licences are rejected). They are fetched as standard-size
thumbnails, never committed, and each case records author, licence, file page and SHA-256 for
attribution. The fetcher is rate-limited (one request per 8 s) and stops on sustained HTTP 429.

## Labels and their independence

* **Source-derived (independent of K Scan):** product identity for `exact_known` cases comes
  from the Commons category the file is filed under (e.g. *Category:Casio F-91W*) and its
  title/description, written by Commons contributors.
* **Agent-annotated (pending human review):** visual confirmation that the subject matches the
  source label, primary colour, legibility of brand text, and multi-item garment lists were
  annotated by the authoring agent from contact sheets. These fields are marked
  `agent_visual_review` in `labelSources` and must receive an independent human pass before the
  holdout split is used for any claim.
* Derived cases inherit their parent's labels unchanged; the transform never changes labels.

## Judge limitations

Offers are judged from title, brand field and destination only. "Exact product" means the
listing names the labelled brand and every token of a labelled model alias; it does not verify
colourway or the listing photo. Alternative relevance grades are title-based. Reports always
state these limits next to the numbers.

## Score archived evidence

```
node tools/scanner-benchmark/scripts/score-archived.mjs docs/build35/scanner/evidence/P1-report.json security/release/scanner-live-certification/corpus.json P1
```

(Paths are on the mobile integration line, where that evidence is committed.)
