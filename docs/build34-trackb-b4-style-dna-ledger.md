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

## Live staging authority proof (PR #230 closure)

`recompute_signature_style()`'s initial migration
(`20260830131956_signature_style_server_authority.sql`) failed on staging on
its very first query for every caller: `RETURNS TABLE(user_id uuid, ...)`
declares `user_id` as an implicit PL/pgSQL variable, and Postgres refused the
resulting bare `user_id` references inside the function body as ambiguous
(`42702`) — the same defect class `upsert_style_dna_profile` hit once before.
Fixed in the same migration set
(`20260830140000_fix_recompute_signature_style_column_ambiguity.sql`) with the
same `#variable_conflict use_column` pragma, then re-verified live end to end
against real, disposable K+ fixture actors on staging (`yzqjvdfgefveprobvvyw`):

- a valid K+ actor's own Closet evidence derives and persists the expected
  bounded profile, and a second call with unchanged evidence reuses it
  (`recomputed: false`) rather than recomputing;
- the legacy client-payload RPC (`upsert_style_dna_profile`) is denied
  (`42501`) to an ordinary authenticated caller — no service role used;
- a non-K+ actor is denied (`42501`) and never gets a written row;
- a second actor's row is invisible under RLS even to a direct filtered
  query, and the function itself takes no arguments, so no caller can name
  another account's id;
- a persisted row corrupted to a non-array `brandFrequency` shape, with its
  `evidence_revision` left matching the actor's live evidence, is rebuilt
  (`recomputed: true`) rather than echoed back;
- deleting a fixture actor's `auth.users` row cascades away its Signature
  Style row, Closet rows, and entitlement row with no separate cleanup
  statement, confirming account-deletion coverage.

All fixtures (two synthetic auth users, their Closet rows, entitlements, and
resulting profile rows) were removed by the end of the proof; staging holds
zero residual rows in `user_style_profiles` and `user_closet_items`.
