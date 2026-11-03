-- Black-owned discovery: durable product moderation.
-- Before this, a moderator withdrawal ('withdrawn') was indistinguishable from a
-- product leaving the merchant feed, so the next sync re-validated it. A
-- moderator decision is now 'rejected' and only a moderator can lift it.
-- No rows are seeded; existing data is unchanged.

create or replace function public.discovery_ingest(p_merchant uuid,p_key text,p_products jsonb,p_complete boolean default false) returns int
language plpgsql security invoker set search_path = '' as $$
declare m public.discovery_merchants; prior public.discovery_sync_runs; n int; hash text; p jsonb; ids uuid[] := '{}'; inserted_id uuid;
begin
  select * into strict m from public.discovery_merchants where id=p_merchant for update;
  if m.status <> 'active' or m.catalog_status <> 'approved' or m.identity_expires_at <= now() or m.source_authorized_until <= now() then raise exception 'merchant not authorized' using errcode='42501'; end if;
  if jsonb_typeof(p_products) <> 'array' or jsonb_array_length(p_products) > 500 or octet_length(p_products::text) > 2000000 then raise exception 'feed limit exceeded'; end if;
  hash := md5(p_products::text || p_complete::text);
  select * into prior from public.discovery_sync_runs where merchant_id=p_merchant and idempotency_key=p_key;
  if prior.id is null then raise exception 'sync reservation required'; end if;
  if prior.payload_hash <> '' then
    if prior.payload_hash <> hash then raise exception 'idempotency key reused with different payload'; end if;
    if prior.status='succeeded' then return prior.product_count; end if;
  end if;
  if prior.status <> 'running' then raise exception 'sync not running'; end if;
  for p in select value from jsonb_array_elements(p_products) loop
    if not public.discovery_safe_url(p->>'product_url',m.approved_domains) or (p->>'image_url' is not null and not public.discovery_safe_url(p->>'image_url',m.image_domains)) then raise exception 'unsafe catalog destination'; end if;
    if not array(select jsonb_array_elements_text(p->'markets')) <@ m.markets then raise exception 'unapproved market'; end if;
    insert into public.discovery_products(merchant_id,brand_id,sandbox_only,source_product_id,variant_id,sku,title,category,subtype,attributes,image_url,product_url,price_amount,currency,availability,sizes,markets,source_provenance_ref,validation_state,synced_at,expires_at)
      values(m.id,m.brand_id,m.sandbox_only,p->>'source_product_id',coalesce(p->>'variant_id',''),nullif(p->>'sku',''),p->>'title',p->>'category',p->>'subtype',coalesce(p->'attributes','{}'),p->>'image_url',p->>'product_url',(p->>'price_amount')::numeric,p->>'currency',coalesce(p->>'availability','unknown'),array(select jsonb_array_elements_text(coalesce(p->'sizes','[]'))),array(select jsonb_array_elements_text(coalesce(p->'markets','[]'))),p->>'source_provenance_ref','valid',now(),now()+interval '24 hours')
      on conflict(merchant_id,source_product_id,variant_id) do update set sku=excluded.sku,title=excluded.title,category=excluded.category,subtype=excluded.subtype,attributes=excluded.attributes,image_url=excluded.image_url,product_url=excluded.product_url,price_amount=excluded.price_amount,currency=excluded.currency,availability=excluded.availability,sizes=excluded.sizes,markets=excluded.markets,source_provenance_ref=excluded.source_provenance_ref,
        -- A moderator rejection survives every later sync.
        validation_state=case when public.discovery_products.validation_state='rejected' then 'rejected' else 'valid' end,
        synced_at=excluded.synced_at,expires_at=excluded.expires_at returning id into inserted_id;
    ids := array_append(ids,inserted_id);
  end loop;
  if p_complete then update public.discovery_products set validation_state='withdrawn',availability='out_of_stock' where merchant_id=m.id and not(id=any(ids)) and validation_state not in ('withdrawn','rejected'); end if;
  n := jsonb_array_length(p_products);
  update public.discovery_sync_runs set payload_hash=hash,status='succeeded',product_count=n,error_code=null,retry_after=null where id=prior.id;
  return n;
end $$;

-- Administrator-only, audited. 'reject' disqualifies a product durably;
-- 'restore' lifts the rejection, after which only a fresh authorized sync can
-- make the product eligible again.
create function public.discovery_moderate_product(p_actor uuid,p_product uuid,p_decision text) returns void
language plpgsql security invoker set search_path = '' as $$
declare previous text;
begin
  if not exists(select 1 from public.discovery_reviewers where actor_id=p_actor and enabled and authority='administrator') then raise exception 'administrator required' using errcode='42501'; end if;
  if p_decision not in ('reject','restore') then raise exception 'unsupported moderation decision'; end if;
  select validation_state into previous from public.discovery_products where id=p_product for update;
  if previous is null then raise exception 'product not found'; end if;
  if p_decision='reject' then
    update public.discovery_products set validation_state='rejected',availability='out_of_stock' where id=p_product;
  elsif previous='rejected' then
    update public.discovery_products set validation_state='withdrawn' where id=p_product;
  end if;
  insert into public.discovery_audit(actor_id,entity_type,entity_id,action,from_state,to_state)
    values(p_actor,'discovery_products',p_product,'moderated',previous,case when p_decision='reject' then 'rejected' when previous='rejected' then 'withdrawn' else previous end);
end $$;

revoke all on function public.discovery_ingest(uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.discovery_ingest(uuid,text,jsonb,boolean) to service_role;
revoke all on function public.discovery_moderate_product(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.discovery_moderate_product(uuid,uuid,text) to service_role;
