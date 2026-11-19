# Build 42 Sprint 1 — Prioritized PR plan

Constraints honoured by every item: no paywall or subscription-product change, no Production
deployment, no protected-branch write, no store release, no EAS build. Backend PRs target
`rebuild/backend-authority-v2`; mobile PRs target the integration line. Each runtime change is
flag-gated, default OFF, with an env rollback.

| # | PR | Scope | Fixes | Tests | Cross-platform impact | Gate to merge |
|---|---|---|---|---|---|---|
| 1 | **Scanner match confidence v1** — branch `repair/b42-scanner-match-confidence-v1` (built, local) | backend: `scan-identify/matchConfidence.ts`, `matchConfidenceConfig.ts`, 2 wiring points + 1 log helper in `index.ts`, manifests | B42-SCAN-03, -06; makes -01/-02 measurable | 15 Deno tests incl. the real serve handler (MODE B, flag OFF byte-identical / ON additive), 6 mutation controls all caught; full scan-identify suite 483/0; `deno check`; edge-parity + authority verifiers PASS | Flag OFF (default): none. Flag ON: additive `matchConfidence` on each offer; current iOS/Android builds pass it through untouched (`commerceHydration.normalizeProducts`) and render nothing new; saved Recent Scans grow ~250 B/offer | Owner review; Staging enablement only after merge + governed Staging deploy |
| 2 | **Scanner benchmark v1** — branch `research/b42-scanner-accuracy-benchmark-v1` | `tools/scanner-benchmark/` (manifest, fetch/verify, derive, scorer, adapters), `__tests__/scannerBenchmark/`, `docs/build42/scanner-accuracy/` | B42-SCAN-12 | node:test suite for scorer/judges/destination; manifest validator | none (offline tooling, no app or Edge Function import) | Owner review of image licence policy and label method |
| 3 | **Staging baseline run** (no code merge required beyond 1–2) | governed CI workflow on a `test/` branch using `STAGING_SYNTHETIC_*`; reads `vri03_gemini_usage` + `match_confidence_v1` logs | produces the first measured baseline; calibrates PR-1 thresholds; A/B v124 identity ON vs OFF | budget guard, quota-ledger reconciliation, sanitized artifact (existing harness pattern) | none to apps; Staging-only spend. Development split = 244 image-mode + 127 commerce_only requests (9 quota-days with one actor); Gemini upper bound ≤ $10.45 at the 2026-07-29 price record | **Owner approval of spend, quota plan (extra actors or a temporary Staging `SCAN_IDENTIFY_IMAGE_DAILY_LIMIT`), and Staging flag flips** |
| 4 | **Identity-aware ranking repair** | backend ranking: promote `probable` above `similar`; never fill a shelf with `unsupported`; penalize a different brand named in the title when the scanned brand is verified | B42-SCAN-02 | ranking fixtures from benchmark cases; flag-off byte-equivalence; handler test | backend-only; same response shape; flag default OFF | PR-3 shows exact-product recall@3 improves without raising unsupported rate (owner sets the bar) |
| 5 | **Truthful labels in the app** | mobile `PurchaseOptionsPanel`/`ScanResultV2`: render classes per the presentation contract; hide or separate `unsupported`; import the label contract from a parity-checked source | B42-SCAN-03, -10 | render harness + allowlist updates (see library render-harness trap); both platforms | requires a new app build for both stores → schedule with the next release, not Sprint 1 | Owner + design review; no paywall surfaces touched |
| 6 | **Verified-exact producer v1** | backend: `visible_model_text` evidence + listing model/style-code agreement → `exactIdentity` for `matchTier`; flag default OFF | B42-SCAN-04 | benchmark `exact_known` + `brand_logo` strata; false-exact rate on holdout | backend-only; extends the selected-item schema (one optional field, no extra call) | Holdout false-exact interval reported and accepted by owner |
| 7 | **Merchant destination strategy** | provider configuration/product decision (e.g. enable merchant-URL providers in more environments, or a resolution step) | B42-SCAN-01 | provider contract tests; PR-1 log line measures it live | config-only or backend-only | Owner/product decision; provider terms |
| 8 | **Backend test env isolation** | `commerceFunnel.v127.test.ts`, `vri03ScanImprovements.test.ts`: save/restore provider env | B42-SCAN-11 | full suite in both orders | none | Code review |

## Proposed first repair PR — PR 1

**Title:** `fix(scanner): evidence-bound per-offer match confidence (B42-SCAN-03, default OFF)`

**Why first:** it is the smallest change that (a) stops discarding the confidence signal the
pipeline already computes, (b) separates below-threshold padding from real matches and real
products from look-alikes in a way the benchmark can score, and (c) gives continuous
merchant-link validity from logs — without changing ranking, filtering, queries, providers,
response shape for existing fields, the app, or cost.

**Commits (local, not pushed):** `5dcedec2` feat, `b1d830c8` test-env pin; base `e58125a2`.

**Rollback:** unset or `false` `SCANNER_MATCH_CONFIDENCE_V1_ENABLED`; no data migration.

**Still needs manual verification:** a governed Staging deploy with the flag ON and a live
MODE B request to confirm the log line and field appear on deployed code; mobile render
harness check that no screen picks up the new field (expected none).
