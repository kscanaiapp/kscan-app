-- Fixture: false positive guard. TRUNCATE here is a PRIVILEGE NAME being
-- revoked, not a statement being executed. This is privilege tightening --
-- the opposite of destructive. Mirrors the real pattern in
-- supabase/migrations/20260712020000_harden_app_role_privileges.sql,
-- 20260713000001_user_stylist_preferences.sql and
-- 20260716000001_shared_room_memberships.sql, all three of which an earlier
-- detector version wrongly reported as DETECTED_RISK.
revoke truncate, references, trigger, maintain on all tables in schema public from authenticated;

revoke truncate, references, trigger, maintain on public.user_stylist_preferences from anon;
