# VTO backend E2E certification harness

Source: `scripts/vto-e2e/`. Workflow: `.github/workflows/vto-e2e.yml`. Tests:
`__tests__/vtoE2eFixtures.test.js`, `__tests__/vtoE2eContractControls.test.js`,
`__tests__/vtoE2eHarnessIntegrity.test.js`.

This document exists so a future engineer or agent never has to rediscover
how this harness reaches staging SQL, or re-litigate why its shell pipelines
are written the way they are. Both were the subject of a certification-
harness integrity repair (`fix(vto): fail closed in backend certification
harness`) and this file is that repair's permanent record.

## 1. Modes

| Mode | Live staging mutation | Trigger |
|---|---|---|
| `contract` | No | every push/PR, and manual dispatch (default) |
| `staging-dryrun` | Yes (zero-spend) | `workflow_dispatch` only |
| `staging-full-certification` | Yes (ONE paid provider request) | `workflow_dispatch`, requires `confirm_paid_certification=YES` |
| `cleanup` | Yes (deletes only this harness's own actors) | `workflow_dispatch` |

## 2. The single governed SQL venue

**SQL venue:** `supabase db query <sql> --linked --output-format json`, run
via the Supabase CLI against the linked staging project's Management API.

**Implementation file:** `scripts/vto-e2e/lib/sql.mjs` — `runSqlViaSupabaseCli`
and `sqlQuote`. This is the *only* module in the harness allowed to call
`runSupabase`; every other module (`actors.mjs`, `dryrun.mjs`, `fullcert.mjs`,
`persistence.mjs`, `cleanup.mjs`, `run.mjs`) receives an injected
`runSql(sql)` function and never shells out itself. `sqlQuote` is likewise
the harness's one literal-escaping function — no call site defines its own
copy (`__tests__/vtoE2eHarnessIntegrity.test.js` pins both invariants).

**Governed by:** `scripts/lib/staging-helpers.mjs`'s `runSupabase`, the exact
mechanism `scripts/apply-staging-migration.mjs` and every other staging
deployment script in this repository already use — authenticated by the
already-governed `SUPABASE_ACCESS_TOKEN`, never a service-role key or a raw
Postgres connection string held by this harness.

**Staging guard:** `scripts/vto-e2e/lib/staging-target.mjs`'s
`assertVtoStagingTarget` (a thin wrapper over
`scripts/lib/staging-helpers.mjs`'s `assertStagingTarget`) is called before
any provisioning happens. It requires `SUPABASE_STAGING_PROJECT_REF` to equal
exactly `yzqjvdfgefveprobvvyw` and refuses a service-role key presented where
a publishable key is expected.

**Production rejection:** the same guard explicitly throws `StagingGuardError`
if the project ref equals production (`wyyuqfdxucjksghsmhry`), if the URL
names the production ref, or if the ref is anything unrecognized —
production is unreachable by accident, not merely undocumented as a target.

**Authority source:** the CLI command shape was independently reproduced
against the exact `supabase` CLI version `supabase/setup-cli@v1` with
`version: latest` currently resolves (`2.116.0`): `supabase db query --help`
lists `query` as a real subcommand, and the exact argument shape this
harness uses (`[sql, '--linked', '--output-format', 'json']`) parses
successfully and reaches genuine runtime state rather than an "unknown
command" error.

### Why SQL, not a client HTTP call

`release_vto_generation` and `reserve_vto_generation` are `service_role`-only
RPCs, unreachable from a normal authenticated client request by design (see
`docs/vto-foundation.md` §5-§6 for the entitlement/authority chain they sit
behind). Proving double-release-is-a-no-op and foreign-actor isolation needs
the same privileged path the RPC privilege matrix itself assumes, which is
exactly this governed SQL venue — not a new service-role key minted for this
harness.

## 3. Pipefail contract (false-green pipeline repair)

GitHub Actions' **undeclared** default shell on Linux runners is
`bash -e {0}` — without `-o pipefail`. A step shaped like
`node run.mjs | tee report.json` then exits with `tee`'s status (almost
always `0`) instead of `node`'s, so a failed certification run could report
SUCCESS. `.github/workflows/vto-e2e.yml` sets `defaults.run.shell: bash` at
the workflow level, which switches every step to
`bash --noprofile --norc -eo pipefail {0}` and makes this structurally
impossible to reintroduce by accident anywhere in this file.

`scripts/vto-e2e/lib/workflow-guard.mjs` parses this workflow file (a
purpose-built line scanner, not a general YAML/bash parser) and fails
contract mode if any `run:` step containing a shell pipe is ever added back
without pipefail-safe semantics (an inherited `shell: bash`, or an inline
`set -o/-eo/-euo pipefail`). It also asserts every live-staging job
(`staging-dryrun`, `staging-full-certification`, `cleanup`) still declares
`concurrency: { group: vto-e2e-certification, cancel-in-progress: false }`,
so two live runs can never interleave.

## 4. Certification artifact schema

Every `staging-dryrun` / `staging-full-certification` run writes a JSON
report and uploads it as a workflow artifact. The workflow conclusion alone
is never sufficient proof the run was clean — a dedicated
`node scripts/vto-e2e/validate-report.mjs <file>` step (no shell pipeline of
its own) independently re-checks the file after the harness step completes.
Schema (`scripts/vto-e2e/lib/report-schema.mjs`):

| Field | Type | Notes |
|---|---|---|
| `runId` | string | correlates workflow dispatch, actors, DB rows, cleanup, and report |
| `projectRef` | string | must equal the expected staging project ref |
| `mode` | string | one of `contract`, `staging-dryrun`, `staging-full-certification`, `cleanup` |
| `authoritySha` | string | 40-hex; the commit the harness is running as (`GITHUB_SHA`) |
| `controls` | array/object | non-empty; explicit per-control outcomes |
| `providerSubmits` | number | must be `0` outside `staging-full-certification` |
| `paidRequests` | number | must be `0` outside `staging-full-certification` |
| `cleanupStatus` | object | `{ usersRemaining, entitlementsRemaining, vtoRequestsRemaining, clean, perActor }`, run-scoped only |
| `verdict` | string | `PASS` or `FAIL` |

An artifact that is missing, empty, oversized (≥ 10 MB), malformed JSON,
missing a required field, or whose `runId`/`projectRef`/`mode`/`authoritySha`
does not match the current invocation is rejected as **STALE** or
**STRUCTURAL** — never treated as a certification pass. See
`__tests__/vtoE2eHarnessIntegrity.test.js` for the full negative-control
matrix.

## 5. Cleanup contract

Cleanup is not successful merely because a `delete` statement ran.
`scripts/vto-e2e/lib/cleanup.mjs`'s `cleanupVtoActors` re-queries
authoritative state, scoped to the exact synthetic actor ids this run
created, after every delete; `summarizeCleanupStatus` sums those per-actor
`postState` counts into the run-scoped `usersRemaining` /
`entitlementsRemaining` / `vtoRequestsRemaining` fields the artifact carries.
This is never a global "staging has zero synthetic users" assertion —
always scoped to the current run's own actor ids.
