// Minimal Supabase schema fixture in a new, network-isolated disposable DB.
// Auth/profiles are fixtures; all K+ tables/functions use unchanged migrations.
const fs=require('node:fs');
const cp=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'../../../..');
const container='kscan-issue704-disposable';
const migrations=[
 '20260829120000_kplus_entitlements.sql',
 '20260829180000_fix_grant_kplus_early_access_variable_conflict.sql',
 '20260915030553_kplus_entitlement_authority.sql',
 '20260915124849_kplus_reconcile_queue_excludes_inactive_rows.sql',
 '20260915181554_kplus_revenuecat_mirror_retirement.sql',
 '20260915181910_kplus_promotional_mirror_sources_search_path.sql',
 '20261002010000_kplus_paid_lifetime_entitlement_foundation.sql',
 '20261003195716_kplus_provider_pull_reconciliation.sql',
 '20261004231628_fix_kplus_reconciliation_uuid_selection.sql',
];
const bootstrap=`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema extensions;
create table auth.users(id uuid primary key,email text,aud text,role text,is_anonymous boolean default false);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.profiles(id uuid primary key references auth.users(id) on delete cascade,account_status text default 'active',account_locked_at timestamptz);
grant usage on schema auth to anon,authenticated,service_role;
`;
const sql=bootstrap+'\n'+migrations.map(p=>fs.readFileSync(path.join(root,'supabase/migrations',p),'utf8')).join('\n');
cp.execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-f','-'],{input:sql,stdio:['pipe','inherit','inherit'],windowsHide:true});
console.log(JSON.stringify({container,migrations,network:'none',fixture:'minimal auth/users/profiles; unchanged K+ migrations'}));
