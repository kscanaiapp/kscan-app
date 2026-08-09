# Native mobile release evidence contract

> **SUSPENDED — not an active release control (2026-08-09).**
>
> Native UI automation was removed from release governance by owner decision.
> Authoritative policy: `security/release/native-ui-automation-policy.json`.
> Certification records `native_ui_automation.result =
> NOT_REQUIRED_BY_CURRENT_POLICY`. That is a statement about policy, **not** a
> statement that native UI tests passed — no native UI testing is currently
> performed.
>
> The Maestro runners, flow inventory, and evidence parser described below have
> been deleted. This document is retained because it specifies the contract a
> future runner must satisfy, and because it explains what the suspended control
> was meant to prove. Reinstatement criteria are in the policy file.
>
> Why it was suspended: six consecutive live dispatches produced no usable flow
> evidence, and every failure traced to test infrastructure rather than the
> application. See DEFECT-RRR-005 through RRR-010 in
> `docs/release/runtime-provenance-resolution.md`.

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

## Runners

Both platforms are implemented and branch-neutral:

| Platform | Workflow | Runner | Build |
| --- | --- | --- | --- |
| Android | `.github/workflows/native-android-release-tests.yml` | Maestro on `reactivecircus/android-emulator-runner` | debug APK via `expo prebuild` + `assembleDebug` |
| iOS | `.github/workflows/native-ios-release-tests.yml` | Maestro on a booted `simctl` device | Simulator `.app` via `expo prebuild` + `xcodebuild` |

Both take a `candidate_sha` input, check that exact commit out, and re-verify
`git rev-parse HEAD` against it before building, so evidence cannot drift from
the candidate. Neither needs a signing identity, provisioning profile, or store
credential: Android builds debug, iOS builds for Simulator with
`CODE_SIGNING_ALLOWED=NO`. Neither runs an EAS production build or submits.

Both refuse to start unless the reconciled `preview` EAS profile targets the
staging Supabase project, so a native run can never exercise production.

One shared flow set — `.maestro/flows/release`, tagged `release` — proves the
required inventory on both platforms; only setup is platform-specific. Each flow
declares `name:` equal to its required flow id, and
`security/native/release-flow-manifest.json` binds id to file, so a rename
cannot silently drop a required flow. No flow, workflow, or launcher depends on
Build 2.5; that is asserted in `__tests__/security/nativeReleaseRunner.test.js`.

`security/scripts/build-native-mobile-evidence.js` converts the Maestro JUnit
report into this contract's document. It only reports: certification re-validates
the artifact with `parse-native-mobile-evidence.js` against
`required-mobile-flows.json`, so a runner cannot vouch for itself. A missing or
unparseable report is `OPERATIONAL_FAILURE`, and a required flow the runner never
reported is simply absent, which the parser raises as
`REQUIRED_MOBILE_FLOW_MISSING`.

QA identities come from the `QA_EMAIL` / `QA_PASSWORD` secrets and are never
committed. The privacy correction, export, and account-deletion flows assert
their entry points and stop before submitting, so no QA account is destroyed.

TestSprite remains eligible only for a future real backend/API/web control with its own project, test, SHA attestation, and artifacts. No such TestSprite project is currently configured, so it is not release-required in this contract.
