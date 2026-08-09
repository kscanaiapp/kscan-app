# Native mobile release evidence contract

Runtime certification accepts native Android/iOS evidence only from a completed GitHub Actions run in this repository whose `head_sha` equals the candidate. It also pins workflow name and path to `Native Android Release Tests` / `.github/workflows/native-android-release-tests.yml` and `Native iOS Release Tests` / `.github/workflows/native-ios-release-tests.yml`. TestSprite frontend/backend runs are not native evidence.

Each platform artifact must be named `native-android-evidence` or `native-ios-evidence`, contain one JSON file, and include:

- `runner` (for example, Maestro; never TestSprite)
- `build_identifier`
- `run_id`
- `tested_sha`
- calibrated `result`: `PASS`, `BLOCKED`, `PENDING`, `NOT_APPLICABLE`, or `OPERATIONAL_FAILURE`
- `flows[]` with stable flow IDs and per-flow result
- verifiable HTTPS `artifact_links`

The parser derives `flows_run`, `flows_passed`, and `flows_failed` and validates the required inventory in `security/native/required-mobile-flows.json`. A runtime release requires both platform artifacts, exact candidate SHA, build/run identity, all required flows passing, and artifact links.

Semantics:

- critical required flow fails: `BLOCKED`
- runner/build infrastructure fails: `OPERATIONAL_FAILURE`
- run is still active: `PENDING`
- optional unsupported flow: per-flow `NOT_APPLICABLE`
- wrong SHA or missing required evidence: `BLOCKED`
- no configured required platform run: `BLOCKED` / `MOBILE_EVIDENCE_NOT_CONFIGURED`

## Current infrastructure audit

The repository contains branch-neutral Maestro flows for onboarding/auth, camera permissions, scan analysis/retry/non-fashion behavior, and a few avatar surfaces. It does not contain a maintained complete Android/iOS release workflow covering the required inventory. The only fuller iOS GitHub launcher on master explicitly checks out `test/ios-build25-maestro-runtime`; it is excluded from this release line. Consequently, the evidence contract is implemented, but the current runtime candidate remains blocked until owner-approved branch-neutral native workflows produce real runs for both platforms.

TestSprite remains eligible only for a future real backend/API/web control with its own project, test, SHA attestation, and artifacts. No such TestSprite project is currently configured, so it is not release-required in this contract.
