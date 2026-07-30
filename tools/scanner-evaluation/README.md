# Scanner Evaluation Tools (Build 4)

Offline, isolated evaluation harness for Scanner Accuracy & Trust V2.

**Do not import these modules from production application code, Edge Functions, or deploy scripts.**

## Commands

```bash
node tools/scanner-evaluation/validate-dataset.js evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json --dataset-version 0.1.0
node tools/scanner-evaluation/score-fields.js <labels.json> <predictions.json>
node tools/scanner-evaluation/compare-candidates.js <baseline.json> <candidate.json>
node tools/scanner-evaluation/regression-gate.js <baseline.json> <candidate.json> --mode report_only
node tools/scanner-evaluation/verify-frozen-dataset.js \
  --manifest evals/scanner-accuracy/tier-a-manifest.v0.3.0.json \
  --freeze-record evals/scanner-accuracy/tier-a-freeze.v0.3.0.json
node tools/scanner-evaluation/run-baseline.js --dry-run \
  --manifest evals/scanner-accuracy/tier-a-manifest.v0.3.0.json \
  --split development \
  --pricing-record evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json \
  --capture-preparation certified_client_equivalent \
  --output-dir <dir>
```

The frozen verifier requires `KSCAN_EVAL_STORAGE_ROOT` and verifies the four
recorded frozen inputs plus every governed image hash. `run-baseline.js` performs
the same verification before planning. Its dry run produces a **static shell
only** (empty predictions, zero model calls). Paid model evaluation requires
approved cases, explicit owner authorization, and an injected certified adapter.

### Phase 1 execution gates

`--execute` additionally requires all of the following, each of which fails
closed when absent:

| Flag | Why it is mandatory |
|---|---|
| `--max-calls <n>` | hard ceiling on **provider attempts**, not planned calls |
| `--max-usd <n>` | a call ceiling does not bound money; cost per attempt varies by model and token count |
| `--pricing-record <path>` | there is no built-in price table, because stale pricing is how a spend ceiling gets exceeded |
| `--split development\|holdout` | one run may never span both splits |
| `--capture-preparation <mode>` | governed originals are not what the production client uploads |

Optional: `--holdout-seal <path>` (**required** for `--split holdout`),
`--adapter-id`, `--certified-bundle-sha256`, `--resume`, `--start-case`,
`--case-id`.

Capture-preparation modes are `absent` (the default — nothing may execute),
`governed_original` (explicitly not production-equivalent, refused), and
`certified_client_equivalent`. The certified client resizes to 896 px wide and
re-encodes JPEG at quality 0.65 before upload, and the Edge Function rejects any
base64 payload over 2 MB before calling the provider; both constants are
re-derived from the certified source by the Phase 1 gate tests.

### Capture preparation (required before any execution)

Governed originals are **not** what the production client uploads, and 25 of the 56
frozen originals exceed the certified 2 MB base64 ceiling. Prepare derivatives
first; the runner validates the ceiling against the **derivative**, not the source.

```bash
node tools/scanner-evaluation/prepare-derivatives.js \
  --manifest evals/scanner-accuracy/tier-a-manifest.v0.3.0.json \
  --derivative-root <dir OUTSIDE every Git worktree> \
  --split development
```

Preparation is a pipeline stage, not a dataset change: frozen v0.3.0 originals are
opened read-only and no patch version is created. It writes one derivative per
source image plus a `preparation-manifest.json` recording, per image, the source
hash, derivative hash, source and derivative dimensions, the full transform
parameters and the codec versions. Pass that manifest to the runner with
`--preparation-manifest`; its hash is part of the run identity, so a resume across
a changed preparation is refused.

| Policy | Behaviour |
|---|---|
| `certified_client_width_896` (default) | width pinned to 896, height proportional — the exact production mirror, so a portrait frame exceeds 896 on its long edge |
| `max_dimension_896` | longest edge capped at 896; **differs from production** for any non-landscape source |

Requires the `sharp` devDependency. Fidelity limits are recorded in every
preparation manifest: pixel dimensions, chroma subsampling and quality band match
the certified client, but **entropy-coded bytes do not and no byte-level parity is
asserted**. Byte determinism holds for a fixed codec version only.

The runner writes its own machine-readable output: `dry-run-plan.json` for a dry
run, and `run-manifest.json` + `cases/<caseId>.json` + `baseline-report.json` for
an execution. There is no separate export command.

## Tests

```bash
node --test tools/scanner-evaluation/__tests__/*.test.js
```

Requires `KSCAN_EVAL_STORAGE_ROOT`. Set `KSCAN_CERT_V140_ROOT` as well to run the
certified-source re-derivation test rather than skipping it.
