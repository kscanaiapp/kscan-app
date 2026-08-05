-- Synthetic staging fixtures. Idempotent.
--
-- RULES THIS FILE OBEYS:
--   * No production record is ever copied.
--   * No Waitlist entry is ever seeded. The Waitlist is protected data and is
--     excluded from acceptance testing entirely.
--   * No row is inserted into auth.users. The primary emulator test user is
--     created through the real signup flow, so that the signup path, the
--     handle_new_user trigger, and the profile/privacy bootstrap are all
--     genuinely exercised rather than bypassed.
--   * Nothing here is destructive: no DROP, no TRUNCATE, no DELETE.
--
-- scripts/staging-v2/seed-fixtures.mjs additionally refuses to run this file if
-- it ever grows a Waitlist insert or an auth.users insert.

begin;

-- ---------------------------------------------------------------------------
-- Synthetic product catalogue
-- ---------------------------------------------------------------------------
-- Deterministic ids so re-running is a no-op and so tests can reference them.
insert into public.product_catalog (
  id, brand, title, category, price_amount, currency, product_url, image_url
)
values
  ('00000000-0000-4000-9000-000000000001', 'Synthetic Atelier', 'Test Wool Overcoat',
   'outerwear', 249.00, 'USD',
   'https://example.invalid/products/test-wool-overcoat',
   'https://example.invalid/images/test-wool-overcoat.jpg'),
  ('00000000-0000-4000-9000-000000000002', 'Synthetic Atelier', 'Test Oxford Shirt',
   'tops', 69.00, 'USD',
   'https://example.invalid/products/test-oxford-shirt',
   'https://example.invalid/images/test-oxford-shirt.jpg'),
  ('00000000-0000-4000-9000-000000000003', 'Synthetic Denim Co', 'Test Straight Jean',
   'bottoms', 118.00, 'USD',
   'https://example.invalid/products/test-straight-jean',
   'https://example.invalid/images/test-straight-jean.jpg'),
  ('00000000-0000-4000-9000-000000000004', 'Synthetic Footwear', 'Test Leather Sneaker',
   'footwear', 145.00, 'USD',
   'https://example.invalid/products/test-leather-sneaker',
   'https://example.invalid/images/test-leather-sneaker.jpg')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Feature-flag / quota baseline
-- ---------------------------------------------------------------------------
-- app_config drives the client feature freeze. Seeded only where a key is
-- absent, so an intentional staging override is never overwritten.
insert into public.app_config (key, value)
select v.key, v.value
from (values
  ('feature_freeze_enabled', 'false'),
  ('staging_environment', 'true')
) as v(key, value)
where not exists (select 1 from public.app_config c where c.key = v.key);

commit;

-- Deliberately NOT seeded here, and why:
--
--   Closet items, Dressing Rooms, Looks, shared-room records
--     Every one of these is owned by a user via a foreign key to auth.users.
--     Seeding them requires inventing a user, which would mean an auth.users
--     insert. They are created through the app by the emulator test user
--     instead, which is also the only way their RLS paths get exercised
--     honestly.
--
--   legal-documents test artifacts
--     Uploaded through the Storage API by fixture tooling, not by SQL. Storage
--     objects are not database rows.
