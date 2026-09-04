/**
 * Synthetic actor provisioning for the VTO E2E harness.
 *
 * Governance (see PLAN §5/§6 and scripts/staging-v2/seed-fixtures.mjs's own
 * FORBIDDEN_SEED_PATTERNS, which bans `insert into auth.users` outright):
 * identity is created ONLY through Supabase Auth's real public signup
 * endpoint, exactly like a real client — never by inserting a row into
 * auth.users directly. Entitlement STATE (a plain `public.user_entitlements`
 * row, not an identity record) is a legitimate seedable domain table, so the
 * three K+ scenarios this suite needs are reached by seeding that table for
 * an actor this module just created via the real signup flow.
 *
 * All privileged reads/writes (entitlement seed, cleanup, residual-row
 * proof) go through an injected `runSql(sql)` — the caller wires that to the
 * repository's own governed Supabase CLI/management path
 * (`runSupabase(['db','query', sql, '--linked', ...])` from
 * scripts/lib/staging-helpers.mjs), never to a new secret this module holds
 * itself. This module never prints a password, access token, or user id
 * beyond what the caller explicitly asks to log.
 */
'use strict';

import crypto from 'node:crypto';
import { sqlQuote } from './sql.mjs';

export const ACTOR_ROLES = /** @type {const} */ (['ACTIVE_KPLUS', 'NEVER_ENTITLED', 'EXPIRED_KPLUS']);

export const VTO_E2E_ACTOR_EMAIL_DOMAIN = 'vto-e2e.kscan-synthetic.test';

/** Cryptographically random password. Never logged, never persisted beyond
 *  the lifetime of the actor's process-local record. */
export function randomPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Builds the plan for the three required logical actors under one run tag,
 * so a run's actors are trivially greppable by id prefix and never collide
 * with a concurrent run or a prior one's leftovers.
 */
export function buildActorPlan(runTag) {
  const plan = {};
  for (const role of ACTOR_ROLES) {
    plan[role] = {
      role,
      email: `${runTag}.${role.toLowerCase().replace(/_/g, '-')}@${VTO_E2E_ACTOR_EMAIL_DOMAIN}`,
      password: randomPassword(),
    };
  }
  return plan;
}

function normalizeBase(url) {
  return String(url).replace(/\/+$/, '');
}

/** Real signup, exactly as a client would call it. Returns the new user's id
 *  without ever exposing the session token to the caller's logs (the caller
 *  signs in separately via password grant when it actually needs a token). */
export async function signUpActor(base, publishableKey, email, password, fetchImpl = fetch) {
  const res = await fetchImpl(`${normalizeBase(base)}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const userId = json?.id ?? json?.user?.id ?? null;
  if (!res.ok || !userId) {
    return { ok: false, status: res.status, error: json?.error_description || json?.msg || json?.error || `signup failed with status ${res.status}` };
  }
  return { ok: true, status: res.status, userId, emailConfirmed: Boolean(json?.confirmed_at ?? json?.user?.confirmed_at) };
}

/** Only used when signup left the actor unconfirmed (staging's mailer
 *  autoconfirm setting is not this harness's to change). Confirms the row
 *  the real signup flow already created — never an insert, never a new
 *  identity.
 *
 *  auth.users.confirmed_at is generated from the confirmation timestamps
 *  and must never be assigned directly — Postgres rejects any direct
 *  assignment to a generated column. This writes only email_confirmed_at
 *  and lets PostgreSQL derive confirmed_at from it. email_confirmed_at is
 *  the harness's sole verification authority; confirmed_at is never read
 *  or asserted on here either way. See the PR description and
 *  __tests__/vtoE2eHarnessIntegrity.test.js for the exact error this
 *  repairs. */
export async function confirmActorEmail(runSql, userId) {
  await runSql(`update auth.users set email_confirmed_at = now() where id = ${sqlQuote(userId)} and email_confirmed_at is null;`);
}

/**
 * Seeds (or clears) the K+ entitlement row for one already-signed-up actor.
 *   'active'  -> status='active', expires_at in the future, revoked_at null
 *   'expired' -> status='active', expires_at in the PAST, revoked_at null
 *                (kplus_has_active_entitlement requires expires_at > now(),
 *                so a lapsed grant is exactly this: was active, has since
 *                expired — never a second, separate "expired" status enum)
 *   'none'    -> deletes any row for this actor (NEVER_ENTITLED)
 *
 * grant_reason must be one of the values the product's own CHECK constraint
 * permits (see supabase/migrations/20260829120000_kplus_entitlements.sql); a
 * harness-invented value is rejected by Postgres and fails provisioning
 * outright. 'complimentary_early_access' is the complimentary K+ grant path
 * this certification targets, so the synthetic actor carries exactly the
 * entitlement shape a real complimentary K+ user does. The value is inert to
 * the decision under test either way: kplus_has_active_entitlement gates on
 * entitlement_key, status, revoked_at and expires_at only, never on
 * grant_reason.
 */
export async function seedVtoEntitlement(runSql, userId, scenario) {
  if (scenario === 'none') {
    await runSql(`delete from public.user_entitlements where user_id = ${sqlQuote(userId)} and entitlement_key = 'k_plus';`);
    return;
  }
  const expiresAt = scenario === 'active'
    ? `now() + interval '7 days'`
    : `now() - interval '1 day'`;
  await runSql(
    `insert into public.user_entitlements `
    + `(user_id, entitlement_key, status, grant_reason, granted_at, expires_at, revoked_at, external_sync_status) `
    + `values (${sqlQuote(userId)}, 'k_plus', 'active', 'complimentary_early_access', now(), ${expiresAt}, null, 'not_required') `
    + `on conflict (user_id, entitlement_key) do update set `
    + `status = excluded.status, grant_reason = excluded.grant_reason, `
    + `expires_at = excluded.expires_at, revoked_at = null, updated_at = now();`,
  );
}

/** Actor-scoped row counts across every table the harness touches. Used for
 *  PRE-STATE / POST-STATE / RESIDUAL evidence (never a global table scan). */
export async function actorRowCounts(runSql, userId) {
  const rows = await runSql(
    `select `
    + `(select count(*) from auth.users where id = ${sqlQuote(userId)}) as auth_users, `
    + `(select count(*) from public.user_entitlements where user_id = ${sqlQuote(userId)}) as user_entitlements, `
    + `(select count(*) from public.vto_generation_requests where user_id = ${sqlQuote(userId)}) as vto_generation_requests;`,
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  return {
    authUsers: Number(row?.auth_users ?? 0),
    userEntitlements: Number(row?.user_entitlements ?? 0),
    vtoGenerationRequests: Number(row?.vto_generation_requests ?? 0),
  };
}

/** Removes only the exact rows this harness's own actors created, in
 *  dependency order (children before the identity row). Never touches any
 *  row outside the given user id. */
export async function cleanupActor(runSql, userId) {
  await runSql(`delete from public.user_entitlements where user_id = ${sqlQuote(userId)};`);
  await runSql(`delete from public.vto_generation_requests where user_id = ${sqlQuote(userId)};`);
  await runSql(`delete from auth.users where id = ${sqlQuote(userId)};`);
}
