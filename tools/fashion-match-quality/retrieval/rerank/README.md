# FashionCLIP visual re-ranker (R&D)

**R&D only. Not wired into any production path. Do not deploy.**

A downstream visual re-ranking layer over K Scan's existing L1 candidate
generation. L1 still decides *which* products are candidates; this layer only
decides *what order* they appear in.

```
SCAN / IDENTIFICATION
  -> EXISTING K SCAN L1              (unchanged — produces the candidate set)
  -> RETAILER CANDIDATES             (exact set, nothing added or removed)
  -> FASHIONCLIP VISUAL RE-RANKING   (reorders that set only)
  -> IMPROVED PRODUCT ORDER
```

Builds on the retrieval lab in `../` (PR #402), reusing its model manifest,
adapter, cache and cosine index rather than duplicating them.

## Run it

```bash
# the paired experiment + report
node tools/fashion-match-quality/retrieval/rerank/runRerankExperiment.js

# the whole lab's tests (retrieval + re-rank)
node tools/fashion-match-quality/retrieval/run-tests.js
```

The control arm executes the **real production L1 module** via Deno. Without
`deno` on PATH the control arm is blocked and the integration tests skip
honestly rather than substituting a fake baseline. To provide it without
touching the repo:

```bash
npm install --prefix /tmp/deno @deno/linux-x64-glibc
export PATH="/tmp/deno/node_modules/@deno/linux-x64-glibc:$PATH"
```

## Modules

| File | Role |
|---|---|
| `visualReranker.js` | The re-ranker. Same set in, permutation out, stable deterministic sort. |
| `candidateUniverse.js` | Order-independent candidate-set fingerprint; proves both arms saw one universe. |
| `executionIdentity.js` | Five separate observations behind `REAL_FASHIONCLIP_EXECUTED`; the stub/real guard. |
| `rerankExperiment.js` | The paired control-vs-challenger run, plus the degraded-order mechanism probe. |
| `runRerankExperiment.js` | Orchestrator; emits `reports/latest.json`, validated before it is written. |
| `rerankReportSchema.js` | Makes an overclaiming report structurally impossible. |
| `attributeImageSource.js` | Deterministic placeholder PNGs rendered from recorded attributes. **Not photographs.** |
| `visualDescriptorProbe.js` | Zero-parameter image descriptor. **Not a model, not FashionCLIP.** |
| `HYPOTHESIS.md` | Recorded before any result existed. |
| `DESIGN.md` | Decision record RR-01 … RR-12. |

## What this run did and did not establish

| | |
|---|---|
| `REAL_FASHIONCLIP_EXECUTED` | **NO** — `huggingface.co` is policy-blocked (403 CONNECT) in this environment, so the pinned weights could not load. |
| Control arm | **Real production L1**, executing unmodified. |
| Candidate universe | Identical across arms on every case (hashes match). |
| Control vs challenger | **All metrics tie** — the control already scores perfectly, so there is no headroom to improve on. |
| Mechanism | From a deliberately reversed ordering, the re-ranker recovers the correct product 2 ranks in 10/10 cases. `MECHANISM_CHECK`, not quality evidence. |
| `COLOR_METRIC` | `REPAIRED_AND_DISCRIMINATIVE` (was a constant `1.0` — see DESIGN RR-06). |
| Conclusion | `ENVIRONMENT_BLOCKED` — derived in code, not authored. |

Nothing in this directory may be read as evidence about FashionCLIP's ranking
quality. FashionCLIP did not run.
