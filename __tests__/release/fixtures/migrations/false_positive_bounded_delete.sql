-- Fixture: false positive guard for the UNBOUNDED_DELETE rule specifically.
-- This DELETE is WHERE-bounded, mirroring the real pattern in
-- supabase/migrations/20260808121216_privacy_request_rate_limits.sql. The
-- unbounded-delete rule must not fire; the softer review-shape rule may.
delete from public.privacy_request_rate_limits
  where updated_at < now() - interval '1 day';
