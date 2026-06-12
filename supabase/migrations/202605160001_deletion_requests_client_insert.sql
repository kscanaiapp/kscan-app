alter table public.deletion_requests
  alter column status set default 'pending',
  alter column request_source set default 'mobile_app';

drop policy if exists "Users can insert own deletion requests" on public.deletion_requests;
create policy "Users can insert own deletion requests"
on public.deletion_requests
for insert
to authenticated
with check (
  user_id = auth.uid()
  and status = 'pending'
  and request_source = 'mobile_app'
);
