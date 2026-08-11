-- Fixture: true positive. Tightens an existing nullable column to NOT NULL.
alter table public.deletion_requests
  alter column requested_at set not null;
