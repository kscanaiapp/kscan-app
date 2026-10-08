/**
 * The synthetic K+ actor for the `user_supplied_garment` staging probe.
 *
 * It reuses the harness's governed pieces rather than adding an auth
 * framework: identity comes from Supabase Auth's real public signup
 * (lib/actors.mjs::signUpActor), the session from a fresh password grant
 * (security/scripts/synthetic-auth.js via lib/auth.mjs), and every privileged
 * statement goes through the one governed SQL venue (lib/sql.mjs), injected as
 * `runSql`.
 *
 * WHAT IS DIFFERENT FROM lib/actors.mjs, AND WHY. That module seeds the Build
 * 34 `user_entitlements` row directly. This probe is forbidden to write an
 * entitlement table at all. K+ is granted and revoked ONLY through the
 * canonical trusted authority the product itself uses:
 *
 *     public.grant_kplus_complimentary(...)   -> one time-boxed grant
 *     public.revoke_kplus_grant(user, grant)  -> operator revocation
 *
 * Both are `service_role`-only security-definer functions that keep the grant
 * ledger, the activation record and the transition audit consistent. Calling
 * them is how a real complimentary grant is made; this module never issues an
 * INSERT, UPDATE or DELETE against `kplus_entitlement_*` or
 * `user_entitlements` (pinned by __tests__/vtoE2eUserGarmentProbe.test.js).
 * RevenueCat is not touched: the grant is a K Scan AI ledger row, and the
 * promotional mirror only runs when an operator invokes it.
 *
 * OWN NAMESPACE, OWN LEDGER. Actors live under their own email domain, so a
 * run of this probe can never collide with, or be cleaned up as, the
 * entitlement-seeded actors of the older modes; and cleanup returns a
 * step-by-step ledger of exactly what it did to exactly this actor.
 *
 * No password, access token or user credential is ever returned in evidence.
 */
'use strict';

import { randomPassword, signUpActor, confirmActorEmail } from './actors.mjs';
import { signInSyntheticUser, maskLine } from './auth.mjs';
import { sqlQuote } from './sql.mjs';

export const USER_GARMENT_ACTOR_EMAIL_DOMAIN = 'vto-user-garment.kscan-synthetic.test';
export const USER_GARMENT_ACTOR_ROLE = 'USER_GARMENT_KPLUS';

/**
 * The same shape the governed Staging K+ synthetic actor of the Build 35
 * Premium Value lane uses (security/scripts/build35-premium-runtime.js): a
 * time-boxed `promotional` grant under a named campaign. The campaign id is
 * this probe's own, so its grants are never mistaken for that lane's.
 */
export const SYNTHETIC_KPLUS_GRANT_SOURCE = 'promotional';
export const SYNTHETIC_KPLUS_GRANT_CAMPAIGN = 'build35-elise-contextual-vto';
/** Long enough for one run, short enough that a grant orphaned by a crash
 *  expires on its own well before anyone could mistake it for a real one. */
export const SYNTHETIC_KPLUS_GRANT_MINUTES = 30;

const GRANT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildUserGarmentActor(runTag) {
  return {
    role: USER_GARMENT_ACTOR_ROLE,
    email: `${runTag}.kplus@${USER_GARMENT_ACTOR_EMAIL_DOMAIN}`,
    password: randomPassword(),
  };
}

/** One grant identity per run, so a rerun under the same tag is idempotent in
 *  the authority's own terms rather than a second grant. */
export function userGarmentGrantKey(runTag) {
  const key = `vto-user-garment:${runTag}`;
  if (!GRANT_KEY_PATTERN.test(key)) {
    throw new Error(`run tag does not form a valid K+ grant key: ${JSON.stringify(runTag)}`);
  }
  return key;
}

function firstRow(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

/** A jsonb column arrives as an object or as its JSON text, depending on the
 *  CLI's output path. Anything else is not a result this module can trust. */
function readJsonColumn(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readBoolean(value) {
  return value === true || value === 't' || value === 'true';
}

/**
 * Signs the actor up through the real client path and signs it in with a
 * fresh password grant. Writes no entitlement. The access token is masked on
 * stderr the moment it exists and is returned only in process memory.
 */
export async function provisionUserGarmentActor({
  base, publishableKey, runSql, runTag,
  signUp = signUpActor, signIn = signInSyntheticUser, log = (line) => console.error(line),
}) {
  const actor = buildUserGarmentActor(runTag);
  const evidence = { role: actor.role, signedUp: false, signedIn: false };
  let accessToken = null;
  try {
    const created = await signUp(base, publishableKey, actor.email, actor.password);
    if (!created.ok) {
      evidence.error = created.error;
      return { actor, accessToken, evidence };
    }
    // On the actor BEFORE any further await: a later failure must still leave
    // cleanup able to find the identity that was really created.
    actor.userId = created.userId;
    evidence.signedUp = true;
    evidence.userId = created.userId;
    if (!created.emailConfirmed) await confirmActorEmail(runSql, created.userId);

    const session = await signIn(base, publishableKey, actor.email, actor.password);
    if (session.ok) {
      log(maskLine(session.accessToken));
      accessToken = session.accessToken;
      evidence.signedIn = true;
    } else {
      evidence.signInError = session.error;
    }
  } catch (err) {
    evidence.error = err.message;
    evidence.provisioningFailed = true;
  }
  return { actor, accessToken, evidence };
}

/** Is the canonical K+ authority this probe depends on actually deployed on
 *  the target? Absent means the probe cannot run honestly, and says so. */
export async function canonicalKPlusAuthorityPresent(runSql) {
  const row = firstRow(await runSql(
    `select `
    + `to_regprocedure('public.grant_kplus_complimentary(uuid,text,text,text,timestamptz,timestamptz,text)') is not null as grant_fn, `
    + `to_regprocedure('public.revoke_kplus_grant(uuid,uuid)') is not null as revoke_fn, `
    + `to_regprocedure('public.kplus_has_active_entitlement(uuid,text)') is not null as predicate_fn;`,
  ));
  const present = {
    grant: readBoolean(row?.grant_fn),
    revoke: readBoolean(row?.revoke_fn),
    predicate: readBoolean(row?.predicate_fn),
  };
  return { ...present, all: present.grant && present.revoke && present.predicate };
}

/** The server's own K+ predicate, read through the same function vto-generate
 *  calls. A read: it changes nothing. */
export async function readCanonicalKPlusAccess(runSql, userId) {
  const row = firstRow(await runSql(
    `select public.kplus_has_active_entitlement(${sqlQuote(userId)}::uuid, 'k_plus') as active;`,
  ));
  return readBoolean(row?.active);
}

/** One time-boxed complimentary grant, through the canonical authority. */
export async function grantSyntheticKPlus(runSql, userId, grantKey) {
  if (!GRANT_KEY_PATTERN.test(grantKey)) throw new Error('invalid K+ grant key');
  const row = firstRow(await runSql(
    `select public.grant_kplus_complimentary(`
    + `${sqlQuote(userId)}::uuid, ${sqlQuote(SYNTHETIC_KPLUS_GRANT_SOURCE)}, ${sqlQuote(grantKey)}, `
    + `${sqlQuote(SYNTHETIC_KPLUS_GRANT_CAMPAIGN)}, null, now() + interval '${SYNTHETIC_KPLUS_GRANT_MINUTES} minutes', 'k_plus') as result;`,
  ));
  const result = readJsonColumn(row?.result);
  return {
    outcome: typeof result?.outcome === 'string' ? result.outcome : 'unreadable',
    reason: typeof result?.reason === 'string' ? result.reason : null,
    grantId: typeof result?.grantId === 'string' && UUID_PATTERN.test(result.grantId) ? result.grantId : null,
    accessAfter: result?.accessAfter === true,
  };
}

/** Operator revocation, through the canonical authority. */
export async function revokeSyntheticKPlus(runSql, userId, grantId) {
  if (!UUID_PATTERN.test(String(grantId))) throw new Error('revokeSyntheticKPlus needs a grant id');
  const row = firstRow(await runSql(
    `select public.revoke_kplus_grant(${sqlQuote(userId)}::uuid, ${sqlQuote(grantId)}::uuid) as result;`,
  ));
  const result = readJsonColumn(row?.result);
  return {
    outcome: typeof result?.outcome === 'string' ? result.outcome : 'unreadable',
    reason: typeof result?.reason === 'string' ? result.reason : null,
    accessAfter: result?.accessAfter === true,
  };
}

/** Grants this actor still holds un-revoked. A read, used only so cleanup can
 *  revoke through the authority even when the run crashed before it recorded
 *  the grant id. */
async function unrevokedGrantIds(runSql, userId) {
  const rows = await runSql(
    `select id from public.kplus_entitlement_grants `
    + `where user_id = ${sqlQuote(userId)}::uuid and revoked_at is null;`,
  );
  return (Array.isArray(rows) ? rows : [rows])
    .map((row) => row?.id)
    .filter((id) => typeof id === 'string' && UUID_PATTERN.test(id));
}

/**
 * Pending RevenueCat promotional-mirror work for this actor, or null when the
 * queue does not exist on the target. Revoking a complimentary grant enqueues
 * a mirror-retirement row by trigger; nothing sends it anywhere unless an
 * operator invokes the reconciler, and the row references `auth.users` with
 * ON DELETE CASCADE. Counted so the ledger can SHOW that none is left behind,
 * rather than assert it.
 */
export async function revenueCatMirrorQueueRows(runSql, userId) {
  const present = firstRow(await runSql(
    `select to_regclass('public.kplus_revenuecat_mirror_queue') is not null as present;`,
  ));
  if (!readBoolean(present?.present)) return null;
  const row = firstRow(await runSql(
    `select count(*) as n from public.kplus_revenuecat_mirror_queue where user_id = ${sqlQuote(userId)}::uuid;`,
  ));
  return Number(row?.n ?? 0);
}

/** Actor-scoped counts for the ledger. Never a table-wide count. */
export async function userGarmentActorRowCounts(runSql, userId) {
  const row = firstRow(await runSql(
    `select `
    + `(select count(*) from auth.users where id = ${sqlQuote(userId)}::uuid) as auth_users, `
    + `(select count(*) from public.vto_generation_requests where user_id = ${sqlQuote(userId)}::uuid) as vto_generation_requests, `
    + `(select count(*) from public.kplus_entitlement_grants where user_id = ${sqlQuote(userId)}::uuid) as kplus_grants, `
    + `(select count(*) from public.kplus_entitlement_grants where user_id = ${sqlQuote(userId)}::uuid and revoked_at is null) as kplus_grants_unrevoked, `
    + `(select count(*) from public.user_entitlements where user_id = ${sqlQuote(userId)}::uuid) as user_entitlements;`,
  ));
  return {
    authUsers: Number(row?.auth_users ?? 0),
    vtoGenerationRequests: Number(row?.vto_generation_requests ?? 0),
    kplusGrants: Number(row?.kplus_grants ?? 0),
    kplusGrantsUnrevoked: Number(row?.kplus_grants_unrevoked ?? 0),
    // This probe never writes one, so anything but 0 here is a finding.
    userEntitlements: Number(row?.user_entitlements ?? 0),
  };
}

/**
 * Removes exactly this actor, in order, and records each step:
 *
 *   1. revoke every grant it still holds, through the canonical authority;
 *   2. delete its own quota/reservation rows;
 *   3. delete its identity. The K+ ledger rows reference `auth.users` with
 *      ON DELETE CASCADE, so the schema removes them -- this module still
 *      issues no statement against an entitlement table.
 *
 * Every step is attempted even if an earlier one fails, and the ledger says
 * which did. Never touches a row outside the given user id.
 */
export async function cleanupUserGarmentActor(runSql, { userId, grantId = null }) {
  const ledger = { userId, steps: [], preState: null, postState: null, residual: null, clean: false };
  const step = async (name, action) => {
    try {
      ledger.steps.push({ step: name, ok: true, detail: await action() });
    } catch (err) {
      ledger.steps.push({ step: name, ok: false, detail: err.message });
    }
  };

  await step('read pre-state', async () => {
    ledger.preState = await userGarmentActorRowCounts(runSql, userId);
    return 'recorded';
  });
  await step('revoke K+ through the canonical authority', async () => {
    const ids = new Set(await unrevokedGrantIds(runSql, userId));
    if (grantId) ids.add(grantId);
    const outcomes = [];
    for (const id of ids) outcomes.push((await revokeSyntheticKPlus(runSql, userId, id)).outcome);
    return outcomes.length > 0 ? outcomes.join(',') : 'no grant held';
  });
  await step('delete this actor\'s quota rows', async () => {
    await runSql(`delete from public.vto_generation_requests where user_id = ${sqlQuote(userId)}::uuid;`);
    return 'issued';
  });
  await step('delete this actor\'s identity', async () => {
    await runSql(`delete from auth.users where id = ${sqlQuote(userId)}::uuid;`);
    return 'issued';
  });
  await step('read post-state', async () => {
    ledger.postState = await userGarmentActorRowCounts(runSql, userId);
    ledger.postState.revenueCatMirrorQueueRows = await revenueCatMirrorQueueRows(runSql, userId);
    return 'recorded';
  });

  if (ledger.postState) {
    const post = ledger.postState;
    ledger.residual = post.authUsers + post.vtoGenerationRequests + post.kplusGrants + post.userEntitlements
      + (post.revenueCatMirrorQueueRows ?? 0);
    ledger.clean = ledger.residual === 0 && ledger.steps.every((entry) => entry.ok);
  }
  return ledger;
}

/** The run-scoped cleanup summary the certification artifact carries, in the
 *  shape the shared validator already reads. */
export function summarizeUserGarmentCleanup(ledger) {
  if (!ledger) {
    // No identity was ever created, so there is nothing that could remain.
    return { usersRemaining: 0, entitlementsRemaining: 0, vtoRequestsRemaining: 0, clean: true, ledger: null };
  }
  const post = ledger.postState;
  return {
    usersRemaining: post?.authUsers ?? null,
    entitlementsRemaining: post ? post.kplusGrants + post.userEntitlements : null,
    vtoRequestsRemaining: post?.vtoGenerationRequests ?? null,
    clean: ledger.clean === true,
    ledger,
  };
}
