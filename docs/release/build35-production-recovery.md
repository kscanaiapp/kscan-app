# Build 35 Production function recovery

The original workflow uploaded deployment metadata without the captured function bytes. Its rollback job used a different runner and could not restore the prior bundle. Review also found incomplete sibling dependency capture, unreadable inventories treated as empty, failed child stderr exposure, and weak recovery verification.

## Governed promotion

The Production environment reviewer gate remains mandatory. The agent must never approve its own request. The candidate deploys only `scan-identify`, preserves `verify_jwt=false`, and applies no migration. Scanner runtime source is unchanged by this repair.

Before replacement the protected deployer:

1. Reads a valid live inventory and captures all returned function and shared dependency files, their original layout, entrypoint, per-file hashes, tree digest, version and JWT posture. Unexpected files outside that tree, symlinks, missing entrypoints and unreadable metadata refuse replacement.
2. Checks Storage RLS is enabled and the access-policy inventory matches the reviewed six policies. All six restrict access to other named user-media buckets; no policy permits this recovery bucket. Policy drift refuses replacement and requires a new review, rather than adding a grant.
3. Uses the existing protected management token to retrieve an existing server key in memory. It does not generate, print or persist credentials. Creates `production-function-recovery` private if absent, with a 20 MiB JSON object limit; never changes Storage policies or makes a public bucket private silently.
4. Writes a portable recovery package and interruption reference to that private bucket, downloads and hash-validates the package, tests reconstruction, and confirms public and publishable-key access is denied. These steps must succeed before any function replacement.
5. Rechecks the live prior version, digest and JWT posture immediately before replacement. Replacement attempts, including ambiguous CLI failures, enter the automatic recovery path.
6. Verifies deployed version, bundle digest, ACTIVE status and JWT posture, runs bounded provider-free auth/error/health probes, and runs deterministic contract/recovery fixtures on the same runner. A failure attempts rollback and emits a failed deployment result even when recovery succeeds.

The additional private-bucket creation and recovery-package writes are explicitly included in the preapproval plan. GitHub artifacts contain sanitized records and private object references only. Function source and credentials are never uploaded there. Restore CLI output and capture child stderr are withheld on failure.

Restoration downloads private recovery material on its own runner, validates package and file hashes, stages the original function/shared layout and original entrypoint, redeploys the original JWT setting, downloads the live restored source to compare its tree digest, and performs bounded health/auth checks. A deleted new function must be absent in a readable live inventory. Critical failures emit a recovery record and require stopping further promotions.

## Interrupted or cancelled workflow

Automatic recovery cannot be guaranteed after runner termination or workflow cancellation. The private package and its reference are persisted before replacement and require no files or artifacts from the interrupted runner.

An authorized human checks the failed run and current live identity, then dispatches `K Scan Protected Function Recovery` from the current backend authority tip, supplying the original run ID, run attempt and source SHA, and the exact confirmation `RESTORE PRODUCTION CAPTURE`. It shares the promotion concurrency group and requires Production environment approval. Never approve recovery using the agent execution identity. Never select an old capture without checking whether a subsequent promotion superseded it.

The recovery workflow retrieves the private reference by run/attempt/SHA, validates and restores using only private Storage. Review the sanitized recovery result and downloaded-source/JWT verification before another promotion. Keep private recovery objects for the approved recovery window; do not publish signed download URLs or delete recovery objects while an incident remains unresolved.

## Certification boundary

Provider-free probes contain no image, search evidence or text query. They check reachability, unauthorized commerce rejection, malformed JSON and unsupported contract errors. They do not prove an authenticated paid Scanner transaction or physical old-client behavior. Authorized actors, exact live store identities and an approved provider allocation remain necessary for those checks. Paid provider allocation for this pass is zero.

The deterministic suite covers ROLLBACK-01 through ROLLBACK-10, including sibling dependencies/assets, fresh-runner reconstruction, corruption/missing files, both JWT settings, post-write failures, foreign projects, success without rollback, critical recovery failure, private storage and stderr confidentiality, and interrupted-run recovery. Local mocks never replace or deliberately break the live function.
