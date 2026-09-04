/**
 * Cleanup for the VTO E2E harness (spec §14). Targets ONLY the exact
 * synthetic actor ids this run created — never a broad table sweep. Runs on
 * both success and failure paths (see run.mjs's finally block).
 */
'use strict';

import { actorRowCounts, cleanupActor } from './actors.mjs';

/**
 * @param {(sql: string) => Promise<any>} runSql
 * @param {Record<string, string>} actorIdsByRole - role -> userId
 * @returns evidence object: PRE-STATE / REMOVED / POST-STATE / RESIDUAL, per actor.
 */
export async function cleanupVtoActors(runSql, actorIdsByRole) {
  const evidence = {};
  for (const [role, userId] of Object.entries(actorIdsByRole)) {
    const preState = await actorRowCounts(runSql, userId);
    await cleanupActor(runSql, userId);
    const postState = await actorRowCounts(runSql, userId);
    const residual = postState.authUsers + postState.userEntitlements + postState.vtoGenerationRequests;
    evidence[role] = {
      userId,
      preState,
      postState,
      residual,
      clean: residual === 0,
    };
  }
  return evidence;
}

export function allActorsClean(cleanupEvidence) {
  return Object.values(cleanupEvidence).every((e) => e.clean);
}

/**
 * Aggregates per-actor cleanup evidence into the run-scoped residual counts
 * the certification artifact must carry (repair spec §16): exactly the rows
 * THIS run's own actors could have left behind, summed across roles from
 * their individually-scoped POST-STATE counts — never a global table count,
 * and never "staging has zero synthetic users" as a whole.
 */
export function summarizeCleanupStatus(cleanupEvidence) {
  const actors = Object.values(cleanupEvidence);
  const sum = (key) => actors.reduce((total, e) => total + (e.postState?.[key] ?? 0), 0);
  return {
    usersRemaining: sum('authUsers'),
    entitlementsRemaining: sum('userEntitlements'),
    vtoRequestsRemaining: sum('vtoGenerationRequests'),
    clean: allActorsClean(cleanupEvidence),
    perActor: cleanupEvidence,
  };
}
