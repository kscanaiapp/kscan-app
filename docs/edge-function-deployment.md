# Edge Function deployment — approved path

Status: authoritative as of Phase 2A.5 (IMG-006).
Applies to: `scan-identify`, `stylechat-generate`.

## Why this document exists

The Phase 2A image-identification audit established two facts:

1. The deployed production bundles (`scan-identify` v139, `stylechat-generate`
   v82, project `wyyuqfdxucjksghsmhry`) content-match the **Android** branch
   function trees.
2. The iOS branch carried a different, fully deployable copy of both functions,
   and nothing in the repository or the documented workflow would have stopped
   `supabase functions deploy scan-identify` from shipping it.

Older runbooks in `docs/` printed raw `supabase functions deploy …` commands.
Those commands were correct about *what* to deploy but silent about *from
where*, which is exactly how a stale tree reaches production. They now defer to
this document.

## Canonical source

The **Android** line is canonical for the governed functions. Both platform
branches carry byte-identical copies of:

- `supabase/functions/scan-identify/**`
- `supabase/functions/stylechat-generate/**`
- the shared modules those bundles import
- `supabase/config.toml` (project reference and per-function `verify_jwt`)

Equality is not maintained by convention. It is enforced by
`config/edge-function-manifest.json`, which records a SHA-256 for every file in
each governed function tree and marks which of them are actually reachable from
the function entry point.

## The approved command

```bash
node scripts/deploy-edge-functions.js --function scan-identify
```

That is a **dry run**. It verifies everything and deploys nothing. To actually
deploy, the function must be named twice — once as the target and once as an
explicit confirmation:

```bash
node scripts/deploy-edge-functions.js --function scan-identify --confirm-deploy scan-identify
```

The wrapper runs six gates in order and stops at the first failure:

| Step | Gate | Fails when |
|---|---|---|
| 1 | manifest currency | the committed manifest does not describe this working tree |
| 2 | project reference | `supabase/config.toml` does not declare `wyyuqfdxucjksghsmhry` |
| 3 | tree + bundle parity | any governed file is missing, added, moved between bundle/tree, or has a different hash |
| 4 | working-tree cleanliness | anything under `supabase/functions` is uncommitted |
| 5 | provenance report | — (prints Git SHA, branch, project, tree hash, bundle hash) |
| 6 | explicit confirmation | `--confirm-deploy <name>` was not supplied |

Deployment is an owner-authorized release action. **Verification is not
authorization.** A passing dry run means the source is safe to deploy, not that
it has been approved for deployment.

## Do not deploy directly

Do not run `supabase functions deploy scan-identify` or
`supabase functions deploy stylechat-generate` by hand. A raw CLI invocation
performs none of the six checks above and can ship any checkout.

This is a documentation and tooling boundary, not a technical impossibility: a
user with the Supabase CLI and credentials can still bypass the wrapper. What
the repository now guarantees is that

- both checked-in copies are identical and hash-pinned,
- the full test suite fails on any future drift, and
- no repository documentation instructs an unguarded deploy.

## After an intentional backend change

1. Make the change on the canonical (Android) tree.
2. Regenerate the manifest:
   ```bash
   node scripts/generate-edge-function-manifest.js
   ```
3. Mirror the changed function files **and** the regenerated manifest onto the
   iOS branch.
4. Confirm both branches report `EDGE FUNCTION PARITY: PASS`:
   ```bash
   node scripts/check-edge-function-parity.js
   ```
5. Commit on both branches. The manifest's `parity` section is a pure function
   of repository content and must be byte-identical across branches; the
   `provenance` block (timestamp, Git SHA) differs per branch by design and is
   excluded from every comparison.

## Drift detection

`__tests__/edgeFunctionSourceParity.test.js` runs as part of the standard full
suite (`npm run test:all`), so drift fails the same gate every release already
runs. It also proves the gate is not merely decorative by mutating throwaway
copies of the function trees in the OS temp directory and asserting each drift
shape fails: modified bundle file, modified non-deployed tree file, missing
shared module, unexpected extra file, wrong project reference, missing
`config.toml`, and a stale manifest.

Focused invocation:

```bash
npm run verify:edge-parity
```

## Scope and known gaps

The manifest governs the two image-identification functions only. The following
are **not** covered and remain open owner decisions:

- **Ungoverned functions.** Twelve other Edge Functions exist. Run
  `node scripts/check-edge-function-parity.js --report-ungoverned` to list them.
  Known cross-branch divergence: `handle-user-deletion` and
  `_shared/deletion/userDataResources.ts` differ, `process-account-deletions`
  exists only on the Android line, and `style-outfit-generate` differs. Bringing
  the account-lifecycle family under the gate is account-safety work and was
  deliberately not attempted in a clean-frame phase.
- **iOS-only orphaned source.** `supabase/functions/_shared/aiSecurity/**` (12
  files) exists only on the iOS branch and has **zero importers anywhere in the
  repository**. It is not part of any deployed bundle. It was left in place
  rather than deleted, because adopting or removing prompt-hardening code is a
  backend-owner decision, not a synchronization side effect.
- **Non-production project references.** This deploy wrapper is the production
  path: step 2 asserts the checkout resolves to the **production** environment
  via `assertExpectedEnvironment('production', …)` in
  `security/scripts/lib/environment-authority.js`. A staging checkout, an
  unknown ref, a malformed ref, and a missing `supabase/config.toml` all abort
  before anything deploys. Deploying a governed function to staging through
  this wrapper is therefore blocked, and changing that is an owner decision.
  Note that the *source-parity gate* (`check-edge-function-parity.js`) is
  deliberately environment-neutral and passes on either environment — it
  certifies artifact identity, not deploy targets. See
  `docs/release/ENVIRONMENT_AUTHORITY.md` and defect DEF-REL-006.
- **Runtime verification.** The gate compares repository source. It does not and
  cannot confirm what is currently running in production; that comparison was
  performed once, read-only, during Phase 2A.
