# K Scan AI — KS-REL-006C Staging RLS Patch Merge Report

**Merged branch:** `feature/staging-grants-saved-scans-rls-fix-v2`
**Target branch:** `feature/release-integration-v2-backend-stack-v1`
**Date:** 2026-06-18
**Merge engineer:** Kimi Work Release Agent
**Task:** Merge verified staging RLS patch into release foundation for runtime smoke prep

---

## 1. Branch / Commit

| Field | Value |
|-------|-------|
| **Current branch** | `feature/release-integration-v2-backend-stack-v1` |
| **Merged branch** | `feature/staging-grants-saved-scans-rls-fix-v2` |
| **Source commit** | `1d350c7` fix(db): grant staging access and allow saved scan soft delete |
| **Merge commit** | `a2912aa` Merge remote-tracking branch 'origin/feature/staging-grants-saved-scans-rls-fix-v2' into feature/release-integration-v2-backend-stack-v1 |
| **Already merged** | No — new merge commit created |
| **QA report commit** | This report (to be committed in Step 12) |
| **Working tree** | Clean — only ignored/untracked artifacts |

---

## 2. Pre-Merge Scope

| Field | Value |
|-------|-------|
| **Files in source branch** | `supabase/migrations/202606180001*.sql`, `supabase/migrations/202606180002*.sql`, `supabase/migrations/202606180003*.sql`, `qa/supabase-staging-grants-saved-scans-rls-fix-2026-06-18.md`, `qa/supabase-staging-rls-verification-2026-06-18.md` |
| **Unexpected files** | None ✅ |
| **Tracked Android artifacts** | None — `git ls-files` returned empty for generated Android patterns |
| **Proceed decision** | ✅ Yes |

---

## 3. Merge Result

| Field | Value |
|-------|-------|
| **Conflicts** | None — clean merge |
| **Files changed** | 5 files (3 migrations + 2 QA reports) |
| **Merge commit shape** | Two parents: `b0c175c` (target) + `1d350c7` (source) ✅ |
| **Fast-forward occurred** | No — `--no-ff` merge commit created |
| **Remote branch pushed** | Pending (Step 12) |

---

## 4. Tag Verification

| Field | Value |
|-------|-------|
| **Release tag before merge** | `release-foundation-v2-backend-stack-2026-06-17` → `3c36845` |
| **Release tag after merge** | `release-foundation-v2-backend-stack-2026-06-17` → `3c36845` |
| **Tag moved** | ❌ No |

---

## 5. Migration Verification

| Field | Value |
|-------|-------|
| **Migration count before** | 31 |
| **Migration count after** | 34 |
| **Migration delta** | +3 |
| **Timestamp ordering** | ✅ Valid — 202606180001, 202606180002, 202606180003 in chronological order, no collisions |

### Per-migration content summary

**202606180001_fix_staging_grants_saved_scans_soft_delete.sql:**
- **Purpose:** Grant authenticated role usage on `public` schema + SELECT/INSERT/UPDATE/DELETE on 10 core tables. Fix `saved_scans` soft-delete RLS.
- **Tables affected:** `profiles`, `privacy_settings`, `saved_scans`, `dressing_rooms`, `dressing_room_items`, `dressing_room_messages`, `inspiration_items`, `style_chat_sessions`, `style_chat_messages`, `style_memory_events`
- **Policy/grant changes:** Grants `authenticated` CRUD on 10 tables; `legal_acceptances` gets SELECT/INSERT only (revokes UPDATE/DELETE); drops all existing `saved_scans` policies via `pg_policies` loop; creates 3 new policies: `saved_scans_select_own_active`, `saved_scans_insert_own_active`, `saved_scans_update_own_active`
- **Risk notes:** No DELETE policy — soft-delete only via UPDATE. `legal_acceptances` immutability preserved (revokes UPDATE/DELETE).

**202606180002_fix_saved_scans_soft_delete_select_policy.sql:**
- **Purpose:** Follow-up SELECT policy fix for `saved_scans` soft-delete
- **Tables affected:** `saved_scans`
- **Policy/grant changes:** Drops `saved_scans_select_own_active` and replaces with `saved_scans_select_own` (allows owner to see own rows including soft-deleted ones)
- **Risk notes:** No risk — owner-scoped only, no public/anon access

**202606180003_fix_style_chat_messages_session_rls.sql:**
- **Purpose:** Scope `style_chat_messages` to authenticated user's own session via `style_chat_sessions` ownership
- **Tables affected:** `style_chat_messages`, `style_chat_sessions`
- **Policy/grant changes:** Drops old "Users read own messages" and "Users insert own messages" policies; recreates both with `EXISTS` check against `style_chat_sessions` where `scs.user_id = auth.uid()`
- **Risk notes:** No weakening — cross-user isolation enforced by session ownership check

### Migration scope-creep check

| Check | Result |
|-------|--------|
| waitlist_signups touched | ❌ No |
| investor_inquiries touched | ❌ No |
| Vercel/prod-only tables touched | ❌ No |
| Public/anon protected-table grants | ❌ No |
| Ownership weakened | ❌ No |
| hard-delete policy added | ❌ No |
| legal_acceptances immutability | ✅ Preserved (revoke UPDATE/DELETE) |

---

## 6. Patch Notes Carried Forward

1. **saved_scans follow-up SELECT policy fix** was required and is included in the migration stack (202606180002).
2. **style_chat_messages parent-session insert gap** was fixed during RLS testing (202606180003) and is treated as a security-aligned scope note.
3. **anon JWT hygiene note** remains tracked separately and is not a runtime-smoke blocker if public anon only.

---

## 7. Validation

| Check | Result |
|-------|--------|
| **TypeScript** | ✅ Pass (`tsc --noEmit` clean) |
| **Tests** | Same baseline as prior — 3 known failures unchanged (authPrivacy, useKScanDuplicateGuard, verifyAppleReadiness) |
| **No new failures** | ✅ None |
| **Feature flags** | All env-driven, all default `false` ✅ |
| **No-secrets scan** | No hardcoded secrets in new migrations. `service_role` only in QA documentation. Android XML dumps contain `password="false"` accessibility attributes (not secrets) ✅ |
| **Destructive SQL scan** | 0 matches for `DROP TABLE`, `TRUNCATE`, `DISABLE RLS`, `DROP COLUMN`, `ALTER TABLE ... DROP` ✅ |
| **Unauthorized scope** | 0 matches for `waitlist_signups`, `investor_inquiries` ✅ |

---

## 8. Release Impact

| Area | Impact |
|------|--------|
| **Android** | None |
| **iOS** | None |
| **Supabase** | Staging migrations ready; no remote apply performed in this merge |
| **Gemini/StyleChat/TextScan** | None |
| **Feature flags** | None changed |
| **App code** | None touched |
| **Backend logic** | None touched (only SQL migrations) |

---

## 9. Remaining Blockers

| Blocker | Status |
|---------|--------|
| **Supabase staging migration apply** | Still required — migrations are now in branch but not yet applied to staging |
| **RLS runtime verification** | Still required after staging apply |
| **Cross-user isolation** | Still required |
| **Trigger functional test** | Still required (for saved_scans `updated_at`) |
| **Android runtime smoke** | Ready to attempt |
| **AAB build gate** | Ready to attempt |
| **Gemini provider lane** | Still deferred |
| **StyleChat generation repair** | Still out of scope |

---

## 10. Rollback Plan

If this merge must be reverted before runtime smoke:

```powershell
git revert -m 1 a2912aa
# Then push the revert commit
```

Do not force-push unless explicitly approved.

---

## 11. Final Recommendation

| Decision | Status |
|----------|--------|
| **Patch merged** | ✅ Yes — clean merge, no conflicts, exact expected files |
| **Ready for staging verification** | ✅ Yes — 3 migrations are deterministic and ready for `supabase db push` when staging is available |
| **Ready for runtime smoke** | ✅ Yes — no app code changes, no feature flag changes, no native config changes |
| **Ready for AAB gate** | ✅ Yes |
| **Hold** | Not required for this merge |
| **Next required prompt** | `KS-REL-007A — Android Runtime Smoke Against Safe Staging` |

---

*Report generated by KS-REL-006C merge workflow — 2026-06-18*
