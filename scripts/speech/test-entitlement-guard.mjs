import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Exercise the canonical entitlement resolver and Speech reservation code,
// rather than replacing K+ with a boolean fixture. Only external schemas are
// fixtures. PGlite is serial: this does not certify multi-session lock races.
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const db = await PGlite.create();
let checks = 0;
const equal = (a, b) => {
  assert.deepEqual(a, b);
  checks++;
};
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const functionSql = (file, name) => {
  const sql = fs.readFileSync(
    path.join(root, "supabase/migrations", file),
    "utf8",
  );
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `canonical function ${name} must exist`);
  const body = sql.indexOf("as $$", start);
  assert.ok(body > start, `canonical function ${name} must have its SQL body`);
  const end = sql.indexOf("$$;", body);
  assert.ok(
    end > body,
    `canonical function ${name} must have its SQL terminator`,
  );
  return sql.slice(start, end + 3);
};
try {
  await db.exec(
    `create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create table profiles(id uuid primary key references auth.users, account_status text, account_locked_at timestamptz);
    create table user_entitlements(id uuid default gen_random_uuid(), user_id uuid, entitlement_key text, grant_reason text,
      status text, revoked_at timestamptz, expires_at timestamptz, granted_at timestamptz);
    create table kplus_entitlement_grants(id uuid default gen_random_uuid(), user_id uuid, entitlement_key text default 'k_plus',
      source text default 'complimentary', current_period_type text, revoked_at timestamptz, starts_at timestamptz default now() - interval '1 day',
      billing_state text default 'normal', is_open_ended boolean default true, expires_at timestamptz, grace_period_expires_at timestamptz,
      store text, will_renew boolean, trial_ends_at timestamptz, provider_state_occurred_at timestamptz);
    insert into auth.users values ('${actor}'); insert into profiles(id,account_status) values ('${actor}','active');
    select set_config('request.jwt.claim.role','service_role',false);`,
  );
  await db.exec(
    functionSql(
      "20261002010000_kplus_paid_lifetime_entitlement_foundation.sql",
      "kplus_entitlement_facts",
    ),
  );
  for (
    const fn of ["kplus_effective_access_state", "kplus_has_active_entitlement"]
  ) {
    await db.exec(
      functionSql("20260915030553_kplus_entitlement_authority.sql", fn),
    );
  }
  for (
    const file of [
      "20261011222213_build35_speech_operational_cost_controls.sql",
      "20261014210000_stylist_speech_kplus_reservation_guard.sql",
    ]
  ) {
    await db.exec(
      fs.readFileSync(path.join(root, "supabase/migrations", file), "utf8"),
    );
  }
  await db.exec(
    "update speech_provider_control set enabled=true,daily_character_limit=10000",
  );
  const reserve = async () =>
    (await db.query("select reserve_speech_request($1,$2,1) as r", [
      actor,
      "a".repeat(64),
    ])).rows[0].r;
  const denied = async (reason) => {
    equal((await reserve()).reason, reason);
    equal(
      (await db.query(
        "select count(*)::int as n from speech_request_reservations",
      )).rows[0].n,
      0,
    );
  };
  await denied("entitlement_required");
  await db.exec(
    `insert into user_entitlements(user_id,entitlement_key,grant_reason,status,expires_at,granted_at)
    values ('${actor}','k_plus','staff','active',now()-interval '1 minute',now()-interval '1 day')`,
  );
  await denied("entitlement_required");
  await db.exec(
    "update user_entitlements set expires_at=now()+interval '1 day',revoked_at=now()",
  );
  await denied("entitlement_required");
  await db.exec("delete from user_entitlements");
  await db.exec(
    `insert into kplus_entitlement_grants(user_id,source,billing_state,is_open_ended,expires_at)
    values ('${actor}','store_subscription','account_hold',false,now()+interval '1 day')`,
  );
  await denied("entitlement_required");
  await db.exec("update kplus_entitlement_grants set billing_state='paused'");
  await denied("entitlement_required");
  await db.exec(
    "update kplus_entitlement_grants set billing_state='normal',revoked_at=now()",
  );
  await denied("entitlement_required");
  await db.exec("update kplus_entitlement_grants set revoked_at=null");
  await db.exec(
    "update kplus_entitlement_grants set expires_at=now()-interval '1 minute'",
  );
  await denied("entitlement_required");
  await db.exec(
    "update kplus_entitlement_grants set expires_at=now()+interval '1 day',starts_at=now()+interval '1 hour'",
  );
  await denied("entitlement_required");
  await db.exec(
    "update kplus_entitlement_grants set starts_at=now()-interval '1 day'",
  );
  for (const status of ["suspended", "deleted", "pending_deletion", "locked"]) {
    await db.query("update profiles set account_status=$1", [status]);
    await denied("account_unavailable");
  }
  await db.exec("update profiles set account_status='active'");
  equal((await reserve()).allowed, true);
  await db.exec("update kplus_entitlement_grants set revoked_at=now()");
  equal((await reserve()).reason, "entitlement_required");
  console.log(JSON.stringify({
    result: "PASS",
    checks,
    scope:
      "Actual canonical SQL facts/effective-access/predicate and reservation functions; fixture schemas only; serial PGlite, no provider or live database calls",
  }));
} finally {
  await db.close();
}
