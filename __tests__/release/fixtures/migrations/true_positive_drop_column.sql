-- Fixture: true positive. Removes a column from an existing table.
alter table public.saved_scans
  drop column deprecated_purchase_blob;
