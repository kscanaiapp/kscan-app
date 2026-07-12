-- RLS table privileges for user_stylist_preferences.
--
-- The authenticated role must hold the underlying table privileges before RLS
-- policies can authorize access. This migration adds the missing grant while
-- leaving the service_role grant untouched.

grant select, insert, update on public.user_stylist_preferences to authenticated;
