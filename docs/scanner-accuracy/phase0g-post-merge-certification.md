# Phase 0G-R1 — Post-merge certification

Both authorized containment merges are **landed and certified**. Method was
`--ff-only` in both cases. No `--no-ff`, no squash, no rebase, no cherry-pick, no
force push, no history rewriting.

---

## iOS

| Field | Value |
|---|---|
| Target branch | `release/ios-v18-build-prep` |
| Target SHA before | `435e4bae1df0c6d50c22cdad42a80eb5d460ff69` |
| Merged integration branch | `integration/ios-qa-fixture-containment-ternary` |
| Target SHA after | `70c5b7c68872110b522458a9fddf405c3cf82bab` |
| Merge output | `Updating 435e4ba..70c5b7c` / `Fast-forward` |
| Files changed | `constants/qaFixtures.js` — 1 file, +49 / −42 |
| Resulting tree | `60aff96a20f93c8dc0d31bfda1618c6609477688` — **identical to the certified integration tree** |
| Worktree | `C:\src\KScan-ios-v18-release`, clean before and after |
| Pushed to origin | **yes** |
| App version / iOS build / Android versionCode | 1.0.1 / 17 / 23 — **unchanged** |

### ⚠ The push CREATED a new remote branch

`release/ios-v18-build-prep` did **not** exist on origin before this phase — it
was a local-only branch. `git push origin release/ios-v18-build-prep` therefore
reported `* [new branch]` rather than updating an existing ref.

This is the literal action authorized ("push the updated iOS target ref to
origin"), and it is the only way that instruction can be satisfied for a
local-only branch. It is flagged because publishing a release-preparation branch
to a shared remote for the first time is a visible change that the phrasing did
not obviously anticipate. Nothing was overwritten and no history was rewritten.

### Post-merge gates

| Gate | Result |
|---|---|
| Production export | 44 assets, **`fixtureAssetsPresent = 0`** |
| Development availability (module proof) | `__DEV__=true` → 8 fixtures / 8 requires; `__DEV__=false` → 0 / 0 |
| Worktree state | clean, no untracked changes |

## Master

| Field | Value |
|---|---|
| Target branch | `master` |
| `origin/master` before | `9bb0b57ed9c4869047a795fb0544e962bc306d4a` |
| Merged integration branch | `integration/master-qa-fixture-containment` |
| `origin/master` after | `08f0d0ef5aa387eac20945b64e161feaab6c04aa` |
| Push | `9bb0b57..08f0d0e master -> master`, non-force fast-forward |
| Resulting tree | `12be8db194204cbd4dc1da14395df2da474c62df` — **identical to the certified integration tree** |
| App version / iOS build / Android versionCode | 1.0.0 / 2 / 4 — **unchanged** |

### Note on the local `master` ref

The **local** `master` branch was at `ad42e6ef5404c7bb808f61104c0b3d2c164ac69f`,
behind `origin/master`, not diverged from it — verified with
`git merge-base --is-ancestor`. The fast-forward therefore advanced local `master`
across both the missing `origin/master` commits and the containment commit in one
step, which is why the merge output lists unrelated files
(`services/transactionalEmail.js`, three test files). Those came from
`origin/master`, not from the containment change.

The end state is what matters and it is exact: `origin/master` now equals the
certified integration SHA, and its tree equals the certified integration tree
byte for byte. `origin/master` was confirmed an ancestor of the new HEAD before
pushing, so the push was a genuine fast-forward.

### Post-merge gates

| Gate | Result |
|---|---|
| Production export | 23 assets, **`fixtureAssetsPresent = 0`** |
| Development availability (module proof) | `__DEV__=true` → 8 / 8; `__DEV__=false` → 0 / 0 |
| Tests | 182 tests, 180 pass, **2 failures** |

The two failures are `mapAuthError: unknown error passes through` and
`runAnalysis blocks duplicate invocation`. Both were attributed in Phase 0F over
10 isolated runs as **pre-existing deterministic** failures — 5/5 on base and 5/5
on candidate. They are unchanged by the merge and were **not** repaired, which is
out of scope. **The master suite is not green.**

## Android

Untouched. `release/android-v27-build-prep` remains at
`37b7141431f8b33029918ce15d28d2ba422eae38`, still **VERIFIED CLEAN** (45 assets, 0
fixture matches). No merge, no repair, no branch created.

## Superseded branch

`fix/qa-fixture-production-containment` at
`4c7201292def6314a3982621040541bfdc000165` remains **SUPERSEDED — DO NOT MERGE**.
Not merged, not deleted, retained for the audit trail.

---

## Containment status after this phase

| Line | Status |
|---|---|
| master | **INTEGRATED** — merged, pushed, export-certified 0 fixtures |
| iOS | **INTEGRATED** — merged, pushed, export-certified 0 fixtures |
| Android | **VERIFIED CLEAN** — no change required |

All three lines now share one mechanism: the plain `__DEV__` ternary in
`constants/qaFixtures.js`, with `metro.config.js` at the Expo default.

The eight QA fixture images are no longer reachable from any production bundle on
any active line. They remain present in the repository and remain
`excluded_pending_provenance` for evaluation purposes — containment and
provenance are separate questions, and only the first is now closed.

## What this phase did NOT do

No deployment, no EAS build, no TestFlight or store submission, no version or
build-number change, no Edge Function deployment, no production Scanner call, no
paid Gemini call, no production credential use, no Build 3 change, no Android
change, no migration, no unrelated test repair, no fixture deletion, no force
push, no branch-protection bypass.
