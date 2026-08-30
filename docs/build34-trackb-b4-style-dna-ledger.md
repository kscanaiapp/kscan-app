# Build 34 — Track B — Phase B4: Server-Side Signature Style

## Current authority

Signature Style is a bounded, deterministic, server-derived summary of the
authenticated K+ user's live `user_closet_items`. It contains only aggregate
frequencies (up to ten values per dimension), an evidence count, and a
server-derived revision (`empty:0` or UTC max `updated_at` plus live-row count).
It does not use an LLM, media, embeddings, Scanner output, or client-authored
profile data.

The only public write request is `recompute_signature_style()`. The RPC accepts
no arguments, derives the actor from `auth.uid()`, verifies `has_active_k_plus()`,
reads only that actor's non-tombstoned Closet rows, and upserts the profile.
The earlier payload-bearing compatibility RPC has no execute grant for ordinary
roles. Malformed stored data does not qualify for reuse and is rebuilt from the
authoritative Closet evidence.

## Storage and privacy

`user_style_profiles` remains an existing compatibility table with own-row RLS,
an object and size check, and account-deletion coverage. It is not a mobile sync
surface. The server function is the sole deterministic derivation definition;
the Edge Function merely requests that trusted recomputation and treats an
unavailable result as optional context.

## Boundaries and verification

Signature Style is advisory to Elise only. It has no path to Scanner objective
identification. The guarded profile shape is aggregate-only: colors, categories,
garment types, brands, and materials, each capped at ten entries.

The Build 34 integration tests cover zero-argument authority, K+ enforcement,
actor-scoped live Closet reads, lack of client payload/revision input, compact
deterministic output, reuse on a valid matching revision, and self-healing when
a stored profile is malformed.
