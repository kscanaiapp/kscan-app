-- Build 34 entitlement repair, part 2 — Signature Style sees ALL owned-item
-- evidence this actor has, not just the K+ store.
--
-- OWNER PRODUCT AUTHORITY (Build 34):
--   SIGNATURE_STYLE_ENTITLEMENT=FREE
--   FREE_CLOSET_TO_SIGNATURE_STYLE=REQUIRED
--
-- APPLIED LEDGER IDENTITY: staging (yzqjvdfgefveprobvvyw) recorded this file as
-- version 20260915232402 on 2026-09-15. The filename carries that exact version
-- so `supabase db push` reconciles on it. Authored as 20260915230000 and renamed
-- BEFORE any ledger anywhere recorded that number -- staging holds only
-- 20260915232402 and production holds neither -- so nothing can double-apply.
--
-- THE DEFECT THIS CLOSES
--
-- 20260915214857 removed the K+ *entitlement* gate, so a free user could
-- finally call this RPC. It was not enough. This build ships TWO owned-item
-- stores:
--
--   public.wardrobe_utility_items  RLS `user_id = auth.uid()` -- FREE. Any
--                                  authenticated user may add, edit, retain
--                                  and read their own rows. Surfaced on the
--                                  CORE/FREE Library screen (app/library.tsx)
--                                  and synced by services/free-tier/
--                                  freeTierSupabaseSync.ts (utility_item).
--   public.user_closet_items       RLS `user_id = auth.uid() AND
--                                  has_active_k_plus()` -- K+ only.
--
-- This function read ONLY the second. Proven live on staging: a never-K+ free
-- actor with a real item in their free Closet got evidenceCount 0 and
-- evidence_revision 'empty:0'. Signature Style was free in access and empty in
-- capability.
--
-- THE REPAIR: ONE ALGORITHM, EVERY SOURCE
--
-- Source selection is NOT entitlement-dependent. There is no "if K+ use A else
-- use B" branch here and there must never be one: a K+ actor with records in
-- both stores gets ONE coherent Signature Style, not a different algorithm.
-- Every actor's evidence is simply the union of the owned-item sources that
-- actor actually has rows in, which is what their entitlements already decide
-- for them at the RLS layer.
--
--   user_closet_items + wardrobe_utility_items
--     -> normalize
--     -> deduplicate
--     -> bounded aggregate
--     -> evidence_revision
--     -> user_style_profiles
--
-- ATTRIBUTE NORMALIZATION — NOTHING IS FABRICATED
--
-- wardrobe_utility_items has no `clothing_type`. It has `silhouette`, which is
-- a DIFFERENT attribute (a cut, e.g. "longline"): the Closet taxonomy carries
-- category / clothing_type / subtype and no silhouette at all, and
-- NormalizedItem (services/free-tier/wardrobeUtilityTypes.ts) carries category
-- and silhouette as separate fields. There is no deterministic authoritative
-- mapping from one to the other, so a free-Closet row contributes NO garment
-- type -- GARMENT_TYPE_CONTRIBUTION=OMIT_FOR_THAT_ROW. It still contributes
-- every attribute it does authoritatively carry: colour, category, brand and
-- material. Nothing is inferred to fill garmentTypeFrequency.
--
-- Shape differences are mapped, not invented:
--   colour   closet primary_color + secondary_colors[] | free color (single)
--   material closet material[]                         | free material (single)
--   category closet category                           | free category
--   brand    closet brand                              | free brand
--
-- DEDUPLICATION — EXACT KNOWN IDENTITIES ONLY
--
-- DOCUMENTED LIMITATION: there is no safe cross-table equivalence key in this
-- data model, so cross-store duplicates are NOT merged.
--   user_closet_items.client_id     is the local Closet record's own id
--                                   (closetLibrary.js buildClosetRecord), raw.
--   wardrobe_utility_items.client_id is always 'item:' || NormalizedItem.id
--                                   (freeTierBackendMapper.ts clientId()), and
--                                   source_item_id is that id unprefixed.
-- The namespaces are disjoint by construction, so the columns can neither
-- collide accidentally nor ever match each other. user_closet_items has no
-- source_item_id and no scan linkage -- `origin` is a two-value enum, not an
-- identity. Fuzzy image/text matching is explicitly NOT introduced during
-- freeze, so the honest scope is: dedupe the exact identities each store
-- really has, and leave cross-store equivalence to a later phase that has a
-- real key.
--
--   user_closet_items       already UNIQUE on (user_id, client_id) -- no
--                           intra-store duplicate is representable.
--   wardrobe_utility_items  client_id is NULLABLE, so rows are collapsed on
--                           coalesce(client_id, source_item_id) (its own upsert
--                           conflict identity, with its NOT NULL fallback),
--                           keeping the most recently updated row. The tie-break
--                           descends to `id`, so the pick is deterministic and
--                           never depends on scan order.
--
-- EVIDENCE REVISION
--
-- The revision now fingerprints the normalized evidence ACTUALLY USED, as a
-- content hash over the deduped rows sorted by their own canonical text. So it:
--   * changes when relevant free-Closet evidence changes (add/edit/remove);
--   * is stable for unchanged normalized evidence;
--   * cannot depend on table iteration order (the sort is on the content);
--   * can never include another user's data (both reads are scoped to
--     auth.uid() and nothing else);
--   * ignores attributes Signature Style does not consume, so editing a note or
--     a price no longer forces a pointless recompute.
--
-- The 'v2:' prefix is load-bearing. Every profile stored under the old
-- single-source algorithm carries a revision of the old shape, so it can never
-- compare equal to a v2 revision and is rebuilt from full evidence on first
-- request. No stale single-source profile survives this migration.
--
-- UNCHANGED, deliberately: auth.uid() identity and the 28000 refusal, the
-- zero-argument contract, SECURITY DEFINER + pinned search_path + the
-- #variable_conflict pragma, the stored-profile integrity re-validation, the
-- bounded top-10 aggregate shape, RLS on user_style_profiles, the grants
-- (public/anon revoked, authenticated execute), has_active_k_plus() itself and
-- every other K+ boundary that consumes it. Closet RLS is untouched: this
-- function does not widen what any actor may write, only what their own
-- Signature Style is derived from.

create or replace function public.recompute_signature_style()
returns table (
  user_id uuid,
  profile_version integer,
  evidence_revision text,
  derived_at timestamptz,
  profile_data jsonb,
  recomputed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_evidence_revision text;
  v_existing public.user_style_profiles%rowtype;
  v_profile_data jsonb;
  v_count bigint;
  v_fingerprint text;
  v_colors text[];
  v_categories text[];
  v_garment_types text[];
  v_brands text[];
  v_materials text[];
begin
  -- AUTHENTICATION IS STILL REQUIRED. The entitlement requirement was removed
  -- in 20260915214857; the authorization boundary was not, and is not here.
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- ONE normalized, deduplicated evidence set over every owned-item source.
  -- Both reads are scoped to v_user_id and nothing else, so no other actor's
  -- rows can enter the aggregate or the fingerprint.
  with closet as (
    select
      'closet:' || c.client_id as ident,
      nullif(btrim(coalesce(c.category, '')), '')      as category,
      nullif(btrim(coalesce(c.clothing_type, '')), '') as garment_type,
      nullif(btrim(coalesce(c.brand, '')), '')         as brand,
      array_remove(
        array[nullif(btrim(coalesce(c.primary_color, '')), '')]
          || coalesce(c.secondary_colors, '{}'::text[]),
        null
      ) as colors,
      coalesce(c.material, '{}'::text[]) as materials
    from public.user_closet_items c
    where c.user_id = v_user_id
      and c.deleted_at is null
  ),
  free_deduped as (
    -- Exact-identity collapse within the free store only. DISTINCT ON keeps the
    -- most recently updated row; the id tie-break makes the pick deterministic.
    select distinct on (coalesce(nullif(btrim(coalesce(w.client_id, '')), ''), w.source_item_id))
      w.source_item_id,
      w.client_id,
      w.category,
      w.brand,
      w.color,
      w.material
    from public.wardrobe_utility_items w
    where w.user_id = v_user_id
      and w.deleted_at is null
    order by
      coalesce(nullif(btrim(coalesce(w.client_id, '')), ''), w.source_item_id),
      w.updated_at desc,
      w.id
  ),
  free as (
    select
      'free:' || coalesce(nullif(btrim(coalesce(f.client_id, '')), ''), f.source_item_id) as ident,
      nullif(btrim(coalesce(f.category, '')), '') as category,
      -- NO AUTHORITATIVE GARMENT TYPE ON THIS ROW. Omitted, never inferred.
      null::text                                  as garment_type,
      nullif(btrim(coalesce(f.brand, '')), '')    as brand,
      array_remove(array[nullif(btrim(coalesce(f.color, '')), '')], null)    as colors,
      array_remove(array[nullif(btrim(coalesce(f.material, '')), '')], null) as materials
    from free_deduped f
  ),
  owned as (
    select * from closet
    union all
    select * from free
  ),
  canonical as (
    select
      o.category,
      o.garment_type,
      o.brand,
      o.colors,
      o.materials,
      -- Canonical per-row text. Sorting the multi-valued attributes here is
      -- what makes the fingerprint independent of array order.
      o.ident
        || '|' || coalesce(o.category, '')
        || '|' || coalesce(o.garment_type, '')
        || '|' || coalesce(o.brand, '')
        || '|' || coalesce((
             select string_agg(btrim(v), ',' order by lower(btrim(v)), btrim(v))
             from unnest(o.colors) as v
             where nullif(btrim(v), '') is not null), '')
        || '|' || coalesce((
             select string_agg(btrim(v), ',' order by lower(btrim(v)), btrim(v))
             from unnest(o.materials) as v
             where nullif(btrim(v), '') is not null), '')
        as line
    from owned o
  )
  select
    count(*)::bigint,
    md5(coalesce(string_agg(k.line, E'\n' order by k.line), '')),
    coalesce((select array_agg(v) from canonical q, unnest(q.colors) as v), '{}'::text[]),
    coalesce(array_agg(k.category) filter (where k.category is not null), '{}'::text[]),
    coalesce(array_agg(k.garment_type) filter (where k.garment_type is not null), '{}'::text[]),
    coalesce(array_agg(k.brand) filter (where k.brand is not null), '{}'::text[]),
    coalesce((select array_agg(v) from canonical q, unnest(q.materials) as v), '{}'::text[])
  into v_count, v_fingerprint, v_colors, v_categories, v_garment_types, v_brands, v_materials
  from canonical k;

  v_evidence_revision := case
    when coalesce(v_count, 0) = 0 then 'empty:0'
    else 'v2:' || v_fingerprint || ':' || v_count::text
  end;

  select *
    into v_existing
    from public.user_style_profiles
   where user_id = v_user_id;

  if found
     and v_existing.profile_version = 1
     and v_existing.evidence_revision = v_evidence_revision
     -- A legacy or otherwise corrupt row must never be echoed back merely
     -- because its revision matches.  Rebuild it from owned evidence below.
     and jsonb_typeof(v_existing.profile_data) = 'object'
     and jsonb_typeof(v_existing.profile_data -> 'evidenceCount') = 'number'
     and jsonb_typeof(v_existing.profile_data -> 'colorFrequency') = 'array'
     and jsonb_typeof(v_existing.profile_data -> 'categoryFrequency') = 'array'
     and jsonb_typeof(v_existing.profile_data -> 'garmentTypeFrequency') = 'array'
     and jsonb_typeof(v_existing.profile_data -> 'brandFrequency') = 'array'
     and jsonb_typeof(v_existing.profile_data -> 'materialFrequency') = 'array' then
    return query
      select v_existing.user_id, v_existing.profile_version, v_existing.evidence_revision,
             v_existing.derived_at, v_existing.profile_data, false;
    return;
  end if;

  -- Same bounded aggregate contract as before: top-10 per dimension, counts
  -- only, no item ids, no storage paths, no raw notes.
  v_profile_data := jsonb_build_object(
    'evidenceCount', coalesce(v_count, 0)::integer,
    'colorFrequency', public.signature_style_frequency(v_colors),
    'categoryFrequency', public.signature_style_frequency(v_categories),
    'garmentTypeFrequency', public.signature_style_frequency(v_garment_types),
    'brandFrequency', public.signature_style_frequency(v_brands),
    'materialFrequency', public.signature_style_frequency(v_materials)
  );

  insert into public.user_style_profiles (
    user_id, profile_version, evidence_revision, profile_data, derived_at
  ) values (
    v_user_id, 1, v_evidence_revision, v_profile_data, now()
  )
  on conflict (user_id) do update
    set profile_version = excluded.profile_version,
        evidence_revision = excluded.evidence_revision,
        profile_data = excluded.profile_data,
        derived_at = excluded.derived_at
  returning * into v_existing;

  return query
    select v_existing.user_id, v_existing.profile_version, v_existing.evidence_revision,
           v_existing.derived_at, v_existing.profile_data, true;
end;
$$;

comment on function public.recompute_signature_style() is
  'Build 34 entitlement repair. SIGNATURE_STYLE_ENTITLEMENT=FREE. Any AUTHENTICATED actor recomputes their own Signature Style from EVERY owned-item source they have -- public.user_closet_items and public.wardrobe_utility_items -- under one entitlement-independent algorithm. Normalizes, deduplicates on each store''s own exact identity (no cross-store key exists; none is invented), omits garment type for rows that carry no authoritative one, and fingerprints the evidence actually used. Accepts no client-authored payload, revision or user id, and can never read or write another actor''s data.';

-- Grants restated verbatim (idempotent): anon and public still cannot execute
-- this function, and nothing below broadens any privilege.
revoke all on function public.recompute_signature_style() from public, anon;
grant execute on function public.recompute_signature_style() to authenticated;
