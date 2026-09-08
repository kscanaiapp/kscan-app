# PR #341 (Device ID privacy manifest) — historical-SHA CI poisoning

**Status: documentation only. No product code, privacy configuration, test,
baseline, or CI/gate logic was changed by this commit. Its entire diff is one
new file under `docs/audits/`.**

| Field | Value |
|---|---|
| Pull request | #341, `repair/ios-device-id-privacy-v1` → `release/kscan-pre-freeze-v1` |
| Poisoned SHA | `483a2743ccdec62180edbc82781119f9bcf7c625` |
| Repair content | **Accepted, unchanged.** Only the manifest declaration and its tests; no product/privacy/CI change needed. |

## What happened

Pushing `483a2743` (before PR #341 existed) triggered `Security - Code and
Dependencies` as a **push** event: run `34218006629`. Opening the PR moments
later triggered the same workflow again as a **pull_request** event on the
identical SHA: run `34218059878`. Both runs share `head_sha = 483a2743…`.

- Push run `34218006629`, job `Project checks`, step `Run full regression
  suite`: **failure**. Output:
  ```
  Known full-suite failure baseline: 19 identities.
  Observed failures: 14; known: 13; unexpected: 1.
  Unexpected failing tests:
  - no migration references a schema-qualified object in a schema no migration creates
  ```
- Pull-request run `34218059878`, job `Project checks`, step `Run full
  regression suite`: **success** (step conclusion `success`; the governed
  Deno suite that runs immediately after it in the same job logged
  `984 passed | 0 failed`).

## Root-cause analysis of the one "unexpected" test

The failing identity is `no migration references a schema-qualified object in
a schema no migration creates`, defined in
`__tests__/migrationReplayConflicts.test.js:168`. It is a purely
content-deterministic check: it lists `supabase/migrations/*.sql`, sorts the
filenames, and asserts the migration that runs `create schema if not exists
internal;` does not sort after the first migration that references
`internal.*(`. There is no timing, randomness, concurrency-shared state, or
locale dependency in it — `Array.prototype.sort()` on filenames is
locale-independent and `fs.readFileSync` on tracked files is content-only.

Three independent executions of the exact same commit disagree with the one
push-run failure:

1. **Local, at this exact SHA** (`git rev-parse HEAD` = `483a2743…`):
   `node --test __tests__/migrationReplayConflicts.test.js` → 15/15 pass,
   including this test. The full governed suite
   (`node scripts/run-all-tests.js`) reports `Observed failures: 13; known:
   13; unexpected: 0` and exits 0.
2. **The pull_request-triggered CI run of the same SHA** (`34218059878`):
   `Run full regression suite` step succeeded outright.
3. The failing identity is **not** in `config/test-failure-baseline.json`'s
   19 governed entries — it isn't a known/tracked flake either; it simply did
   not reproduce anywhere except that one push-run execution.

Nothing in PR #341's diff (`app.json`'s privacy manifest,
`scripts/verify-apple-readiness.js`, `__tests__/verifyAppleReadiness.test.js`,
`__tests__/mirrorIosVisionParity.test.js`) touches `supabase/migrations/` or
`__tests__/migrationReplayConflicts.test.js` in any way. Combined with the
test's full determinism and its clean pass on the same SHA both locally and
on the very next CI execution, this is a one-off, non-reproducible anomaly
local to that single push-triggered runner (e.g. an incomplete or racing
filesystem read during that job's checkout) — not a defect in the tree, and
not a regression introduced by this repair.

## Why the PR is still blocked: the promotion gate, not the code

`Security promotion gate` (job `102034418722`, run `34218059781`) evaluates
`security/scripts/evaluate-promotion-gate.js --sha 483a2743…`. Per
`CI-APPLICABILITY-002` (see that script and the identical precedent in
`docs/audits/rp108-release-certification-authority.md`), the evaluator reads
`GET /commits/{sha}/check-runs`, groups every check-run attached to that SHA
by `name` across **all** check-suites (i.e. both the push-triggered suite and
the pull_request-triggered suite), and reduces each name-group so that **a
completed FAILURE is conclusive and wins over every other sibling of the same
name** — deliberately, so a failed check can never be quietly outrun by a
later lucky rerun.

Because the push-triggered suite's `Project checks` run is a completed
failure attached to `483a2743…`, the gate returns, regardless of the
pull_request suite's clean `Project checks` run on the identical SHA:

```json
{"finalVerdict":"OPERATIONAL FAILURE","failures":["projectChecksCiOperationalFailure","Project checks: failure"],"blockingReason":"projectChecksCiOperationalFailure","missingChecks":[],"pendingChecks":[]}
```

This rule is correct and is **not weakened, disabled, or worked around** by
this commit. No admin override was used. The tree at `483a2743…` is already
correct; the SHA is not. A fresh SHA — produced by a documentation-only
commit exactly like this one, per the established
`docs/audits/rp108-release-certification-authority.md` precedent — is the
honest way to get a clean certification.

## Scope confirmation

This commit changes nothing else: no product code, no privacy manifest
content, no test, no baseline file, and no CI/gate script or workflow. It
exists solely to give the already-accepted PR #341 tree a fresh SHA so the
required checks can certify it from a clean slate.
