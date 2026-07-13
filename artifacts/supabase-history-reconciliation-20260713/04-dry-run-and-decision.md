# Dry run and stop decision

After exact recovery of `20260709130346`, the linked dry run succeeded as a
non-mutating operation but proposed twelve migrations, not the authorized four:

1. `20260711000001_ai_stylist_looks_extension.sql`
2. `20260711000002_outfit_decision_rooms.sql`
3. `20260711000003_style_outfit_usage.sql`
4. `20260711195508_restore_service_role_app_table_grants.sql`
5. `20260712000001_saved_scan_media_backing.sql`
6. `20260712010000_audit_hardening_ai_stylist_stylechat.sql`
7. `20260712020000_harden_app_role_privileges.sql`
8. `20260713000001_user_stylist_preferences.sql`
9. `20260714000001_user_stylist_preferences_rls_grants.sql`
10. `20260714000002_app_config_read_grants.sql`
11. `20260714000003_add_user_stylist_preferences_avatar_allowlist.sql`
12. `20260715000001_expand_stylist_portrait_avatar_allowlist.sql`

Required stop code:

`UNRELATED_REQUIRED_MIGRATIONS_NEED_SEPARATE_AUTHORIZATION`

Actions deliberately not performed:

- no remote migration ledger repair;
- no migration deployment;
- no Edge Function deployment;
- no remote schema or data mutation;
- no remote-target Android rebuild or runtime smoke, because the prerequisite
  four-file dry run was not achieved;
- no push, merge, rebase, release, or silent production fallback.

Final feature status:

`REMOTE PORTRAIT ENABLEMENT: FAIL — FEATURE MUST REMAIN DISABLED`

## Local/static validation

- Recovered SQL parser check: 19/19 statement character counts and MD5 hashes
  match the remote ledger; combined MD5 matches.
- `supabase migration list --linked`: recovered timestamp aligned locally and
  remotely.
- `supabase db push --linked --dry-run`: non-mutating; produced the twelve-file
  list above.
- Focused Node tests: 75 passed, 0 failed
  (`eliseMigrationOrder`, `scanIdentifyEdgeContract`, `featureFreeze`).
- `git diff --check`: passed.
