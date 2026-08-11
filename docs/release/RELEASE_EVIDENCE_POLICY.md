# Release Evidence Retention Policy

Status: policy, Phase 2A. The upload/publication workflow that implements it
is deliberately **not** built yet.

This supersedes the Phase 1 discovery suggestion that generated staging
certification JSON should be committed to Git. It should not be. That
proposal was withdrawn on manager review, and the reasoning is recorded below
so it is not re-proposed later.

## Why not commit run evidence

A staging certification run produces a verdict about **one execution against
one live environment at one moment**. Committing each run's JSON to Git would:

- grow the repository without bound with records that are never read again;
- create a second, competing source of truth next to the CI artifact that
  actually produced the run;
- invite the failure mode where someone edits a committed "evidence" file,
  which silently converts evidence into an assertion;
- blur the line between *what the code is* (a repository's job) and *what
  happened when we ran it* (a run log's job).

Immutability is the property that matters for run evidence, and a CI artifact
store provides it better than a mutable working tree does.

## The three tiers

### 1. Source control — code, schemas, policy

Committed to Git, reviewed like code, changes deliberately:

- `security/release/release-state-machine.js` and
  `security/release/schemas/release-state.schema.json`
- `security/release/generate-release-manifest.js`,
  `security/release/config-fingerprint.js`
- `security/release/classify-migration-risk.js` and
  `security/release/migration-risk-classifications.json`
- `security/release/migration-baseline.json`
- `security/release/edge-function-governance.json`
- `security/release/backup-capability-policy.json`
- `security/release/production-migration-reconciliation.json`
- `security/release/last-known-good.js`,
  `security/release/production-eligibility.js`
- `security/scripts/lib/environment-authority.js`,
  `security/scripts/lib/secret-shape-guard.js`
- the documents in `docs/release/`

These describe **rules and classifications**, not run outcomes. They are
exactly the things that *should* be diffable and reviewable.

### 2. CI artifacts — immutable run evidence

Produced per run, retained by the CI artifact store, never committed:

- staging certification JSON (`security/reports/staging-certification.json`,
  already artifact-only today — `security/reports/` holds only a `.gitkeep`)
- generated release manifests and freeze records for a given candidate
- deploy/rollback result records
  (`deploy-result.json`, `rollback-result.json`, etc.)
- scanner reports (Gitleaks, Semgrep, OSV, Trivy, npm audit, ZAP)
- promotion decision records (`release-decision.json`)

The existing workflows already follow this pattern. Phase 2A adds no new
artifact-producing workflow and changes no retention setting.

### 3. Durable release record — small, governed, promoted identity only

A deliberately tiny committed record, written only when a release actually
reaches a promoted state:

- the release identity: `releaseId`, `sourceSha`, `sourceTreeSha`,
  `identityDigest`, `configFingerprint`
- the Last Known Good record, once one legitimately exists
- a pointer (run id / artifact URL) to the immutable CI evidence that
  justified it

This is the bridge between tiers 1 and 2: durable enough to answer "what is
production supposed to be running," small enough not to become a log.

**Today this tier is empty by design.** `security/release/lkg/` does not
exist, and Phase 2A's tests assert it does not — there is no verified
production release to record, and manufacturing one would be exactly the
fabrication the Last Known Good rules exist to prevent.

## Content rules (all tiers)

- **No credentials.** Secret *names* are fine and expected; secret *values*
  never appear. `security/scripts/lib/secret-shape-guard.js` enforces this
  programmatically on manifests and state-transition records, and the
  config fingerprint hashes env var presence rather than contents
  specifically so a low-entropy secret can never be brute-forced back out of
  a published digest.
- **No user data.** Release evidence describes infrastructure state, never
  the rows inside it. This matters especially for the staging project, which
  carries real protected website-heritage data
  (see `docs/release/ENVIRONMENT_AUTHORITY.md`).
- **No fabricated provenance.** If something is unknown, it is recorded as
  UNKNOWN. Every current unknown in this system
  (production source SHA, production migration provenance, Last Known Good)
  is recorded that way rather than filled with a plausible guess.

## What is not built yet

The evidence-upload workflow, artifact retention configuration, and the
durable-record writer are all future phases. This document defines where
each kind of evidence belongs so those phases do not have to relitigate it.
