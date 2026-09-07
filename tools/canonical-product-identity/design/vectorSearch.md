# Future vector search analysis (spec section 38) - ANALYSIS ONLY, nothing built

**QUESTION**: does K Scan have safe visual-identity infrastructure to build Tier 3 (fuzzy/visual) on, and would a vector database help candidate generation?

**FINDING**: `authority/sourceMap.json#productionProductIdentityPipeline.vectorEmbeddingStack` - confirmed `NOT_PROVEN / NOT_FOUND`. No Pinecone/Milvus/pgvector import, no embedding-model API call, no ANN index anywhere in the traced retrieval/ranking stages (`tools/fashion-match-quality/authority/pipelineMap.json`). Matching in production today is text/attribute-based only. Per spec section 15, this lab does not invent a visual-embedding seam that does not exist - Tier 3 is out of scope for V1, confirmed correctly absent from `resolver/` (only Tier 1 and Tier 2 exist).

**PINECONE / MILVUS / NEITHER**: **TBD - NEITHER is recommended for V1's own scope**, and no data exists yet to choose between the two for a future phase. Building an embedding pipeline (choice of vision-embedding model, ANN index, ingestion pipeline) is a separate, substantial engineering investment this lab has no basis to scope from an offline corpus alone.

**IF THIS IS EVER BUILT**: the hard constraint from section 38 must carry forward literally - **vector similarity must never become proof that two products are identical, only candidate evidence**. Concretely: a vector match would feed Tier 3 as `PROPOSED / REVIEW` evidence only (identical decision ceiling to today's Tier 2 - see `resolver/resolvePair.js`'s decision-priority ordering), never as a path to `AUTO_MERGE` on its own, and a Tier 3 hard-negative (Tier 1/Tier 2 conflict) would still block a Tier 3-only proposal exactly as it blocks Tier 2 today.

**REVERSIBILITY**: N/A - analysis only, nothing built, no infrastructure choice made.
