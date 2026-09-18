# Build 34 — pre-migration backend hostile audit ledger

Campaign: find and repair Build 34 backend defects **before** environment migration.
Runtime environment: **staging only**.

| Authority | Value |
|---|---|
| Release authority | `release/kscan-pre-freeze-v1` @ `c6ee31adb0932d4d476cc218c1a7bff434b10bc8` |
| Backend deployment authority | `rebuild/backend-authority-v2` @ `1158000144525aafd16d58e69a127d05a00d9922` |
| Staging project | `yzqjvdfgefveprobvvyw` (K Scan AI Staging, us-west-1) |
| Repair branch | `claude/relaxed-noether-zqp4rl` (based on the release authority) |

Both expected SHAs matched on re-verification; neither had advanced.

**Production was not accessed, queried, inspected, deployed to, or modified at any
point.** The production project ref was resolved once, from the project list, for
the sole purpose of never addressing it.

---

## Authority reconciliation

The two authorities have **diverged**: neither is an ancestor of the other
(merge-base `e1bc6056`; 54 commits backend-only, 118 release-only). Content-wise
the Build 33 hardening reached the release line — `20260916125206` (RPC privilege
convergence) and `20260916130553` (orphan-owner media RPC) are present in both,
`scan-identify/index.ts` and `reconcile-orphan-media/index.ts` are byte-identical
across them. The divergence is in the governance manifests, not the shipped
backend. Recorded as **B34-GOV-001**.

Migration ledger reconciliation (staging 167 applied vs release 168 files):
28 staging-only versions are **renumbered equivalents** of release files (the
deploy tool stamps its own timestamp — the project's established convention), and
the two apparent gaps resolve cleanly:

- `20260805170417_legal_acceptances_add_ai_processing.sql` — not in the ledger,
  but the effective `legal_acceptances_acceptance_type_check` constraint **does**
  include `'ai_processing'`. Effective state correct; provenance unrecorded.
- `20260809120000_contribution_block_enforcement.sql` — not applied, and
  `can_contribute_to_dressing_room` does not exist on staging. This is correct:
  the feature it backs lives in `supabase/migrations-deferred/` behind
  `SHARED_ROOM_CONTRIBUTIONS_V1` (default off, set in no build profile), and the
  deferral is documented. **DISPROVEN** as a defect.

---

## Findings

### B34-SEC-001 — P2 — authorization — `FIXED_STAGING_VERIFIED`

`public.get_item_reaction_counts(uuid[])` is `SECURITY DEFINER`, granted to `anon`
and `authenticated`. Its non-owner branch tested only whether the room **has** a
live share, never whether the caller **holds** it — so that one predicate was the
entire authorization boundary for every non-owner.

Proven on staging against synthetic fixtures, with the table's own RLS as control:

| Principal | `dressing_room_items` (RLS) | RPC before | RPC after |
|---|---|---|---|
| Owner | visible | `like=1,…` | `like=1,…` |
| Active membership | visible | `like=1,…` | `like=1,…` |
| Active participant | visible | `like=1,…` | `like=1,…` |
| Anonymous, live share | 0 rows | `like=1,…` | `like=1,…` *(intended)* |
| **Authenticated non-member** | **0 rows** | **`like=1,…`** | **no rows** |
| **Authenticated removed member** | **0 rows** | **`like=1,…`** | **no rows** |
| Anonymous, share revoked | 0 rows | no rows | no rows |

The removed member is the defect that matters: removal is meant to end access,
RLS honours that and this did not. `20260902130000_reaction_counts_honour_dressing_room_block.sql`
closed the same shape for *blocked* users; removal was missed by that pass — and
the block check being present is what made the branch look finished.

Repair: `supabase/migrations/20260916203000_reaction_counts_require_live_room_access.sql`.
Authenticated non-owners must now hold live access under one of the two recipient
models this schema has (unremoved `shared_room_memberships`, or the governed
`can_access_room_messages()` participant predicate). The union cannot lock out a
legitimate reader — those are the same two predicates that gate the items
themselves. The anonymous branch is deliberately unchanged: the public share
screen is unauthenticated by design and reaches this RPC with item ids only, so
the share link is the capability and its liveness is the bound, exactly as for
`get_public_room_preview`; revoking the anon grant would have broken it outright.

Tests: `__tests__/reactionCountsRoomAccess.test.js` (8/8),
`supabase/tests/reaction_counts_room_access_test.sql` (8 assertions).
Verified a real guard, not a restatement: restoring the pre-fix body inside a
rolled-back transaction, the outsider assertion leaked `true` and the blocked
assertion leaked `false`. Applied to staging; repaired definition confirmed live.

### B34-GOV-002 — P6 — dead control — `FIXED_IN_GOVERNED_BUILD34_SOURCE`

`__tests__/llmModelRoutingParity.test.js` exists to stop Edge Function JWT posture
drifting. Its **first** assertion hardcoded the production project ref, while
`aeb84551` deliberately repointed `supabase/config.toml` at staging and
`config/backend-authority.json` records that as `approvedProjectRef`. Being first,
it threw before any `verify_jwt` assertion could run — the guard had been dead
since that commit, and the suite reported it as a project-ref mismatch rather than
"your JWT guard is not running".

Real drift got through while it was dead: `tryon-clothes-pro` is declared
`verify_jwt = true` and is deployed to staging with `verify_jwt` false. Harmless
today only because that slug is a retired 410 stub that reads no secrets and
contacts no upstream — the guard did not know that.

Repair pins `config.toml` to the governed `approvedProjectRef` instead of a
literal. Two negative controls fail correctly; the one that matters (flipping
`scan-identify` to `verify_jwt = true`) could not fail before. No staging
component — test-only.

### B33-CON-001 — P3 — idempotency/concurrency — `BUILD34_CLIENT_BLOCKER`

`dressing_room_items` carries **no idempotency key** — only its surrogate primary
key. Every sibling customer-mutation table has one: `saved_scans (user_id,
local_id)`, `user_closet_items (user_id, client_id)`, `user_commerce_watches
(user_id, canonical_url)`, `vto_generation_requests (user_id, idempotency_key)`,
`dressing_room_item_reactions (item_id, user_id)`.

`addProductToDressingRoom` is a read→decide→write race: dedupe SELECT, count
SELECT, then INSERT with nothing backing it. Proven on staging — two identical
inserts produced two rows, `DUPLICATE ACCEPTED BY DATABASE`.

The client-side mitigation is behind `DRESSING_ROOM_DEDUPE_V1`, which is
**default off and set in no EAS build profile** (preview, development, staging,
staging-certification, production), so shipping Build 34 has no dedupe at any
layer. Its scan is also bounded to `limit(40)`.

**Not closed backend-only on purpose.** Adding a unique index would make duplicate
adds fail with `23505`, which the client surfaces as "Unable to add item to
Dressing Room" — imposing a product decision (duplicates forbidden) that governed
source deliberately left switched off. That is an owner call, not an audit call.

Proposed repair, to land together: a partial unique index on
`(dressing_room_id, source_type, source_id) where source_id is not null`, plus a
client `upsert ... onConflict` so a lost race is idempotent rather than an error.
Closure condition: both, shipped in the same release as
`DRESSING_ROOM_DEDUPE_V1=true`.

### B33-STO-004 — P3 — storage saga — `BUILD34_CLIENT_BLOCKER` + `AUTHORIZATION_REQUIRED`

Re-audited from scratch. **Still present.** Required safe behaviours:

| Required | State |
|---|---|
| dedupe before unnecessary upload | **No** — gated on `DRESSING_ROOM_DEDUPE_V1`, off everywhere |
| failed DB persistence leaves no unmanaged permanent orphan | **No** — see below |
| retry is safe | **No** — each retry re-uploads and can insert a duplicate (B33-CON-001) |
| shared/multi-reference media not wrongly deleted | Not contradicted; 0 multi-referenced objects observed |

The `scan_image` → Dressing Room path uploads to `style-library-images`, then
inserts into `dressing_room_items`, and on insert failure **throws with no
compensating delete at all**. The sibling inspiration path at least attempts a
best-effort `supabase.storage…remove([storagePath]).catch(() => {})` — itself a
swallowed error (§31), but the scan-image path has no compensation whatsoever.

The backend safety net exists but is not operating: `reconcile-orphan-media` is in
governed source and its RPC (`list_orphan_owner_media`) is applied to staging, but
the function is **not deployed** and nothing invokes it — `pg_cron` and `pg_net`
are both absent and no workflow calls it. Staging carries **30 storage objects
whose owner no longer resolves to an `auth.users` row**, with
`deleted_owner_retained_media` empty, so the reconciler has never run.

Deploying it was **not** done here: `config/backend-authority.json` states it is
deliberately absent from the staging deployment allowlist so its first deployment
stays a separate explicit decision, and that this checkout's tooling refuses it.

```
AUTHORIZATION_REQUIRED = deploy reconcile-orphan-media to staging, then schedule it
EXACT_ACTION           = deploy from rebuild/backend-authority-v2; add an invoker
WHY_REQUIRED           = without it, orphaned media has no bounded lifetime
RISK                   = low; the function only reconciles owner-less objects
ROLLBACK               = undeploy the slug; the RPC is read-only without it
```

---

## Verified non-findings (attacked, held)

- **No SECURITY DEFINER function has a mutable `search_path`** (0 of 116) and **no
  trigger function does either** — Build 33 search_path hardening preserved.
- **No `PUBLIC` EXECUTE grant** on any public/internal routine — Build 33 RPC
  privilege convergence preserved. Exactly 3 `anon`-executable RPCs, all
  intentional public-preview surfaces.
- **No table has RLS disabled.** Five tables have grants but no policy; probed as
  `anon` and all returned 0 rows — deny-all, confirmed empirically, not inferred.
- **Storage policies are owner-scoped** (`foldername(name)[1] = auth.uid()`) on
  every client-reachable bucket. `legal-documents` is public-read by design with
  no client write path; `investor-docs` has no client access at all.
- **K+ entitlement authority is sound**: only two client-callable functions
  (`has_active_k_plus()`, `get_my_kplus_entitlement_summary()`), both zero-arg and
  bound to `auth.uid()`. Every function taking a caller-supplied `p_user_id` is
  service-role only, so cross-user entitlement probing is not expressible.
- **Scanner cost is bounded**: 30 image / 50 text per user per day, enforced by
  `check_and_increment_scan_identify_daily_usage` (service-role only), and
  `scanQuota.ts` fails **closed** via a three-state decision type that makes
  default-true unrepresentable.
- **Public room preview is well-bounded**: share tokens are UUIDs (122-bit), the
  preview caps at 24 items, strips HTML and accepts only `https` image URLs.
- **Environment separation holds**: no project ref is hardcoded in runtime code;
  EAS profiles resolve staging→staging and production→production.
- The 10 Edge Functions deployed to staging with no governed source are **already
  explicitly dispositioned** in `config/backend-authority.json` under `notGoverned`
  (website privacy stack, staging tooling, wearable, diagnostic residue).

## Test execution

| Suite | Result |
|---|---|
| Deno edge function tests | **1153 pass / 0 fail** |
| Node suite — pristine authority `c6ee31ad` | 8937 tests, **20 fail** |
| Node suite — after these repairs | 8945 tests, **19 fail** |
| Introduced by these repairs | **0** |
| Fixed by these repairs | 1 (B34-GOV-002) |

Deno is not present in this environment; it was installed from the GitHub release
and `deno.land` std imports were redirected to JSR via an import map, because the
egress proxy blocks `deno.land`. That is an environment workaround, not a source
change.

## Deferred debt

| ID | Sev | Item | Blocks migration | Closure condition |
|---|---|---|---|---|
| B34-GOV-001 | P7 | Release and backend authorities have diverged histories; governance manifests differ | No | Reconcile the two manifests onto one authority before migration |
| B34-GOV-003 | P7 | 5 stale node assertions in `scanIdentifyEdgeContract.test.js` assert the **superseded fail-open** scan-quota contract against `index.ts`, after the logic moved to `scanQuota.ts` and was hardened to fail closed | No | Retarget them at `scanQuota.ts` and assert `unverified`; behaviour already covered by executed Deno tests |
| B34-GOV-004 | P7 | `20260809120000` sits in the applied migration set but creates `can_contribute_to_dressing_room`, an object the deferral README classes as deferred; a from-scratch replay creates an orphan SECURITY DEFINER function | No | Move it beside the deferred migration, or land both together |
| B34-GOV-005 | P7 | `get_public_room_decision_preview` accepts non-UUID tokens while `get_public_room_preview` requires a UUID; the allowlist documents one rule for both | No | Align the validator, or correct the allowlist comment |
| B34-OPS-001 | P4 | `process-account-deletions`, `commerce-watch-refresh`, `kplus-reconcile-revenuecat` and `reconcile-orphan-media` have **no active invoker**; no `pg_cron`, and the one scheduled workflow has its cron commented out | **Yes** | Stand up invokers at migration, or carry the documented manual operator runbook |
| B34-OPS-002 | P4 | Staging holds 1 deletion request past its grace period with 0 attempts, and 1 pending since June | No | Expected under the documented manual process; re-check after B34-OPS-001 |
| B34-SEC-002 | P4 | `wearable-save`/`wearable-bridge` are `verify_jwt: false`, hold **service_role**, and write into `saved_scans` — a core Build 34 table — from a source tree outside this repo | **Yes** | Do not carry the wearable stack into the destination environment unless it is governed there |
| B34-SEC-003 | P4 | Five tables carry broad `anon`/`authenticated` DML grants that are inert only because no policy exists; adding one policy later makes them live | No | Revoke the vestigial grants |
| B34-ENV-001 | P4 | `preview` and `development` EAS profiles target the **production** Supabase project | No | Owner decision; recorded, not changed |
| B34-OBS-001 | P6 | `supabase/tests/*.sql` (pgTAP) is not wired into CI — behavioural DB assertions never execute | No | Add a pgTAP job, or accept the node guards as the gate |

## Known unknowns

| ID | Question | Closure condition |
|---|---|---|
| B34-KU-001 | Whether the destination environment's effective schema matches this candidate | Compare during the migration campaign; not answerable without production access, which this campaign forbids |
| B34-KU-002 | Whether the 30 orphaned staging objects have production analogues | Run `list_orphan_owner_media` in the destination on migration day |
| B34-KU-003 | Whether `tryon-clothes-pro` is also deployed with a drifted `verify_jwt` in the destination | Check posture during migration, now that B34-GOV-002 makes the guard live |
