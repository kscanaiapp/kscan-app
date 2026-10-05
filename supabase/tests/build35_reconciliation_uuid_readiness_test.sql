begin;
do $$
declare
  v_actor uuid := gen_random_uuid();
  v_result jsonb;
begin
  if exists(select 1 from auth.users where id=v_actor) then raise exception 'unexpected identity collision'; end if;
  -- Negative control: this is the runtime error in the original migration.
  begin
    execute 'select min(id) from public.kplus_entitlement_grants';
    raise exception 'negative control unexpectedly succeeded';
  exception when undefined_function then null;
  end;
  v_result := public.reconcile_kplus_provider_transition(
    p_user_id=>v_actor,p_provider=>'revenuecat',p_cause=>'provider_reconciliation',
    p_external_event_id=>'build35-readiness-subscription',p_provider_event_type=>'reconciliation_snapshot',
    p_provider_occurred_at=>now()-interval '1 minute',p_environment=>'production',
    p_store=>'google',p_product_id=>'synthetic.readiness.monthly',
    p_subscription_ref_digest=>repeat('a',64),p_lifecycle_state=>'active',
    p_period_type=>'paid',p_period_starts_at=>now()-interval '1 day',
    p_expires_at=>now()+interval '1 day',p_will_renew=>true);
  if v_result->>'reason' is distinct from 'unknown_user' then raise exception 'subscription smoke failed: %',v_result; end if;
  v_result := public.reconcile_kplus_provider_lifetime_transition(
    p_user_id=>v_actor,p_provider=>'revenuecat',p_cause=>'provider_reconciliation',
    p_external_event_id=>'build35-readiness-lifetime',p_provider_event_type=>'reconciliation_snapshot',
    p_provider_occurred_at=>now()-interval '1 minute',p_environment=>'production',
    p_store=>'google',p_product_id=>'synthetic.readiness.lifetime',
    p_purchase_ref_digest=>repeat('b',64),p_lifecycle_state=>'active',
    p_purchased_at=>now()-interval '1 day');
  if v_result->>'reason' is distinct from 'unknown_user' then raise exception 'lifetime smoke failed: %',v_result; end if;
  v_result := public.kplus_entitlement_summary(v_actor);
  if v_result->>'access' is distinct from 'free' or v_result->>'complimentaryHistory' is distinct from 'false' then raise exception 'summary smoke failed'; end if;
end;
$$;
rollback;
select 'PASS: both reconciliation wrappers execute the UUID candidate lookup and reject nonexistent actors; summary contract works; original min(uuid) fails' as result;
