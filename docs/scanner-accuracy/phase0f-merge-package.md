# Phase 0F — Merge package

Three containment targets. **Nothing was merged or deployed.**

All three lines now use **one mechanism**: the plain `__DEV__` ternary in
`constants/qaFixtures.js`, with `metro.config.js` left at the Expo default.

Every export used:

```bash
npx expo export --platform <ios|android> --output-dir <dir>
```

Node **v24.14.0**. `expo export` defaults to production; **no EAS profile was
passed**, because `expo export` does not accept one. Dependencies were installed
from each branch's own committed lockfile — `npm ci` for master, and for iOS and
Android a real-directory copy from a worktree with an identical `package-lock`
blob. A junctioned `node_modules` silently truncates an export and would
invalidate the comparison.

---

## Master

| Field | Value |
|---|---|
| Target branch | `origin/master` |
| Target SHA | `9bb0b57ed9c4869047a795fb0544e962bc306d4a` |
| Integration branch | `integration/master-qa-fixture-containment` |
| Integration SHA | `08f0d0ef5aa387eac20945b64e161feaab6c04aa` |
| Changed files | `constants/qaFixtures.js` (1 file) |
| Export pre-repair | 31 assets, **8** fixture matches |
| Export post-repair | 23 assets, **0** fixture matches |
| Expo | 54.0.35 |
| Dependencies | `npm ci` from committed lockfile (unmodified) |
| App version / iOS build / Android versionCode | 1.0.0 / 2 / 4 — **unchanged** |
| Tests | 182 tests, 180 pass, **2 pre-existing failures** |
| Status | **MERGE-READY** |

### Pre-existing failures — attribution cleared

| Test | Base `9bb0b57` | Candidate `08f0d0e` | Classification |
|---|---|---|---|
| `mapAuthError: unknown error passes through` | fails | fails | pre-existing deterministic |
| `runAnalysis blocks duplicate invocation` | **5/5 fail** | **5/5 fail** | pre-existing deterministic |

Ten isolated runs, same Node version, same dependency tree, same command, same
worktree. Neither failure is a candidate regression, and neither was repaired —
out of scope for this phase.

**The master suite is not green.** It has two pre-existing failures that this
change neither caused nor fixed.

### Merge guard

```bash
git rev-parse origin/master   # must equal 9bb0b57ed9c4869047a795fb0544e962bc306d4a
```

Merge **only** if it matches. If master has advanced: do not merge blindly —
recreate the integration branch from the new tip, rerun the export certification,
and rerun the attribution runs.

Post-merge verification:

```bash
npx expo export --platform ios --output-dir /tmp/master-post-merge
node scripts/check-export-fixture-containment.js /tmp/master-post-merge   # expect 0
```

---

## iOS

| Field | Value |
|---|---|
| Target branch | `release/ios-v18-build-prep` |
| Target SHA | `435e4bae1df0c6d50c22cdad42a80eb5d460ff69` |
| Integration branch | `integration/ios-qa-fixture-containment-ternary` |
| Integration SHA | `70c5b7c68872110b522458a9fddf405c3cf82bab` |
| Changed files | `constants/qaFixtures.js` (1 file) |
| Export pre-repair | 52 assets, **8** fixture matches |
| Export post-repair | 44 assets, **0** fixture matches, 25M |
| Expo | 54.0.36 |
| App version / iOS build / Android versionCode | 1.0.1 / 17 / 23 — **unchanged** |
| Tests | **1873 tests, 0 failures** |
| Status | **MERGE-READY** |

### Superseded branch — DO NOT MERGE

| Field | Value |
|---|---|
| Branch | `fix/qa-fixture-production-containment` |
| SHA | `4c7201292def6314a3982621040541bfdc000165` |
| Status | **SUPERSEDED — DO NOT MERGE** |
| Why | Changed `metro.config.js` and split the registry into `constants/qaFixtures.dev.js`, on the basis of a Phase 0D claim that was wrong. Its export proof (52 → 44, 0 fixtures) stands; the mechanism is unnecessary |
| Disposition | **Not deleted.** Retained for the audit trail |

### Development preservation

Module-level proof: transpiling `constants/qaFixtures.js` and evaluating it yields
**8 fixtures / 8 asset requires** at `__DEV__ = true`, and **0 / 0** at
`__DEV__ = false`.

Explicitly **not** claimed: a development bundle proof, or physical device
runtime. Neither was run. The repair changes no user-facing Scanner behaviour, so
§7.5 does not require device runtime.

### Merge guard

```bash
git rev-parse release/ios-v18-build-prep   # must equal 435e4bae1df0c6d50c22cdad42a80eb5d460ff69
```

Post-merge: same export + detector, expect `0`.

---

## Android

| Field | Value |
|---|---|
| Target branch | `release/android-v27-build-prep` |
| Target SHA | `37b7141431f8b33029918ce15d28d2ba422eae38` |
| Export | 45 assets, **0** fixture matches, 22M |
| Expo | 54.0.36 |
| App version / iOS build / Android versionCode | 1.0.1 / 13 / 26 |
| Repair | **none created** |
| Status | **VERIFIED CLEAN** |

The gate already present on this branch is a plain `__DEV__` ternary with a
default `metro.config.js` — and it works. Notably it contains **no commit
`918d2a3`**: the containment is equivalent logic from a different commit, which is
why commit presence is not containment evidence in either direction.

No integration branch was created, because creating one would be an unnecessary
production change.

### Revalidation trigger

Re-run the export only when **any** of these becomes true:

- the authoritative Android target advances past `37b7141431f8b33029918ce15d28d2ba422eae38`;
- the export evidence is no longer tied to that exact SHA;
- `constants/qaFixtures.js`, `metro.config.js`, or the fixture imports change.

Until then the existing proof stands and no action is required.

---

## Order of operations

1. **iOS first.** It is the only line with a full green suite (1873/0) and the
   most exposed, since a build cut from it today ships all eight images.
2. **Master second.** Same mechanism, but land it knowing the suite carries two
   pre-existing failures that are documented and attributed.
3. **Android: nothing to do.**

Landing iOS and master converges all three lines on one containment mechanism.

---

## Phase 0G addendum — merge type verified

Re-verified at Phase 0G opening. **All six target-SHA guards MATCH; nothing has
drifted.**

| Ref | SHA | Guard |
|---|---|---|
| `origin/master` | `9bb0b57ed9c4869047a795fb0544e962bc306d4a` | MATCH |
| `release/ios-v18-build-prep` | `435e4bae1df0c6d50c22cdad42a80eb5d460ff69` | MATCH |
| `release/android-v27-build-prep` | `37b7141431f8b33029918ce15d28d2ba422eae38` | MATCH |
| `integration/master-qa-fixture-containment` | `08f0d0ef5aa387eac20945b64e161feaab6c04aa` | MATCH |
| `integration/ios-qa-fixture-containment-ternary` | `70c5b7c68872110b522458a9fddf405c3cf82bab` | MATCH |
| `fix/qa-fixture-production-containment` (superseded) | `4c7201292def6314a3982621040541bfdc000165` | MATCH |

### Both merges are fast-forwards

| Merge | Relationship | Behind/ahead | Changed files |
|---|---|---|---|
| `integration/master-qa-fixture-containment` → `master` | target **is an ancestor** | 0 / 1 | `constants/qaFixtures.js` |
| `integration/ios-qa-fixture-containment-ternary` → `release/ios-v18-build-prep` | target **is an ancestor** | 0 / 1 | `constants/qaFixtures.js` |

Consequences, and they matter for risk:

1. **No conflict is possible.** A fast-forward has nothing to reconcile.
2. **The post-merge tree is identical to the integration tip** — `12be8db1…` for
   master, `60aff96a…` for iOS. So the export evidence already gathered *at those
   tips* (8 → 0 in both cases) **is** the post-merge evidence. A post-merge export
   cannot produce a different result, because it would be exporting the same tree.
3. A post-merge export is therefore a confirmation step, not a discovery step. It
   is still worth running once after each merge as a regression guard.

### If a target advances before the merge

The fast-forward property is what makes this safe, and it is exactly what a moved
target destroys. If either target advances, the merge stops being a fast-forward
and this evidence no longer applies: recreate the integration branch from the new
tip, re-export, and re-run attribution before merging.
