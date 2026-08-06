# Phase 7 clothingType — staging deployment & verification handoff

Integration branch: `integration/scanner-phase7-prestaging`
Baseline: `product-match/foundation-v1` @ `f3f704a`
Target staging project: `yzqjvdfgefveprobvvyw`
Production project (never touch from this candidate): `wyyuqfdxucjksghsmhry`

This document is a **preparation artifact**. Nothing in it has been executed.
No staging deployment, migration, or live scenario run has happened. See
Section "Evidence limitations" at the end.

## Responsible party

**Staging Deployment Lead / Owner.** No individual is named here because none
was specified for this task; do not infer one.

## 1. What ships in this candidate

Edge Functions to (re)deploy on staging:

- `scan-identify` — carries the `clothing_type` prompt/schema/parser/normalizer
  overlay, the multi-item selection suppression fix, and the product-match
  bridge fix.
- `product-match` — carries the `clothingType` query/existingItem contract
  field. **Check staging function state before deploying**: per
  `productMatchBridge.ts`'s own documentation, `product-match` was not yet
  deployed anywhere as of the `product-match/foundation-v1` baseline this
  candidate branched from. If staging has never had `product-match` deployed,
  this is a first-time deploy there, not an update — treat it accordingly
  (secrets, RLS, and the `PRODUCT_MATCH_INTERNAL_SECRET` gate all need to
  exist before the function will do anything but reject every call).
- `stylechat-generate`, `style-outfit-generate` — unaffected by this
  candidate (present in the governed manifest, not touched by any commit in
  this integration branch; redeploy only if staging is otherwise behind).

Migrations: **none required by this candidate.** `clothingType` is not
persisted in any new column — the V2 identification result already rides
inside the existing JSONB response payload, and `contracts/*.schema.json`
changes are documentation/governance artifacts, not database schema. This
candidate does not touch `supabase/migrations/`.

Note (pre-existing, not caused by this candidate): the repository's
migration history is known to have diverged from what's applied in some
environments (see prior session notes on migration-history divergence). Do
not run `supabase db push` as part of this deployment without first
resolving that separately — it is out of scope for this candidate and an
owner decision, not something to infer.

## 2. Environment variables / secrets required on staging

| Variable | Scope | Purpose |
|---|---|---|
| `SCAN_PRODUCT_MATCH_ENABLED` | `scan-identify` | Default `false`. Set `true` on staging to exercise the bridge. |
| `SIMILAR_ITEM_ENABLED` | `scan-identify` (via `scanJourneyContract.ts`) | Default off. Set `true` to exercise the advisory-similarity scenarios. |
| `PRODUCT_MATCH_INTERNAL_SECRET` | both `scan-identify` and `product-match` | Service-to-service auth for the bridge hop. Must be the SAME value on both functions. Generate a staging-only value; never reuse the production secret. |
| `SUPABASE_URL` | `scan-identify` | Already set by the platform; the bridge reads it to build the internal call URL. |

No other new environment variables are introduced by this candidate.

## 3. Feature flags and rollback

| Flag | Controls | Off behavior |
|---|---|---|
| `SCAN_PRODUCT_MATCH_ENABLED` | product-match bridge | No fetch attempted at all (proven in `scanJourneyContract.test.ts`: "a disabled bridge makes no fetch at all"). Legacy scanner response only. |
| `SIMILAR_ITEM_ENABLED` | advisory `potentialSimilarItem` | Notice omitted; primary identification unaffected. |

`clothingType` itself has **no dedicated flag** — it is an additive V2 field
gated only by the V2 contract's own existence, matching `category`/`subtype`.
Rollback for a `clothingType` regression is a function redeploy to the prior
manifest-pinned SHA, not a flag flip.

Rollback commands (once a staging deploy exists to roll back FROM):

```bash
# Identify the currently-deployed source SHA from the manifest already on staging
cat config/edge-function-manifest.json   # "source Git SHA" field

# Roll back scan-identify / product-match to the pre-Phase-7 commit
git checkout f3f704a -- supabase/functions/scan-identify supabase/functions/product-match
node scripts/generate-edge-function-manifest.js
node scripts/generate-cross-path-parity-manifest.js
supabase functions deploy scan-identify --project-ref yzqjvdfgefveprobvvyw
supabase functions deploy product-match --project-ref yzqjvdfgefveprobvvyw
git checkout integration/scanner-phase7-prestaging -- supabase/functions/scan-identify supabase/functions/product-match
```

No rollback here requires a mobile release — every change in this candidate
is backend-controlled.

## 4. Exact execution steps (owner-run, not run by this task)

```bash
# 1. From the integration branch, confirm the tree is exactly what was tested
git -C /path/to/worktree status --short          # expect clean
git -C /path/to/worktree log --oneline -1        # expect the final commit of integration/scanner-phase7-prestaging

# 2. Regenerate and verify both governed manifests one more time
node scripts/generate-edge-function-manifest.js --check
node scripts/generate-cross-path-parity-manifest.js --check

# 3. Set staging secrets (owner's staging Supabase project, NOT production)
supabase secrets set PRODUCT_MATCH_INTERNAL_SECRET=<staging-only-value> --project-ref yzqjvdfgefveprobvvyw
supabase secrets set SCAN_PRODUCT_MATCH_ENABLED=true --project-ref yzqjvdfgefveprobvvyw
supabase secrets set SIMILAR_ITEM_ENABLED=true --project-ref yzqjvdfgefveprobvvyw

# 4. Deploy
supabase functions deploy scan-identify --project-ref yzqjvdfgefveprobvvyw
supabase functions deploy product-match --project-ref yzqjvdfgefveprobvvyw

# 5. Obtain a staging user JWT (real staging account, not fabricated)
#    — however this project's existing staging auth flow works.

# 6. Run the verification script
SUPABASE_URL=https://yzqjvdfgefveprobvvyw.supabase.co \
STAGING_USER_JWT=<staging-user-jwt> \
node scripts/verify-phase7-staging.js

# 7. Read the printed classification: ALL_TESTS_PASSED / PARTIAL_PASS_WITH_GAPS / FAILED
```

Fixture setup: `qa/phase7-staging-fixtures/scenarios.js` — 8 deterministic
scenarios (`NO_NOTICE`, `CLOSET_SIMILARITY`, `RECENT_SCAN_SIMILARITY`,
`MULTI_ITEM_SELECTION_REQUIRED`, `SELECTED_ITEM_FOLLOWUP`,
`UNCERTAIN_CLOTHING_TYPE`, `PRODUCT_MATCH_TIMEOUT`, `FEATURE_FLAG_ROLLBACK`).
Two of them (`MULTI_ITEM_SELECTION_REQUIRED`, `SELECTED_ITEM_FOLLOWUP`) need
a real multi-garment image and a chained selection token respectively — the
fixture documents this rather than faking a deterministic outcome the
provider does not actually guarantee.

Result artifact location: script output to stdout; redirect to a file per
run, e.g. `node scripts/verify-phase7-staging.js > qa/phase7-staging-fixtures/runs/$(date +%Y%m%d-%H%M).log`
(directory not created by this candidate — create it on first real run).

## 5. Evidence to capture during the real run

- Full stdout of `verify-phase7-staging.js` (includes per-scenario latency,
  product counts, feature-flag state, and the final classification line).
- `supabase functions list --project-ref yzqjvdfgefveprobvvyw` output
  (Edge Function versions actually live).
- The environment identity line the script prints (`identity confirmed:
  staging project yzqjvdfgefveprobvvyw`) — proof no production call occurred.
- Raw scan-identify and product-match responses for at least one scenario of
  each kind, for manual contract review.
- Rollback proof: re-run with `SCAN_PRODUCT_MATCH_ENABLED=false` and
  `SIMILAR_ITEM_ENABLED=false`, confirm `FEATURE_FLAG_ROLLBACK` still passes
  and no other scenario regresses.

## 6. Success marker

Classify the staging run `READY_FOR_BUILD_CANDIDATE` only when **all** of:

- `verify-phase7-staging.js` prints `ALL_TESTS_PASSED`.
- No P0 or P1 issue remains open.
- V1 compatibility passes (already proven locally; staging run should not
  contradict it).
- `clothingType` survives the full deployed path (locally proven; staging
  run confirms against a live provider).
- Primary scanner behavior is intact for every scenario.
- Product matching remained fail-open in `PRODUCT_MATCH_TIMEOUT`.
- Rollback proof (item 5, last bullet) succeeded.
- Accuracy/latency/cost gates the owner separately approves are satisfied —
  this candidate makes **no claim** on any of those; see Evidence
  limitations.

## 7. Blocker escalation (if staging returns FAILED)

1. Reset `SCAN_PRODUCT_MATCH_ENABLED` and `SIMILAR_ITEM_ENABLED` to `false`
   on staging.
2. Roll back the affected Edge Function(s) using Section 3's commands.
3. Preserve the full script output and `supabase functions list` output.
4. Classify the first failing contract boundary using the stage names in
   `supabase/functions/scan-identify/phase7PipelineSurvivability.test.ts`
   (parser / normalizer / endpoint wrapping / bridge / product-match /
   selection suppression / V1) as a starting vocabulary — the live failure
   is almost certainly at a boundary the local harness cannot reach
   (provider behavior, real network conditions, staging-only config).
5. Do not proceed to a mobile build or production change.

## Evidence limitations

- **No live staging test has occurred.** This document and
  `verify-phase7-staging.js` were authored and dry-run tested only.
- **No provider accuracy test has occurred.** Nothing in this candidate
  measures or claims clothingType answerability, accuracy, or any effect on
  identification quality.
- **No production deployment or mutation has occurred.**
- Accuracy, latency, truncation, matching quality, and cost remain entirely
  unproven and are marked `DEFERRED TO STAGING / LIVE EVALUATION` throughout.
- Product-count baselines for every scenario are `not_yet_measured` — the
  first live run must record one before any count deviation can be
  classified as more than "observed."
