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
`STAGING_VERIFIED`. There is nothing earlier to carry forward from, and
inventing a baseline would be fabricated provenance.

> ### `FULL_RUNTIME_ATTESTATION_GAP` ≠ VERIFIED BASELINE
>
> **Corrected in Phase 2B.1 (DEF-REL-009).** An earlier draft of this document
> said "the first activation run establishes the baseline that later runs carry
> forward." **That was wrong, and the code that made it true was a provenance
> laundering path.** A run that ends in `FULL_RUNTIME_ATTESTATION_GAP` did not
> verify anything, so it cannot become a trust root for anything.

## How the first trust root is actually created

1. A normal first **change-scoped** activation with no prior baseline may
   legitimately return `FULL_RUNTIME_ATTESTATION_GAP`.
2. **That run does NOT create a verified trust root.** No baseline is minted,
   and the next release still has nothing to carry forward.
3. The first trust root requires an explicit, one-time
   **`BOOTSTRAP_FULL_ATTESTATION`** release, which redeploys every
   already-live, staging-applicable `GOVERNED` function from the frozen
   candidate so each becomes `EXACTLY_DEPLOYED_FROM_FROZEN_CANDIDATE`.
4. That bootstrap release must itself reach **`STAGING_VERIFIED`**.
5. **Only then** may a verified baseline be minted, and only then may later
   normal change-scoped releases carry unchanged components forward.

`BOOTSTRAP_FULL_ATTESTATION` is an **initialization exception, not a
deployment model.** It refuses to run when a baseline already exists, outside
staging, against an unknown or missing project identity, on an invalid freeze,
or when candidate binding failed.

**Bootstrap is not an installer.** It compares the governed inventory against
the *live* staging Edge Function inventory and, if a governed function is not
already running, stops with
`BOOTSTRAP_LIVE_INVENTORY_RECONCILIATION_REQUIRED` rather than installing it —
a provenance mechanism must never change what the backend *is*. Quarantined,
heritage-unmanaged and excluded surfaces are structurally unreachable from the
plan. Migrations are never replayed to manufacture trust; database provenance
comes from the manifest inventory plus live migration-state verification.

## What minting a baseline requires

`mintVerifiedBaseline()` refuses unless **all** of the following hold, and
returns no partial baseline and no warning-level downgrade:

- manifest, freeze record, finalized receipt, exact verification and release
  evidence all present
- receipt integrity validates against its own digest
- release ID, source SHA, source tree SHA and manifest digest agree across
  freeze, receipt and manifest
- `exactCandidateVerification.result === PASS`
- **zero** `UNATTESTED` governed components
- `releaseEvidence.stagingVerifiedEligible === true`
- `canEnterStagingVerified(releaseEvidence).allowed === true`

## What `baselineDigest` does and does not prove (DEF-REL-010)

> An earlier version of this document claimed "a hand-written,
> baseline-shaped object fails the digest check." **That was wrong.** It is
> only true of an attacker who forgets to recompute the digest.

`baselineDigest` is an **unkeyed SHA-256 over the baseline's own content**. It
proves the object is internally consistent — that nobody edited a field and
left the checksum stale. It does **not** prove the object was produced by
`mintVerifiedBaseline`, and it does **not** prove it came from a
`STAGING_VERIFIED` release. Anyone can construct a baseline-shaped object with
plausible identity and well-formed 64-hex hashes and then compute a perfectly
valid digest over their fabrication.

```
baselineDigest / evidenceDigest  =  INTEGRITY / CONSISTENCY
NOT                                 AUTHENTICITY / PROVENANCE
```

Phase 2B introduces **no HMAC key, signing key or PKI**, so there is no
cryptographic authenticity here and this system does not claim any. The
operational provenance source remains the immutable CI release-evidence
artifact.

## Carry-forward requires corroboration, not a checksum

Because a checksum cannot establish origin, a baseline **never authorizes
carry-forward on its own**. It must be presented together with the
authoritative release evidence it was minted from, and the two must agree:

| Cross-check | Both must state the same |
|---|---|
| `baseline.releaseEvidenceDigest` | `evidence.evidenceDigest` (itself re-verified) |
| `releaseId` | `evidence.release.releaseId` |
| `sourceSha` / `sourceTreeSha` | `evidence.release.*` |
| `manifestDigest` | `evidence.release.manifestDigest` |
| `receiptDigest` | `evidence.deployment.receiptDigest` |
| component hashes + attestations | `evidence.exactCandidateVerification.components` |

and the prior evidence must itself show a genuinely verified release:
`stagingVerifiedEligible === true`, `stagingVerifiedDecision().allowed`, a
verdict of `PASS` or `PASS_WITH_REPORT_ONLY_FINDINGS`, and
`exactCandidateVerification.result === PASS`.

**A standalone baseline JSON authorizes nothing**, however well-formed and
however correctly checksummed. Supplying evidence without a baseline, or a
baseline whose evidence disagrees on any field above, is refused the same way.
A rejected pair carries **nothing** forward — its components fall through to
`UNATTESTED`, never partially. Changed code is never carried forward either: a
governed component whose source moved must be redeployed to be attested.

## Bootstrap staging applicability

`class` governs **release inclusion**; `environments` governs **deploy
targeting**. They are independent axes, and the bootstrap needs both:

| Entry | Staging-applicable? |
|---|---|
| `GOVERNED`, no `environments` (shared) | yes |
| `GOVERNED`, `environments` includes `staging` | yes |
| `GOVERNED`, `environments` excludes `staging` (e.g. production-only) | **no** |
| `QUARANTINED` / `HERITAGE_UNMANAGED` / `EXCLUDED_WITH_REASON` / unknown | **never**, whatever `environments` says |

A production-scoped `GOVERNED` function must not be demanded by a staging
bootstrap — it is not live on staging, so requiring it would halt the
bootstrap with a spurious reconciliation error.

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

## Activation pipeline (Phase 2B.3)

Phase 2B built the verification model; **Phase 2B.3 built the executable path
that runs it** (DEF-REL-012). Entry point:
`security/release/run-bootstrap-activation.mjs`, driven by
`.github/workflows/staging-release-bootstrap.yml` (`workflow_dispatch` only).

### Ordering is a trust property, not a convenience

Supabase release metadata reaches Edge Functions independently of a code
deploy. If metadata were written first, `/version` would advertise a release
that is not yet running. The order is therefore fixed:

1. deploy every governed function **except** `staging-health`
2. **all** must PASS — a single failure stops here, and no metadata is written
3. write the six allowlisted `KSCAN_*` values
4. deploy `staging-health` **last**, from the same frozen candidate

`staging-health` is deployed last precisely because it is the surface that
reports release identity: it must not claim a release until the release exists.

### Release metadata is narrow by construction

`security/release/set-staging-release-metadata.mjs` may write exactly six keys
— `KSCAN_RELEASE_ID`, `KSCAN_SOURCE_SHA`, `KSCAN_SOURCE_TREE_SHA`,
`KSCAN_MANIFEST_DIGEST`, `KSCAN_HEALTH_CONTRACT_VERSION`, `KSCAN_DEPLOYED_AT`
— against a static allowlist. It is **not** a general secret manager. The
production project is an explicit deny checked before any command is built,
and `SUPABASE_ACCESS_TOKEN` reaches the CLI through the environment only, never
as an argv element and never into evidence.

### Identity semantics of the metadata

The six keys are **not** in `ENV_NAME_ALLOWLIST`, so neither their presence nor
their values affect `configFingerprint` or `identityDigest` — a manifest frozen
before the write still describes the candidate after it. `releaseId` is
observational and never hashed.

One hazard worth naming: the legacy `KSCAN_DEPLOY_VERSION` **is** allowlisted,
so introducing it into the *generator's* environment would shift the digest
between PLAN_ONLY and EXECUTE. The orchestrator never sets it. Note also that
the fingerprint reads the generator's environment (the CI runner), not the
Supabase function runtime — it describes build-time configuration structure.

### Modes

`PLAN_ONLY` is read-only: no Supabase write, no deploy, no metadata, no tag.
`EXECUTE` requires `GITHUB_ACTIONS=true` **and**
`KSCAN_ACTIVATION_ENVIRONMENT=staging`, so a laptop run fails closed rather
than bypassing the environment's protection rules and audit record.

### Durable persistence

The baseline + evidence pair is published as a **staging prerelease** tagged
`staging-verified-<shortsha>-<releaseId>`, anchored to the verified commit.
Evidence is deliberately **not** committed to `staging/production-parity`:
committing it would move the source tree after the release was verified, so
the verified SHA would no longer be branch HEAD. The tag prefix cannot collide
with mobile/app version tags.

Nothing durable is created until verification has already succeeded, and
persistence only reports PASS after the uploaded assets are read back and their
digests re-checked. If persistence fails, the run returns
`VERIFIED_BASELINE_PERSISTENCE_GAP` — the release may be verified in runtime
evidence, but it is not retrievable for carry-forward, so activation is not
complete.

**These assets are durable operational evidence, not cryptographic
authenticity.** They are not signed, not immutable, and not WORM storage; an
admin can delete or replace them. What retrieval guarantees is that a tampered
package cannot silently authorize carry-forward — digests are recomputed, the
tag must point at the expected commit, and baseline and evidence must
corroborate under the Phase 2B.2 rules. Signing and attestation are Phase 3.
