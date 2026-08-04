-- Forward-only delivery ledger for the Render email-only waitlist integration.
-- The stable row UUID is also the provider idempotency key, preventing duplicate
-- welcome deliveries when Vercel retries or loses a provider response.

alter table public.waitlist_signups
  add column if not exists email_delivery_status text not null default 'pending',
  add column if not exists email_delivery_attempts integer not null default 0,
  add column if not exists email_last_attempt_at timestamptz,
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_last_error_code text;

alter table public.waitlist_signups
  drop constraint if exists waitlist_signups_email_delivery_status_check;

alter table public.waitlist_signups
  add constraint waitlist_signups_email_delivery_status_check
  check (email_delivery_status in ('pending', 'sent', 'failed_retryable', 'failed_permanent'));

alter table public.waitlist_signups
  drop constraint if exists waitlist_signups_email_delivery_attempts_check;

alter table public.waitlist_signups
  add constraint waitlist_signups_email_delivery_attempts_check
  check (email_delivery_attempts >= 0);
