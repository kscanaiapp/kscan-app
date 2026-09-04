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
    const signUp = await signUpActor(base, publishableKey, actor.email, actor.password);
    if (!signUp.ok) {
      evidence[role] = { signedUp: false, error: signUp.error };
      continue;
    }
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
