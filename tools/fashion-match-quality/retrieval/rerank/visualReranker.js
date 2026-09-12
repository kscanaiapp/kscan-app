'use strict';

/**
 * THE VISUAL RE-RANKER (spec section 7).
 *
 *   L1 CANDIDATES  ->  FASHIONCLIP  ->  NEW ORDER
 *
 * This layer sits strictly DOWNSTREAM of K Scan's existing L1 candidate
 * generation. It is not a retriever and must never become one:
 *
 *   - it does not query a product catalogue,
 *   - it does not add, remove, de-duplicate or truncate candidates,
 *   - it does not consult a vector database of a retailer's inventory,
 *   - it receives the exact candidate list L1 already produced and returns a
 *     PERMUTATION of that list.
 *
 * `rerank()` enforces the permutation property structurally rather than
 * documenting it as an intention: the output is assembled by sorting the
 * input array, so a candidate cannot go missing, and the result is verified
 * against the input's id multiset before it is returned. That matters because
 * a re-ranker that silently dropped the candidates it had no image for would
 * be scored against an easier universe than the control arm (spec section 8),
 * and the resulting comparison would flatter the challenger for free.
 *
 * DEGRADED CANDIDATES. A candidate with no usable image cannot be given a
 * visual score. It is NOT dropped and NOT given a fabricated score - it is
 * ranked below every scored candidate, holding its original relative L1 order
 * among the other unscorable ones. This is the honest behaviour for a
 * re-ranking layer: absence of visual evidence is not evidence of a bad
 * product, but it is also not a reason to promote.
 *
 * DETERMINISM (spec section 7's "stable deterministic sort"). The comparator
 * is a total order, so repeated runs over the same inputs are byte-identical:
 *   1. scorable before unscorable
 *   2. visual similarity, descending
 *   3. ORIGINAL L1 RANK, ascending   <- the meaningful tie-break
 *   4. candidateId, ascending        <- final total-order guarantee
 *
 * Step 3 is a deliberate design choice, not an arbitrary one. Falling back to
 * L1's own ordering on a similarity tie means the re-ranker only ever moves a
 * product when it has positive visual evidence to move it. Where FashionCLIP
 * is indifferent, K Scan's existing ranking - which knows brand, price tier,
 * stock and retailer trust, all of which a pixel model cannot see - is left
 * to decide. A candidateId tie-break alone would instead scramble ties into
 * alphabetical order and destroy L1 information for no reason.
 */

const { cosineSimilarity } = require('../vectorIndex');

const RERANK_STRATEGY_VERSION = 'fashionclip-visual-rerank-v1';

/** Pure visual ordering: similarity alone decides, L1 breaks ties. */
const STRATEGY_PURE_VISUAL = 'PURE_VISUAL';
/**
 * Blended ordering: a convex combination of the visual score and L1's own
 * rank-derived score. Included because the recorded hypothesis predicts that
 * pure visual re-ranking discards commercial signal L1 legitimately knows
 * (stock, purchase path, retailer trust) - so the lab needs to be able to
 * measure that prediction rather than only assert it.
 */
const STRATEGY_BLENDED = 'BLENDED_VISUAL_PLUS_L1';

/**
 * Map an L1 rank (1-based) to a [0,1] score where rank 1 scores 1.0 and the
 * last rank scores 0.0. Linear and explicit; with n === 1 it is 1.0.
 */
function l1RankScore(rank, n) {
  if (n <= 1) return 1;
  return (n - rank) / (n - 1);
}

/**
 * Re-rank one L1 candidate list by visual similarity to the query embedding.
 *
 * @param {object} params
 * @param {number[]} params.queryEmbedding      - embedding of the scan/query image
 * @param {Array<{candidateId:string, embedding:number[]|null, l1Rank:number}>} params.candidates
 *        Every candidate L1 returned, in L1's order. `embedding: null` marks a
 *        candidate with no usable product image.
 * @param {string} [params.strategy]            - STRATEGY_PURE_VISUAL (default) or STRATEGY_BLENDED
 * @param {number} [params.visualWeight]        - blend weight on the visual score, only used by STRATEGY_BLENDED
 * @returns {{rankedCandidateIds:string[], scored:Array<object>, strategy:string,
 *            scorableCount:number, unscorableCount:number, embeddingsUsed:number}}
 */
function rerank({ queryEmbedding, candidates, strategy = STRATEGY_PURE_VISUAL, visualWeight = 0.5 }) {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    throw new Error('rerank requires a non-empty queryEmbedding');
  }
  if (!Array.isArray(candidates)) {
    throw new Error('rerank requires a candidates array');
  }
  if (strategy !== STRATEGY_PURE_VISUAL && strategy !== STRATEGY_BLENDED) {
    throw new Error(`rerank: unknown strategy '${strategy}'`);
  }
  if (strategy === STRATEGY_BLENDED && !(visualWeight >= 0 && visualWeight <= 1)) {
    throw new Error(`rerank: visualWeight must be within [0,1], got ${visualWeight}`);
  }

  const n = candidates.length;

  const scored = candidates.map((c) => {
    const scorable = Array.isArray(c.embedding) && c.embedding.length > 0;
    const visualScore = scorable ? cosineSimilarity(queryEmbedding, c.embedding) : null;
    const rankScore = l1RankScore(c.l1Rank, n);
    // Blending happens on a [0,1] visual score, so the two terms are
    // commensurable: cosine similarity is in [-1,1] and mapping it linearly
    // preserves order while making the weight mean what it looks like.
    const visualScore01 = scorable ? (visualScore + 1) / 2 : null;
    const blendedScore = scorable ? visualWeight * visualScore01 + (1 - visualWeight) * rankScore : null;
    return {
      candidateId: c.candidateId,
      l1Rank: c.l1Rank,
      scorable,
      visualScore,
      l1RankScore: rankScore,
      blendedScore,
      sortScore: scorable ? (strategy === STRATEGY_BLENDED ? blendedScore : visualScore) : null,
    };
  });

  const ranked = [...scored].sort((a, b) => {
    if (a.scorable !== b.scorable) return a.scorable ? -1 : 1; // scorable first
    if (a.scorable && b.scorable && a.sortScore !== b.sortScore) return b.sortScore - a.sortScore;
    if (a.l1Rank !== b.l1Rank) return a.l1Rank - b.l1Rank; // preserve L1 where visually indifferent
    return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
  });

  const rankedCandidateIds = ranked.map((r) => r.candidateId);

  // Structural permutation proof (spec section 8). Not a comment, a check:
  // if this ever fails the experiment is invalid and must not silently run.
  const inputIds = [...candidates.map((c) => c.candidateId)].sort();
  const outputIds = [...rankedCandidateIds].sort();
  if (JSON.stringify(inputIds) !== JSON.stringify(outputIds)) {
    throw new Error(
      'RERANK_UNIVERSE_VIOLATION: re-ranked output is not a permutation of the input candidate set. ' +
        `in=${inputIds.length} out=${outputIds.length}`,
    );
  }

  return {
    rankedCandidateIds,
    scored: ranked.map((r, i) => ({ ...r, rerankRank: i + 1 })),
    strategy,
    visualWeight: strategy === STRATEGY_BLENDED ? visualWeight : null,
    strategyVersion: RERANK_STRATEGY_VERSION,
    scorableCount: scored.filter((s) => s.scorable).length,
    unscorableCount: scored.filter((s) => !s.scorable).length,
    embeddingsUsed: scored.filter((s) => s.scorable).length,
  };
}

/**
 * Rank-movement summary for one case: how far each candidate travelled, which
 * is the raw material for the representative win/loss analysis (spec section
 * 16). Positive `movement` means the candidate moved UP (towards rank 1).
 */
function describeMovement(controlOrder, challengerOrder) {
  const controlRank = new Map(controlOrder.map((id, i) => [id, i + 1]));
  const challengerRank = new Map(challengerOrder.map((id, i) => [id, i + 1]));
  const moves = controlOrder.map((id) => ({
    candidateId: id,
    controlRank: controlRank.get(id),
    challengerRank: challengerRank.get(id),
    movement: controlRank.get(id) - challengerRank.get(id),
  }));
  return {
    moves,
    changedTop1: controlOrder[0] !== challengerOrder[0],
    identicalOrder: JSON.stringify(controlOrder) === JSON.stringify(challengerOrder),
    maxUpwardMovement: moves.reduce((max, m) => Math.max(max, m.movement), 0),
    maxDownwardMovement: moves.reduce((min, m) => Math.min(min, m.movement), 0),
  };
}

module.exports = {
  RERANK_STRATEGY_VERSION,
  STRATEGY_PURE_VISUAL,
  STRATEGY_BLENDED,
  l1RankScore,
  rerank,
  describeMovement,
};
