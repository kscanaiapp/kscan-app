# Staging Release Verification (Phase 2B)

How a frozen backend candidate becomes `STAGING_VERIFIED`, and — just as
importantly — what this system does **not** claim.

Phase 2A dependency: merged as `d56565ae6a90fc8baf9cfd10b022a786f8ef9675`.

## The chain

```
frozen release manifest        security/release/generate-release-manifest.js
        ↓ verifyFreeze
candidate binding              security/release/candidate-binding.js
        ↓ existing change-scoped deploy (security-staging-gate / staging-controlled-deploy)
deployment receipt             security/release/deployment-receipt.js
        ↓
exact candidate verification   security/release/verify-exact-candidate.js
        ↓
health / readiness / version   supabase/functions/staging-health
        ↓
real staging smoke             security/release/run-release-smoke.js
        ↓
existing staging certification (consumed as an INPUT)
        ↓ normalized by staging-release-verification-policy.json
authoritative release evidence security/release/build-release-evidence.js
        ↓
STAGING_VERIFIED
```

## Trust model — read this before trusting a PASS

**What the system proves.** For every component in the deployment delta: the
bytes came from an immutable git object (`git show <candidate>:<path>`), were
hashed into the binding before deploy, recorded in a digest-stamped receipt,
and corroborated against the deployed function's own `/version` response.

**What it cannot prove.** Supabase exposes `ezbr_sha256` per Edge Function,
but that hashes *Supabase's built bundle*, not our source tree — it is not
derivable from the repository, so a deployed function's live bytes cannot be
recomputed and compared. Version counters are per-project and monotonic and
say nothing about content (Phase 1: `scan-identify` at v4 on staging vs v141 on
production is not drift).

So each governed component carries an explicit attestation class:

| Class | Meaning |
|---|---|
| `EXACTLY_DEPLOYED_FROM_FROZEN_CANDIDATE` | in this run's delta; bytes traced from the frozen candidate through to the receipt |
| `CARRIED_FORWARD_FROM_PREVIOUS_VERIFIED_STATE` | not redeployed; rests on a prior verified baseline whose recorded hash still matches |
| `UNATTESTED` | neither — reported, never silently accepted |

When any governed component is `UNATTESTED` because no prior verified baseline
exists, the verifier returns **`FULL_RUNTIME_ATTESTATION_GAP`**, which blocks
`STAGING_VERIFIED`. **This is the expected result for the first release through
this system**: there is nothing earlier to carry forward from, and inventing a
baseline would be fabricated provenance. The first activation run establishes
the baseline that later runs carry forward.

## Why `/version` is not sufficient on its own

Release identity metadata (`KSCAN_RELEASE_ID`, `KSCAN_SOURCE_SHA`,
`KSCAN_SOURCE_TREE_SHA`, `KSCAN_MANIFEST_DIGEST`,
`KSCAN_HEALTH_CONTRACT_VERSION`, `KSCAN_DEPLOYED_AT`) is **corroborating
evidence**, not proof: it is configuration, and configuration can be set to
say anything. It is only meaningful in combination with the frozen manifest,
the immutable candidate source, and the receipt. A deployment that cannot
state its identity reports `NOT_VERIFIABLE` rather than defaulting to
something plausible.

Liveness deliberately does **not** depend on release identity — an
unidentified deployment is still a running deployment, and conflating the two
would make a metadata gap look like an outage.

## `STAGING_VERIFIED` is release-scoped

It asserts: *the exact frozen candidate was deployed to staging and passed
every applicable release-content and operational gate.*

It does **not** assert that every environment capability required for
production is enabled. That distinction is what makes the state reachable at
all: `leaked_password_protection` requires the Supabase Pro plan and returns
HTTP 402 on the free plan, so no change to any release candidate can clear it.
Policy therefore normalizes it as:

| | |
|---|---|
| scope | `ENVIRONMENT` |
| disposition | `OWNER_EXTERNAL_ACTION_REQUIRED` |
| releaseContentBlocking | `false` |
| stagingVerifiedBlocking | `false` |
| **productionPromotionBlocking** | **`true`** |

This is a targeted, evidenced exception — **not** a general downgrade of
security findings. Anything not explicitly classified in
`staging-release-verification-policy.json` **fails closed**
(`stagingVerifiedBlocking: true`) until a human classifies it.

## One authority

The existing staging certification remains the environment-level authority and
is consumed as an **input**. This system does not re-run or second-guess it;
it normalizes its findings into release scope and emits one release verdict.
Duplicating certification would recreate exactly the competing-authority
defect DEF-REL-006 removed.

## `STAGING_VERIFIED` does not imply production eligibility

They are separate gates by construction: `canEnterStagingVerified()` never
consults production eligibility, and `production-eligibility.js` keeps every
blocker it had — `LAST_KNOWN_GOOD_UNKNOWN`,
`PRODUCTION_SOURCE_PROVENANCE_UNKNOWN`,
`PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED`, and the no-PITR risk-class
blockers.

## What release smoke does not cover

- **Account deletion lifecycle** — the only meaningful end-to-end test is
  destructive. It stays a human-run, owner-approved procedure under
  `docs/account-deletion-e2e-gate.md`; running it per release would create
  real deletions.
- **Production** — release smoke refuses any non-staging project before its
  first request.

Categories that cannot be exercised safely report `NOT_APPLICABLE` with a
reason. A **required** category can never degrade that way — without
credentials it reports `OPERATIONAL_FAILURE` and blocks.

## Evidence retention

Per the Phase 2A policy: schemas, policies, generators and validators live in
Git; frozen manifest instances, receipts, health results, smoke results and
normalized evidence are CI artifacts named
`backend-release-<releaseId>-<shortSha>-<runId>`. No credentials, no user
data. A receipt is deep-frozen and digest-stamped at finalization; a retry
mints a new attempt rather than editing prior evidence.

## Not yet activated

This is the build pass. No staging deployment has been performed, no staging
function environment metadata has been set, and `staging-health` has not been
redeployed. Those are the next, separately-approved activation step.
