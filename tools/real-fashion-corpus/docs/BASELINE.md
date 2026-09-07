# Pristine-base baseline record — Real Fashion Match Corpus V1

Captured **before** this lane wrote a single line of product code, so that a
later failure can always be attributed to either the inherited base or this
lane (mission section 2, and invariant 42.15).

## Pinned source authority

| Field | Value |
|---|---|
| `BUILD_35_BASE_BRANCH` | `integration/build35-convergence-v1` |
| `BUILD_35_BASE_SHA` | `afa2630099c3a44ae824ad72aedbd1d612e4eb2e` |
| Base HEAD subject | `Merge PR #314: Fashion Match Quality Lab V1 (measurement authority)` |
| Lane branch | `research/real-fashion-match-corpus-v1` |
| Worktree | `C:/src/KScan-real-fashion-match-corpus-20260906` |
| Worktree state at checkout | clean |
| Hard precondition `tools/fashion-match-quality/` present | YES (62 files) |

Git identity resolved in this worktree before the first commit
(`git config --show-origin user.email` / `user.name`):

```
file:C:/Users/jsmit/.gitconfig  justin.landes@gmail.com
file:C:/Users/jsmit/.gitconfig  Justin Smith
```

That is the expected project owner, so no worktree-local override was needed.
(A prior session flagged git-identity contamination as a recurring hazard in
this repository; this check is the guard against it.)

## Environment

| Tool | Version |
|---|---|
| node | v24.14.0 |
| npm | 11.9.0 |
| deno | 2.8.2 (required by FMQL's L1 offline pipeline mode) |
| git-lfs | 3.7.1 installed, **but not used by this repository** (see storage decision) |

`node_modules/` was **empty** at checkout. It was populated with `npm ci`
(945 packages, exit 0) before any baseline was believed. This matters: a
prior lane in this repository recorded that `scripts/run-all-tests.js` can
exit 0 with no `node_modules`, so a green exit code alone is not evidence.

## Baseline 1 — Fashion Match Quality Lab (the inherited authority)

FMQL has no `package.json` script and is not referenced by any
`.github/workflows/*.yml`. It is executed by explicit file enumeration:

```bash
node --test $(find tools/fashion-match-quality -name '*.test.js' | sort)
```

| Metric | Value |
|---|---|
| tests | 95 |
| pass | **95** |
| fail | **0** |
| **FMQL BASE TESTS** | **PASS** |

### One transient failure, and why it is not an inherited failure

The first FMQL run was executed while `npm ci` was still running in another
process. `tools/fashion-match-quality/l1/runL1.test.js` failed with:

```
{"ok":false,"blocker":"DENO_SUBPROCESS_FAILED",
 "detail":"Blocking waiting for file lock on node_modules directory ...
           error: Access is denied. (os error 5)"}
```

That is a Windows file-lock collision between `npm ci` and the Deno
subprocess FMQL shells out to — not a property of the base. Re-run after
`npm ci` settled: `l1/runL1.test.js` 5/5 pass, full FMQL suite 95/95 pass.
**Recorded here so it is never mistaken for an inherited base failure.**

Operational note for future runs: do not run the FMQL suite concurrently
with an install that writes `node_modules/`.

## Baseline 2 — governed repository baseline

The repository's own pre-merge gate is `npm run test:all`
(`node scripts/run-all-tests.js`), which discovers `__tests__/**` recursively
and diffs observed failures against `config/test-failure-baseline.json`.

| Metric | Value |
|---|---|
| test files found | 427 |
| test files executed | 427 |
| test files excluded | 1 (`__tests__/.../fixtures` — static data) |
| tests | 7698 |
| pass | 7620 |
| fail | 13 |
| skipped | 65 |
| known failure identities in baseline file | 19 |
| observed failures matched as known | 13 |
| **unexpected failures** | **0** |
| gate exit code | **0** |

### INHERITED BASE FAILURES (13, all pre-recorded, none repaired by this lane)

All 13 are already enumerated in `config/test-failure-baseline.json`. Mission
section 2 is explicit: record them separately, do not repair unrelated
failures. This lane repairs none of them. Representative examples observed:

- `__tests__/security/...` — a migration-text regex expecting bare
  `revoke execute on function public.enforce_minor_privacy_defaults(...)`
  statements, while the migration now applies the same revokes through a
  `pg_proc` catalogue lookup (so the file replays on both the staging and
  production lineages).
- `__tests__/staging/easProfileParity.test.js` — staging EAS profile missing
  three production client-feature flags
  (`EXPO_PUBLIC_FREE_TIER_OUTFIT_GENERATOR_ENABLED`,
  `EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED`,
  `EXPO_PUBLIC_FREE_TIER_WISHLIST_INTENT_ENABLED`).
- `__tests__/staging/easProfileParity.test.js` — `EXPO_PUBLIC_TODAY_WITH_ELISE_V1`
  differing between production and staging without an allow-listed reason.

The baseline file records 19 identities and only 13 were observed; the gate
explicitly permits recorded failures to disappear (`"fixed baseline failures
are allowed to disappear"`), so this is a green gate.

## Baseline 3 — root typecheck

```bash
npx tsc --noEmit    # exit 0
```

Note `tsconfig.json` excludes `tools/fashion-match-quality/**` (the lab is
CommonJS JavaScript, not TypeScript). This lane's tooling is CommonJS
JavaScript for exactly the same reason and inherits the same exclusion by
adding `tools/real-fashion-corpus/**` — see `DESIGN.md`.

## Sibling-lane firewall — heads observed at lane start

| Branch | Head at dispatch | Head observed at lane start |
|---|---|---|
| `research/canonical-product-identity-lab-v1` | `ad2b70a` | `5ab6ded` (moved — concurrent lane) |
| `research/elise-concierge-evaluation-harness-v1` | `139e863` | `798249b` (moved — concurrent lane) |
| `research/curiosity-gap-performance-v1` | `1693851` | `1693851` |
| `research/fashion-match-quality-lab-v1` | `76b54ee` | `76b54ee` |
| `research/scanner-accuracy-v2-evals` | — | `5e41243` |
| `research/scanner-accuracy-v2-phase2a` | — | `3e0b6ae` |
| `research/scanner-accuracy-v2-phase2b-preintegration` | — | `4368067` |
| `integration/build35-convergence-v1` (this lane's base) | `afa2630` | `afa2630` |

Two sibling lanes moved between dispatch and lane start. That is expected —
they are concurrent. The firewall obligation is that **nothing from any of
them enters this lane's history**: no cherry-pick, no rebase onto, no merge,
no waiting. FMQL content reaches this lane only through the already-merged
PR #314 in the pinned base, never by pulling from the live
`research/fashion-match-quality-lab-v1` branch.
