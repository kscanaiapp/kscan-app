# Baseline Contract — Scanner Accuracy V2 Phase 0A

## Purpose

Every future claim of Scanner improvement must cite:

1. fixed dataset version;
2. fixed source SHA / function tree hashes;
3. fixed scoring contract version;
4. reproducible experiment metadata;
5. regression comparison against an authoritative baseline.

## Authoritative production baseline identity

| Field | Value | Evidence class |
|-------|-------|----------------|
| Deployed function | `scan-identify` | measured |
| Deployed version | `140` | measured via Supabase CLI list |
| Project ref | `wyyuqfdxucjksghsmhry` | measured |
| Research isolation SHA | `4b36878798d16b925e163aae5ed7ed1e0b896198` | statically verified |
| Local scan-identify tree | `1e6ec21160ec3bc9c3f834ba59677acb6e3c9e2c` | statically verified |
| Shared contract blob | `1e8acdd4ebf3b6de480352c23d06597ded6ee44d` | statically verified |
| Model allowlist | `gemini-3.6-flash` / `gemini-3.5-flash-lite` | statically verified |
| Paid measured metrics | **not yet authorized** | — |

A static harness shell (`tools/scanner-evaluation/run-baseline.js`) may emit zero-call experiment metadata. That shell is **not** an authoritative accuracy baseline.

## Dataset contract

- Schema: `evals/scanner-accuracy/dataset-manifest.schema.json`
- Version file: `evals/scanner-accuracy/dataset-version.json` (`0.1.0`)
- Seed cases: 8 approved QA fixture references
- Uncertainty tokens required when evidence is insufficient: `unknown`, `not_visible`, `not_applicable`
- Expected result types: `likely_exact_match` | `closest_matches` | `identified_style` | `insufficient_evidence`

## Scoring contract

Accuracy is multi-metric, never a single number. See `metric-definitions.md`.

Wrong certainty receives a stronger penalty than honest uncertainty.

## Reproducibility contract

Experiment records must include all fields listed in `tools/scanner-evaluation/lib/experimentMeta.js`.
Missing source/dataset/pipeline/model/schema versioning → **invalid**.

## Regression gate

- Categories defined in `tools/scanner-evaluation/lib/compareCandidates.js`
- Default mode: `report_only`
- Blocking numeric thresholds: intentionally unset until measured baseline exists
- Not connected to production deployment

## Non-goals for Phase 0A

- No production prompt rewrite
- No production schema change
- No paid model baseline without owner authorization
- No Build 3 Dressing Room / Elise edits
