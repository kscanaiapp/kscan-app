-- Compact digest of the backend contract fingerprint.
--
-- Same object set as contract-fingerprint.sql, but every object's definition is
-- reduced to an md5 of its canonical JSON. That keeps an itemized, per-object
-- comparison (which object differs, not just "counts differ") small enough to
-- transfer, while full definitions are fetched only for the objects that
-- actually diverge.
--
-- Read-only. Safe to run against production.
with fp as (
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_object_agg(t.relname, t.cols), '{}'::jsonb)
      from (
        select c.relname,
               jsonb_agg(jsonb_build_object(
                 'name', a.attname,
                 'type', format_type(a.atttypid, a.atttypmod),
                 'notnull', a.attnotnull,
                 'default', pg_get_expr(d.adbin, d.adrelid)
               ) order by a.attnum) as cols
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
        where n.nspname = 'public' and c.relkind in ('r','p')
        group by c.relname
      ) t
    ),
    'rls', (
      select coalesce(jsonb_object_agg(c.relname, c.relrowsecurity), '{}'::jsonb)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')
    ),
    'constraints', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      from (
        select con.conrelid::regclass::text || '.' || con.conname as k,
               pg_get_constraintdef(con.oid) as v
        from pg_constraint con
        join pg_namespace n on n.oid = con.connamespace
        where n.nspname = 'public'
      ) s
    ),
    'indexes', (
      select coalesce(jsonb_object_agg(indexname, indexdef), '{}'::jsonb)
      from pg_indexes where schemaname = 'public'
    ),
    'functions', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      from (
        select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
               jsonb_build_object(
                 'result', pg_get_function_result(p.oid),
                 'secdef', p.prosecdef,
                 'volatility', p.provolatile,
                 'config', p.proconfig,
                 'body_md5', md5(coalesce(p.prosrc, ''))
               ) as v
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
      ) s
    ),
    'triggers', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      from (
        select tg.tgrelid::regclass::text || '.' || tg.tgname as k,
               pg_get_triggerdef(tg.oid) as v
        from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not tg.tgisinternal
      ) s
    ),
    'policies', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      from (
        select pol.polrelid::regclass::text || '.' || pol.polname as k,
               jsonb_build_object(
                 'cmd', pol.polcmd,
                 'permissive', pol.polpermissive,
                 'roles', (select coalesce(array_agg(r.rolname order by r.rolname), '{}')
                             from pg_roles r where r.oid = any(pol.polroles)),
                 'using', pg_get_expr(pol.polqual, pol.polrelid),
                 'check', pg_get_expr(pol.polwithcheck, pol.polrelid)
               ) as v
        from pg_policy pol
        join pg_class c on c.oid = pol.polrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
      ) s
    ),
    'table_grants', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      from (
        select table_name || ':' || grantee as k,
               array_agg(privilege_type order by privilege_type) as v
        from information_schema.role_table_grants
        where table_schema = 'public'
          and grantee in ('anon','authenticated','service_role')
        group by table_name, grantee
      ) s
    ),
    'sequence_grants', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      from (
        select c.relname || ':' || r.rolname as k,
               array_agg(privs.priv order by privs.priv) as v
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (select unnest(array['anon','authenticated','service_role']) as rolname) r
        cross join lateral (select unnest(array['SELECT','USAGE','UPDATE']) as priv) privs
        where n.nspname = 'public' and c.relkind = 'S'
          and has_sequence_privilege(r.rolname, c.oid, privs.priv)
        group by c.relname, r.rolname
      ) s
    ),
    'function_acls', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
      from (
        select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || r.rolname as k,
               true as v
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (select unnest(array['anon','authenticated','service_role']) as rolname) r
        where n.nspname = 'public'
          and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
      ) s
    ),
    'storage_buckets', (
      select coalesce(jsonb_object_agg(b.id, jsonb_build_object(
               'public', b.public,
               'file_size_limit', b.file_size_limit,
               'allowed_mime_types', b.allowed_mime_types
             )), '{}'::jsonb)
      from storage.buckets b
    ),
    'storage_policies', (
      select coalesce(jsonb_object_agg(pol.polname, jsonb_build_object(
               'cmd', pol.polcmd,
               'roles', (select coalesce(array_agg(r.rolname order by r.rolname), '{}')
                           from pg_roles r where r.oid = any(pol.polroles)),
               'using', pg_get_expr(pol.polqual, pol.polrelid),
               'check', pg_get_expr(pol.polwithcheck, pol.polrelid)
             )), '{}'::jsonb)
      from pg_policy pol
      where pol.polrelid = 'storage.objects'::regclass
    )
  ) as doc
)
select jsonb_object_agg(cat.key, (
  select coalesce(jsonb_object_agg(obj.key, md5(obj.value::text)), '{}'::jsonb)
  from jsonb_each(cat.value) obj
))::text as digest
from fp, jsonb_each(fp.doc) cat;
