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
