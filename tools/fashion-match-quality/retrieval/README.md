# FashionCLIP Retrieval Lab (V1)

**BENCHMARK STATUS: INTERNAL R&D ENGINEERING EVIDENCE ONLY. Metrics in this
package's reports are HARNESS / FIXTURE EVIDENCE against FMQ's constructed
synthetic corpus, never REAL-WORLD QUALITY PROOF — see any report's
`limitations` array and its `realWorldEfficacyDecision` field.**

Build 35 Fashion Intelligence R&D — Workstream 03. A pinned, reproducible
retrieval experiment: does image embedding similarity from the public
`patrickjohncyh/fashion-clip` model retrieve fashion-consistent product
candidates, compared against K Scan's existing production-identical ranking
path — both scored by the same, unmodified Fashion Match Quality evaluator.
See `NOTICE.md` for model provenance and `DESIGN.md`'s Workstream 03
addendum for the full set of design decisions.

## Quickstart

```bash
# Run the full evaluation (builds the index, runs both arms, produces the report)
node tools/fashion-match-quality/retrieval/runEvaluation.js

# Tests
node tools/fashion-match-quality/retrieval/run-tests.js
```

## What this session's environment can and cannot prove

This package was built and tested in a sandbox whose egress proxy
**explicitly policy-denies `huggingface.co`** (confirmed via the proxy's own
`/__agentproxy/status`: `connect_rejected` / "policy denial") and whose
`deno` binary is not on PATH (the same pre-existing condition behind FMQ's
own `l1/runL1.test.js` "4 skip" results). Concretely, in **this** session:

| Component | Status here | Why |
|---|---|---|
| `fashionClipAdapter.js` (real model) | `FASHIONCLIP_UNAVAILABLE` | huggingface.co network-blocked, torch/transformers not installed |
| `controlArm.js` (real L1 ranker) | `DENO_UNAVAILABLE` | `deno` not on PATH — the exact condition FMQ's own tests already report |
| Everything else (cache, index, evaluator, query modes, report, both negative controls) | **fully real and tested** | no external dependency |

Both blockers are reported honestly in every evaluation report's
`limitations` field and `metrics.controlBlocked`/`modelProvider` — the
package never silently substitutes a fake result for a blocked one, and
never hides one blocker while showing the other. See `fashionClipAdapter.js`
and `controlArm.js` headers.

To exercise the real model instead of `harnessStubEmbedder.js`, run this
package from an environment where `huggingface.co` is reachable and
`pip install torch transformers` succeeds — no code change is required;
`selectEmbedder()` in `buildIndex.js` picks the real model automatically the
moment `fashionClipAdapter.isFashionClipAvailable()` returns true.

## Architecture

```
tools/fashion-match-quality/retrieval/
  modelManifest.js         model id/revision/license/dims, image+text preprocessing spec
  fashionClipAdapter.js/.py  real FashionCLIP inference (Python subprocess, Deno-pattern gating)
  harnessStubEmbedder.js   deterministic, clearly-labeled NON-FashionCLIP stand-in
  syntheticImageSource.js  deterministic placeholder PNGs (reuses real-fashion-corpus's PNG generator)
  embeddingCache.js        content-hash + model-revision + preprocessing-version keyed cache
  vectorIndex.js           local brute-force cosine index, stable Top-K tie-break
  buildIndex.js            builds the R&D index from FMQ's fixture universe + RFC V2 manifest binding
  queryModes.js            image->image (primary) and text->image (canonical ontology terms only)
  controlArm.js            wraps FMQ's own L1 ranker unmodified
  retrievalEvaluator.js    scores both arms via FMQ's own identity/substitute/duplicate functions
  runEvaluation.js         orchestrates everything into one evaluation report
  reportSchema.js          structural validator for that report
  cache/                   gitignored embedding cache (never committed)
  tests/
```

## Design decisions

See `DESIGN.md`'s Workstream 03 addendum for the full decision-memo
record (model network-block handling, stub-embedder honesty contract, why
`wrongSubtypeRate` is unavailable, the pre-existing FMQ fixture `color_family`
quirk, and the Curiosity Gap integration choice).
