# Staging bootstrap workflow — registration on `master`

`.github/workflows/staging-release-bootstrap.yml` is authored and governed on
`staging/production-parity`. It exists a second time, byte-identical, on
`master`.

## Why a second copy exists

GitHub only shows a `workflow_dispatch` workflow as manually runnable (in the
UI "Run workflow" button, `gh workflow run`, and the
`POST /actions/workflows/{id}/dispatches` API) once that workflow file is
present on the repository's **default branch**. This repository's default
branch is `master`, not `staging/production-parity`. Without a copy on
`master`, the bootstrap workflow is unregistered and cannot be dispatched by
any of the normal GitHub Actions entry points — that's the entire reason this
copy exists.

## Why this does not turn `master` into a staging deploy source

The copy is registration-only. It contributes nothing else, because every job
in the workflow re-establishes its own source of truth before doing anything:

- The `preflight` job's first step is `actions/checkout` with
  `ref: staging/production-parity` (a literal string, not `github.ref`), and
  the very next step fails the run if the resulting `HEAD` does not equal
  `origin/staging/production-parity`.
- Every later job (`plan`, `execute`, `persist`) checks out
  `${{ needs.preflight.outputs.candidate_sha }}` — the SHA `preflight` just
  validated — never `master` and never the ref the run was dispatched
  against.

So regardless of which branch a user selects in the "Use workflow from"
dropdown when dispatching, the job filesystem is always overwritten with
`staging/production-parity`'s tree before any release script runs. The
`master` copy supplies only the trigger/job-graph shell GitHub needs to offer
the "Run workflow" button; none of `security/release/*` needs to exist on
`master`, because the jobs never read those scripts from `master`'s checkout.

## Synchronization rule

**The two copies must stay byte-identical.** The workflow is designed,
reviewed, and changed on `staging/production-parity`; `master`'s copy is a
mirror, never a second place to edit it. Any PR that changes
`staging-release-bootstrap.yml` on staging must be followed by an equivalent
PR that copies the new byte-for-byte content onto `master`.

`__tests__/stagingReleaseBootstrapRegistration.test.js` enforces this: it
asserts a fixed set of safety properties against `master`'s local copy
unconditionally, and — when `origin/staging/production-parity` is fetchable
(true in CI, best-effort locally) — additionally asserts the two files are
byte-identical. A divergence fails CI on `master`.

## What this PR does not do

It does not run `PLAN_ONLY`, run `EXECUTE`, deploy any Edge Function, write
`KSCAN_*` release metadata, apply a migration, or create a staging verified
release/tag. It only makes the existing, already-merged staging governance
workflow dispatchable through the normal GitHub Actions surface.
