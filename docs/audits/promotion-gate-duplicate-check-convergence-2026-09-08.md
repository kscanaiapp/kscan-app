# CI Governance Defect — Promotion Gate duplicate-check convergence

**Status: documentation only. No product code, CI/gate logic, workflow, test,
baseline, findings policy, or environment was changed by this commit. Its
entire diff is one new file under `docs/audits/`.**

| Field | Value |
|---|---|
| Severity | **P3** |
| Type | CI / release-governance reliability |
| Security posture | Fail-closed behaviour is **correct**; the defect is duplicate-run convergence |
| Product / runtime impact | **None** |
| Release impact | Can indefinitely block an otherwise valid PR until stale duplicate checks are manually rerun |
| Status | **RECORDED — NOT YET REPAIRED** |
| First observed | PR #341, `Project checks` (see `docs/audits/pr341-device-id-privacy-ci-poisoning-2026-09-08.md`) |
| Re-observed | PR #350, `ZAP Baseline (staging)` — the incident recorded below |

---

## Summary

GitHub can create multiple check runs with the same governed check name for the
same candidate SHA when the same workflow runs under both `push` and
`pull_request`.

The Promotion Gate intentionally uses failure-wins reduction across checks with
the same governed name. **That security behaviour is correct.**

The defect is that an older failed duplicate remains authoritative even after a
newer duplicate with the same name succeeds on the exact same SHA. As a result,
a transient infrastructure failure in one duplicate can permanently poison
Promotion Gate evaluation until that specific stale run is manually rerun.

---

## Proven incident

Observed during PR #350 CI closure.

Candidate SHA:

```
efdbfb23ad47a72726e6a93a48432315477b9c63
```

Two checks existed under the governed name `ZAP Baseline (staging)`:

| Run | Event | Conclusion |
|---|---|---|
| `34250674146` (#1249) | `push` | **FAILURE** |
| `34250820780` (#1250) | `pull_request` | SUCCESS |

The older failure was **not** caused by the ZAP scan itself. The scan completed
successfully:

```
FAIL-NEW: 0	FAIL-INPROG: 0	WARN-NEW: 5	WARN-INPROG: 0	INFO: 0	IGNORE: 0	PASS: 62
zap-baseline-report.json: valid JSON
ZAP baseline completed successfully.
```

The workflow failed later, during GitHub artifact finalization:

```
##[error]Failed to FinalizeArtifact: Received non-retryable error:
         Failed request: (403) Forbidden: Error from intermediary with HTTP status code 403 "Forbidden"
```

A subsequent real ZAP rerun on the same SHA (attempt 2, job `102159999031`)
succeeded completely — health check `401` accepted, 82-second scan, 62 passive
rules, valid reports, artifact `10067712192` finalized.

Despite the newer successful ZAP result, Promotion Gate continued to fail
because the older duplicate failure remained in the check set:

```json
{"finalVerdict":"OPERATIONAL FAILURE","failures":["zapOperationalFailure","ZAP Baseline (staging): failure"],"blockingReason":"zapOperationalFailure","missingChecks":[],"pendingChecks":[]}
```

Promotion Gate did exactly what its current failure-wins logic instructs it to
do.

### This is the second observed instance of the same mechanism

`docs/audits/pr341-device-id-privacy-ci-poisoning-2026-09-08.md` records the
identical root mechanism on a different governed check: pushing
`483a2743ccdec62180edbc82781119f9bcf7c625` triggered `Security - Code and
Dependencies` as a **push** event (run `34218006629`, `Project checks`
**failure**); opening the PR moments later triggered the same workflow as a
**pull_request** event on the identical SHA (run `34218059878`, `Project
checks` **success**).

Two independent recurrences across two different required checks is what makes
this architectural rather than incidental.

---

## Root mechanism

Relevant required workflows can run on both `push` and `pull_request`. Their
concurrency keys include:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Those events resolve to different refs — `refs/heads/<branch>` versus
`refs/pull/<number>/merge` — so the two executions do not converge into the
same concurrency group and do not cancel or supersede one another. Both can
publish a check with the same governed check name against the same candidate
SHA.

The Promotion Gate's duplicate reduction (`reduceRunsForName`,
CI-APPLICABILITY-002 in `security/scripts/evaluate-promotion-gate.js`) then sees
both, and its fail-closed rule makes a completed failure win over sibling
successes:

> *"a completed FAILURE is conclusive and wins over every other sibling,
> completed or not, regardless of timestamps — a check must never be reported
> satisfied (or left pending) while a real failure exists for it"*

This means:

> **A stale infrastructure failure from one event copy can continue blocking
> the candidate after another execution of the same governed check has
> succeeded on the exact same SHA.**

---

## What is NOT defective

Do not classify any of the following as the defect. Each behaved correctly:

- Promotion Gate failing closed
- ZAP findings policy
- ZAP timeout
- ZAP scanner behaviour
- minimum dependency-age enforcement
- artifact existence requirements
- `Security - Code and Dependencies`
- requiring all governed checks to succeed

The defect is specifically **duplicate required-check convergence across
multiple workflow executions for one candidate SHA**.

---

## Security invariant

Any repair must preserve:

> a real unresolved security failure must continue to block promotion

Do **not** solve this by:

- treating operational failures as success
- ignoring older failures indiscriminately
- switching artifact upload failures to warnings
- using `continue-on-error`
- removing duplicate checks from evaluation without proving supersession
- changing failure-wins to success-wins
- weakening Promotion Gate applicability
- allowing a newer success to erase a genuinely unresolved older security
  finding without an explicit supersession rule

---

## Desired behaviour

For each governed required check, Promotion Gate should evaluate the
authoritative execution for the candidate, not every historical duplicate
forever.

The repository needs a deterministic supersession/convergence rule that
distinguishes:

- **Active / unresolved failure** — must block

from:

- **Older duplicate execution superseded by a later valid execution of the same
  governed check for the same candidate SHA** — should not permanently poison
  the candidate

The exact authority rule must be designed and tested before implementation.

---

## Investigation targets

- workflow triggers for required security workflows
- `push` vs `pull_request` duplication
- concurrency grouping
- candidate SHA semantics
- check-run names
- Promotion Gate check collection
- `reduceRunsForName`
- CI-APPLICABILITY-002
- whether push and PR copies are both actually required
- whether workflow identity / run event can be carried into evaluator input
- whether one event can become authoritative for PR promotion
- whether supersession can be determined safely by run creation/completion
  order plus candidate SHA / event identity

---

## Candidate solution classes

Investigation may choose one of these **only after proving its safety**. No
solution is pre-authorized merely because it is listed here.

1. **Prevent duplicate required runs** — make only one event type authoritative
   for PR promotion where appropriate.
2. **Unify concurrency** — ensure equivalent executions for one candidate
   converge/cancel correctly.
3. **Explicit authoritative-run selection** — Promotion Gate selects a single
   governed execution based on a deterministic candidate/event authority
   contract.
4. **Safe supersession model** — a later execution may supersede an older
   duplicate only when all required identity conditions prove they represent
   the same governed check against the same candidate.

---

## Observability improvement

Separately, add richer Promotion Gate failure diagnostics where safe. Useful
fields:

- governed check name
- selected failing run ID
- workflow name
- event type
- job name
- candidate SHA
- run URL
- competing duplicate run IDs / results
- reason the evaluator selected the failing execution

This is **observability only** and must not alter gate semantics.

In the PR #350 incident the verdict named only `zapOperationalFailure` and
`ZAP Baseline (staging): failure`, with no run identifier — the blocking run
had to be located by manually enumerating all 55 check runs on the SHA.

---

## Acceptance criteria

The defect is closed when tests prove all of the following:

1. A genuine current security failure still blocks promotion.
2. A stale duplicate failure cannot permanently block a newer authoritative
   success for the exact same candidate.
3. A success cannot incorrectly override an unresolved real failure.
4. `push` / `pull_request` duplication has a deterministic authority rule.
5. The evaluator is independent of GitHub API result ordering.
6. Re-running the same check does not require manually clearing every
   historical duplicate.
7. Promotion Gate diagnostics identify the exact selected run.
8. No required security workflow is removed.
9. No findings policy is weakened.
10. No `continue-on-error` or equivalent bypass is introduced.

---

## Negative controls

| Control | Scenario | Expected |
|---|---|---|
| **DUP-01** | Older failure + newer authoritative success, same candidate and same governed check | SUCCESS may supersede **only** under the explicit authority rule |
| **DUP-02** | Older success + newer authoritative failure | **FAIL** |
| **DUP-03** | Failure and success belong to different candidate SHAs | no cross-SHA supersession |
| **DUP-04** | Newer success belongs to a non-authoritative event | must not erase authoritative failure |
| **DUP-05** | Two current executions are ambiguous under the authority model | **FAIL CLOSED** |
| **DUP-06** | GitHub API returns duplicate runs in reversed / random order | same verdict |
| **DUP-07** | Artifact-service operational failure remains the latest authoritative result | **FAIL** — no automatic security bypass |

---

## TEST-FLIP LEDGER

Any evaluator test changing from:

> any historical duplicate failure permanently wins

must document:

- old expectation
- why it created permanent stale-failure poisoning
- new explicit supersession rule
- proof that unresolved real failures still block

**Do not simply replace failure-wins with latest-run-wins.**

---

## Scope

Expected scope:

- Promotion Gate evaluator
- CI applicability / convergence tests
- potentially workflow trigger or concurrency definitions
- Promotion Gate diagnostic artifact

Do not modify:

- application source
- Android / iOS runtime
- ZAP findings rules
- backend source
- dependency security policies
- production / staging environments

---

## Status

**RECORDED — NOT YET REPAIRED.**

The PR #350 incident was closed through same-SHA reruns only:
`Security - Code and Dependencies` `34250822726` attempt 2, `ZAP Baseline
Staging` `34250674146` attempt 2, and `Security - Promotion Gate` runs
`34252360452` attempt 3, `34250820590` attempt 2 and `34250674139` attempt 2.

No gate was weakened. No source changed. The head SHA was never altered.

The underlying convergence defect remains reproducible in architecture and
should be repaired in a dedicated CI-governance lane.
