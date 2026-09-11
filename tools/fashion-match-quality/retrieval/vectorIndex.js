'use strict';

/**
 * Local brute-force cosine-similarity vector index (spec section 7/10).
 *
 * R&D scale here is a handful to a few dozen candidates (the FMQ synthetic
 * fixture universe - see buildIndex.js), so a linear scan is the correct,
 * simplest tool: no ANN library, no production vector-store dependency, per
 * spec section 7's explicit "do not add a production Pinecone/Milvus
 * dependency merely to conduct the experiment." Every index record's shape
 * (candidateId, embedding, modelRevision, sourceFixtureId, ontology, ...) is
 * exactly what a governed vector layer would need if this is ever promoted -
 * see buildIndex.js's header for the full metadata contract.
 *
 * DETERMINISM (spec section 17): ranking is a pure function of
 * (queryEmbedding, index contents) - no randomness, no Map/object iteration
 * order dependency (candidates are stored and scanned as an array). Ties in
 * similarityScore are broken by `candidateId` ascending, a total order, so
 * two candidates can never compare equal and repeated runs against the same
 * index always produce byte-identical ranked output.
 */

function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * @param {Array<{candidateId:string, embedding:number[], modelRevision:string, [key:string]: any}>} candidates
 */
function buildIndex(candidates) {
  const seen = new Set();
  for (const c of candidates) {
    if (typeof c.candidateId !== 'string' || c.candidateId.length === 0) {
      throw new Error('every indexed candidate requires a non-empty candidateId');
    }
    if (seen.has(c.candidateId)) {
      throw new Error(`duplicate candidateId in index: ${c.candidateId}`);
    }
    seen.add(c.candidateId);
    if (!Array.isArray(c.embedding) || c.embedding.length === 0) {
      throw new Error(`candidate ${c.candidateId} has no embedding`);
    }
  }
  return { candidates: candidates.slice(), size: candidates.length };
}

/**
 * Rank every indexed candidate against `queryEmbedding` and return the top
 * `topK`, stably ordered (similarityScore desc, candidateId asc on ties).
 *
 * @returns {Array<{candidateId:string, rank:number, similarityScore:number, modelRevision:string}>}
 */
function query(index, queryEmbedding, { topK = 10 } = {}) {
  const scored = index.candidates.map((c) => ({
    candidateId: c.candidateId,
    similarityScore: cosineSimilarity(queryEmbedding, c.embedding),
    modelRevision: c.modelRevision,
  }));

  scored.sort((a, b) => {
    if (b.similarityScore !== a.similarityScore) return b.similarityScore - a.similarityScore;
    return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
  });

  return scored.slice(0, topK).map((entry, i) => ({ ...entry, rank: i + 1 }));
}

module.exports = { cosineSimilarity, buildIndex, query };
