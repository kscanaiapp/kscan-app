/**
 * End-to-end actor provisioning: real signup, confirm-if-needed, entitlement
 * seed, sign-in. One function per actor so a run's evidence trail names
 * exactly what happened to each of the three required logical actors.
 */
'use strict';

import { buildActorPlan, signUpActor, confirmActorEmail, seedVtoEntitlement } from './actors.mjs';
import { signInSyntheticUser, maskLine } from './auth.mjs';

const ENTITLEMENT_SCENARIO_BY_ROLE = {
  ACTIVE_KPLUS: 'active',
  NEVER_ENTITLED: 'none',
  EXPIRED_KPLUS: 'expired',
};

/**
 * Provisions all three required actors against the given staging target.
 * Returns { plan, tokens, errors } — tokens are process-local only; callers
 * must never log them (mask via lib/auth.mjs's maskLine on stderr, exactly
 * as the existing synthetic-staging-tests.js does).
 */
export async function provisionVtoActors({ base, publishableKey, runSql, runTag }) {
  const plan = buildActorPlan(runTag);
  const tokens = {};
  const evidence = {};

  for (const role of Object.keys(plan)) {
    const actor = plan[role];
    try {
      const signUp = await signUpActor(base, publishableKey, actor.email, actor.password);
      if (!signUp.ok) {
        evidence[role] = { signedUp: false, error: signUp.error };
        continue;
      }
      // Recorded on the plan (not just locally) BEFORE any further await, so
      // that if a step below throws, actorIdsByRole(plan) can still find
      // this real, already-created auth.users row for cleanup — a crash
      // must never orphan an identity we already know about.
      actor.userId = signUp.userId;

      if (!signUp.emailConfirmed) {
        await confirmActorEmail(runSql, signUp.userId);
      }
      await seedVtoEntitlement(runSql, signUp.userId, ENTITLEMENT_SCENARIO_BY_ROLE[role]);

      const signIn = await signInSyntheticUser(base, publishableKey, actor.email, actor.password);
      if (signIn.ok) {
        console.error(maskLine(signIn.accessToken));
        tokens[role] = signIn.accessToken;
      }
      evidence[role] = {
        signedUp: true,
        userId: signUp.userId,
        entitlementScenario: ENTITLEMENT_SCENARIO_BY_ROLE[role],
        signedIn: signIn.ok,
        signInError: signIn.ok ? null : signIn.error,
      };
    } catch (err) {
      // A real signup may already have created an auth.users row before a
      // post-signup SQL step failed (observed live: a transient `supabase db
      // query --linked` failure inside confirmActorEmail left an orphaned
      // synthetic user because this loop used to let the exception escape
      // provisionVtoActors entirely, before the caller's cleanup-guaranteeing
      // try/finally ever started). Recording the partial evidence here — and
      // never rethrowing — is what lets actorIdsByRole(plan) still surface
      // this actor's userId (already on `actor` above) so cleanup can find
      // and remove it, and lets the OTHER actors still get provisioned.
      evidence[role] = { signedUp: Boolean(actor.userId), userId: actor.userId ?? null, error: err.message, provisioningFailed: true };
    }
  }

  return { plan, tokens, evidence };
}

/** userId -> role lookup, used by cleanup and report evidence. */
export function actorIdsByRole(plan) {
  const out = {};
  for (const [role, actor] of Object.entries(plan)) {
    if (actor.userId) out[role] = actor.userId;
  }
  return out;
}
