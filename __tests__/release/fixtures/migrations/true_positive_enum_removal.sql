-- Fixture: true positive. Removes an enum value.
alter type public.deletion_state drop value 'legacy_pending';
