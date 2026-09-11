'use strict';

/**
 * Control arm (spec section 9): "the existing K Scan production-identical
 * ranking/retrieval path already exercised by Fashion Match Quality."
 *
 * This wraps `../l1/runL1.js#runL1ForFixture` UNMODIFIED - it does not
 * reimplement production ranking (spec section 9's explicit "do not rewrite
 * the production ranking algorithm merely to create the control"), and it
 * is SYMMETRICALLY gated the same way the FashionCLIP challenger arm is:
 * L1 shells out to Deno (see runL1.js's own header for why), and this
 * sandbox's `deno` binary is not on PATH (confirmed: `which deno` finds
 * nothing here, same as the 4 skipped tests already visible in FMQ's own
 * suite - `l1/runL1.test.js`). So the control arm's real ranking is ALSO
 * unavailable in this session, not only the challenger's. Reporting both
 * arms' blocked status side by side is the honest picture; the report this
 * lab produces never hides one blocker while showing the other.
 */

const { runL1ForFixture, isDenoAvailable } = require('../l1/runL1');

/**
 * @param {object} fixture - an FMQ fixture
 * @returns {{ok:true, rankedCandidateIds:string[]} | {ok:false, blocker:string, detail:string, rankedCandidateIds:[]}}
 */
function runControlArm(fixture) {
  const l1Result = runL1ForFixture(fixture);
  if (!l1Result.ok) {
    return { ok: false, blocker: l1Result.blocker, detail: l1Result.detail, rankedCandidateIds: [] };
  }
  const ranked = l1Result.ranked || [];
  return { ok: true, rankedCandidateIds: ranked.map((c) => c.id) };
}

module.exports = { runControlArm, isDenoAvailable };
