# Build 34 — Track B — Phase B5: Elise Wardrobe Context

**Status:** SOURCE COMPLETE — FOCUSED + FULL REGRESSION GREEN (0 new failures vs. baseline) — STAGING VALIDATED (including a live-caught-and-fixed migration bug)
**Scope:** Lets Elise reason over the user's authoritative cloud Closet and server-derived Style DNA, entirely by extending the EXISTING Elise advice pipeline. No new Elise backend, no new Edge Function, no embeddings, no new response protocol.

---

## 1. Source authority

| | Backend |
|---|---|
| B5 parent branch | `feature/backend-build34-style-dna-v1` (B4) |
| B5 parent SHA (live-verified) | `c40165bf...` (B4's final head, pushed and PR #227 open) |
| B5 branch | `feature/backend-build34-elise-wardrobe-context-v1` |

Per the branch train (`B5 may consume the B4 final head`), B5 branches directly from B4 rather than from the closet-client lineage — B5's own work is 100% backend, and the existing Elise advice infrastructure (`eliseAdvicePipeline.ts`, `eliseWardrobeRetrieval.ts`, `eliseAdviceTypes.ts`, `styleDnaContext.ts`, and the rest of `supabase/functions/stylechat-generate/`) already lives on this same lineage — confirmed present, byte-identical to what the earlier research pass found, before writing any B5 code.

---

## 2. The mandatory B5 phase-entry question, answered before writing any code

**What Closet-aware Elise capabilities already exist?** A materially complete deterministic advice pipeline: intent classification, actor-authorized wardrobe retrieval across four pre-existing sources (`saved_scans`, `inspiration_items`, owned/shared Dressing Room items), deterministic compatibility scoring, a bounded (10-item) grounded shortlist, wardrobe-gap analysis, purchase advice, multi-look generation, a structured response contract (`recommendations[]` with `candidateId`/`sourceType`/`actorRelationship`/`score`/`reasonCodes`), and prompt-injection hardening (`escapePromptData`) already applied to every retrieved candidate field.

**Which of them already satisfy B5?** Nearly the entire retrieval → scoring → grounding → structured-response pipeline. The `EliseActorRelationship` union already includes `'owned'`; the `EliseWardrobeSourceType` union already includes `'closet'`; `ELISE_ADVICE_LIMITS.groundedShortlist = 10` already matches this build's own "bound Closet context to ~10 items" requirement exactly; the ownership-language / structured-response separation already exists.

**What exact missing Track B integration remained?** Two things only:
1. The wardrobe data source had no method reading the actual Track B `user_closet_items` table — only pre-Track-B sources.
2. Style DNA existed only as a client-fed, unpersisted feedback-signal parser (`styleDnaContext.ts`) — there was no path from B4's server-derived profile into the prompt.

**Which exact files were extended?** `eliseWardrobeRetrieval.ts` (new optional `listClosetItems` source + retrieval branch), `styleDnaContext.ts` (new additive `buildServerStyleDnaProfileBlock`), `stylechat-generate/index.ts` (wiring: K+ check, profile fetch, data-source construction, prompt assembly, telemetry), `eliseConfig.ts` (one new flag), `telemetry.ts` (two new allowlisted keys).

**What new persistent authority was actually required?** None beyond one narrow write RPC (`upsert_style_dna_profile`) closing a latent gap in B4's own design (§7) — B4's table already existed; B5 adds no new table.

The outcome is smaller than the original roadmap's B5 section implied, which the governing addendum explicitly permits and expects.

---

## 3. What was built

| File | Role |
|---|---|
| `supabase/migrations/20260830070000_upsert_style_dna_profile_rpc.sql` | New SECURITY DEFINER RPC, `authenticated`-only, derives identity from `auth.uid()` |
| `supabase/functions/_shared/styleDna/styleDnaProfileStore.ts` (repaired) | Write path switched from a direct `.upsert()` (which B4's own RLS never actually permitted for an authenticated client) to the new RPC — see §7 |
| `supabase/functions/stylechat-generate/eliseWardrobeRetrieval.ts` (extended) | New optional `listClosetItems` data-source method; a new retrieval branch producing `sourceType: 'closet'`, `actorRelationship: 'owned'` candidates, gated on the SAME `ownerMatches`/`isUuid` authorization every other source already uses |
| `supabase/functions/stylechat-generate/styleDnaContext.ts` (extended) | New `buildServerStyleDnaProfileBlock` — additive, does not touch the existing client-fed `parseStyleDnaContext`/`buildStyleDnaContextBlock` |
| `supabase/functions/stylechat-generate/eliseConfig.ts` (extended) | One new flag, `closetWardrobeContextV1`, default OFF |
| `supabase/functions/stylechat-generate/telemetry.ts` (extended) | Two new allowlisted keys (`kPlusActive`, `styleDnaAvailable`) on the existing `elise_advice_outcome` event — no new event type |
| `supabase/functions/stylechat-generate/index.ts` (extended) | Server-side K+ check, B4 profile fetch (fail-open), Track B closet data-source wiring, prompt assembly, advice-pipeline `signatureStyleSummary` upgrade |
| `__tests__/eliseWardrobeRetrievalClosetSource.test.js` | 7 tests, real modules |
| `__tests__/styleDnaServerPromptBlock.test.js` | 13 tests including 8 prompt-injection cases |
| `__tests__/styleDnaProfileStore.test.js` (repaired) | Fake client updated to mock the RPC instead of a direct upsert — see §7 |
| `__tests__/edgeStyleDnaContext.test.js` (repaired) | Test-harness gap for the new `promptHardening.ts` dependency — see §7 |

**No new Edge Function, no new Elise backend, no new AI provider, no embeddings, no vector store, no new response envelope.**

---

## 4. Reused, not rebuilt

- **Retrieval architecture:** `retrieveAuthorizedWardrobeCandidates` is unmodified in its control flow — a new `if (input.data.listClosetItems)` task branch was added, following the exact shape every existing source branch already uses (own async task, `isUuid` + `ownerMatches` gate, `pushCount` bookkeeping, `try/catch` → `partialFailure`).
- **Scoring / ranking / shortlist bound:** `eliseAdvicePipeline.ts`, `eliseCompatibilityScoring.ts`, and `ELISE_ADVICE_LIMITS.groundedShortlist = 10` are all completely untouched.
- **Prompt hardening:** `buildServerStyleDnaProfileBlock` imports and uses the SAME `escapePromptData` from `promptHardening.ts` that `eliseAdvicePrompt.ts` already uses for every retrieved candidate field — no second sanitizer was written.
- **Structured response / ownership contract:** `EliseWardrobeSourceType` already included `'closet'`; `EliseActorRelationship` already included `'owned'`. No type union was widened. A Track B Closet item flows through the existing `recommendations[].actorRelationship === 'owned'` contract unchanged — the response-side ownership-claim rule (§8) needed zero new code.
- **K+ entitlement:** `has_active_k_plus()`, the SAME RPC RLS on `user_closet_items` already trusts, called via the actor's own JWT-scoped client — no new entitlement table, no new resolution logic, no re-implementation of active/expired/campaign semantics.

---

## 5. K+ server-side enforcement

```
userClient.rpc('has_active_k_plus', {})
```

`has_active_k_plus()` is `SECURITY DEFINER`, derives the caller's identity from `auth.uid()` itself (forge-proof), and is the exact authority `user_closet_items`' own RLS policy already requires. B5 introduces no second entitlement check and no new resolution of "how did this user get K+" — complimentary grant, trial, promotion, admin grant, or a future paid subscription all resolve identically (section 45), because this call never inspects `grant_reason` at all.

**Double-gated, deliberately redundant:** `hasActiveKPlusForWardrobeContext` gates whether `listClosetItems` even exists on the data-source object (an omitted method, not a per-row branch), AND the underlying `user_closet_items` RLS policy independently requires active K+ to return any row at all. A bug that ever let the application-level gate slip would still return zero rows at the database layer — proven live on staging in B4's own validation (§10 of the B4 ledger: a non-K+ session sees 0 Closet rows even via a raw authenticated query).

---

## 6. Ownership claim rule (Micro-addendum Q/S)

A Track B Closet row can only ever become a candidate with `actorRelationship: 'owned'` after: (a) the query itself is RLS-scoped to `user_id = auth.uid()`, and (b) `ownerMatches(row, actorId)` independently re-checks `row.user_id === actorId` before the row is ever normalized into a candidate — the identical defense-in-depth pattern every other source in this file already uses. A malicious or buggy data source that somehow returned another user's row would still have it rejected (`rejectedCount += 1`), never silently authorized — pinned by test `OWNERSHIP GUARD`.

Elise can therefore never say "you own X" about a Track B item without a retrieved, ownership-validated `user_closet_items` row behind the claim, and a general/suggested item the user does not own is never assigned `sourceType: 'closet'` — it can only ever be `discovered`/`saved_product`, which the existing pipeline already keeps structurally distinct.

---

## 7. Defects found and repaired during B5

### Repair — B4's `styleDnaProfileStore.ts` claimed a write path its own migration never actually granted

B4's original doc comment said a caller could pass "either an anon client... or a service-role client" and wrote via `.from('user_style_profiles').upsert(...)`. B4's own migration, however, deliberately granted `INSERT`/`UPDATE` to `service_role` only (matching the `user_entitlements` precedent) — an ordinary authenticated (anon-key + JWT) client was never actually able to perform that write. This was invisible in B4 because B4 had no real caller yet and its own tests used a fake client that didn't enforce real grants.

B5 is the first real caller, and is what surfaces the inconsistency. Repaired by adding `public.upsert_style_dna_profile()` — the SAME `SECURITY DEFINER` RPC pattern `has_active_k_plus()`/`grant_kplus_early_access()` already established — and switching `styleDnaProfileStore.ts`'s write to `supabase.rpc(...)`. This keeps `stylechat-generate` from ever needing a raw service-role key it didn't have before, and keeps the "client is never the personalization write authority" posture (Micro-addendum N) intact. `styleDnaProfileStore.test.js`'s fake client was updated to mock the RPC call; all prior coverage (reuse-vs-recompute, cross-account isolation, failure reporting) is unchanged in substance.

### Repair — a live migration bug caught by staging, not by unit tests

The first version of `upsert_style_dna_profile()` failed on staging with `42702: column reference "user_id" is ambiguous`: the function's `RETURNS TABLE` column names (`user_id`, `profile_version`, ...) become PL/pgSQL variables inside the function body that shadow the identically-named table columns, making `on conflict (user_id)` and the `returning` list ambiguous. This is invisible to a plain syntax check or a fake-client unit test — it only surfaces against a real Postgres planner. Fixed with the standard `#variable_conflict use_column` pragma and re-verified live (insert, idempotent re-upsert, cross-account isolation) — see §10.

### Repair — B4's own comment tripped the deploy-manifest parity scanner

`styleDnaEvidenceRevision.ts`'s comment contained the literal substring `from "changed relevant evidence"` — a coincidental match for the parity scanner's naive `\bfrom\s*['"]...['"]` specifier regex, which strips only block comments, not line comments (`scripts/edge-function-manifest-lib.js`). Invisible in B4 because nothing in `stylechat-generate`'s reachable import graph pulled `_shared/styleDna/*` in yet; B5's own wiring is what makes the file reachable and the scanner trip. Fixed by rewording the comment (no code or scanner change) — reworked prose only.

### No inherited B1/B2/B3/B4 production defects found beyond the above

`eliseAdvicePipeline.ts`, `eliseCompatibilityScoring.ts`, `eliseWardrobeRetrieval.ts`'s pre-existing branches, and `has_active_k_plus()` were all re-read against this branch's live tip and used unmodified.

---

## 8. Session vs. permanent memory (section 51)

B5 adds no write path from a chat message into `user_style_profiles`. The ONLY writer remains `getOrRecomputeStyleDnaProfile`, itself only ever triggered by an evidence-revision mismatch against the user's actual `user_closet_items` facts — never by anything said in a conversation. A remark like "don't use this jacket tonight" therefore cannot silently become permanent Style DNA by construction: there is no code path connecting Elise's chat turn to the profile write RPC. Session-scoped refinement ("make the second one more casual," "don't use that jacket") is left to the pipeline's existing conversational grounding (recent messages + the structured shortlist already in the response) — B5 adds nothing new here and nothing new was needed.

---

## 9. Prompt-injection resistance

`buildServerStyleDnaProfileBlock` treats every wardrobe-evidence value (a color, brand, category, garment type, material — all ultimately traceable to a user-entered Closet field) as untrusted data, escaped through the SAME `escapePromptData` function `eliseAdvicePrompt.ts` already uses for retrieved candidates. `__tests__/styleDnaServerPromptBlock.test.js` plants 8 distinct injection payloads (ignore-previous-instructions, reveal-system-prompt, forged `[SYSTEM]` directives, a K+ grant request, a URL, a SQL statement, an HTML/script tag, and a forged `[/Wardrobe Style DNA]` close-and-reopen attempt) into every one of the five frequency dimensions and asserts: the block's own close marker appears exactly once, at the very end; no raw `<script>`, backtick-fenced SQL, or un-neutralized bracket pair survives past the block's own literal header.

---

## 10. Staging validation (project `yzqjvdfgefveprobvvyw`)

`20260830070000_upsert_style_dna_profile_rpc.sql` was applied live. The first application failed with the ambiguous-column error in §7; the fix was applied as a second migration and re-verified:

| Case | Result |
|---|---|
| Fixture user A calls the RPC (first write) | Row created, `evidence_revision` and `profile_data` match exactly what was passed |
| Fixture user A calls the RPC again with a new revision | Same row updated in place — `count(*) = 1` for user A, confirmed by direct count query (idempotent upsert, not a duplicate) |
| Fixture user B calls the RPC | Own row created; user A's row's `evidence_revision` verified unchanged afterward (cross-account write isolation) |
| Fixture cleanup | 0 residual `user_style_profiles` rows, 0 residual fixture `auth.users` rows, 0 total rows in the table afterward |

**Production (`wyyuqfdxucjksghsmhry`) was never contacted.**

---

## 11. Cost control (section 56)

`listClosetItems` bounds its query to `Math.min(limit, ELISE_ADVICE_LIMITS.initialCandidatesPerSource)` — the SAME per-source cap (40) every existing retrieval source already uses, and the pipeline's own downstream `rankedCandidates`/`groundedShortlist` bounds (24 / 10) apply identically regardless of source. `getOrRecomputeStyleDnaProfile` is called at most once per request and only recomputes on an actual evidence-revision mismatch (B4's own debounce) — it never becomes a second, unbounded query. No retry loop, no regeneration loop, and no new burst/quota mechanism was added; the existing `check_and_increment_stylechat_burst`/daily-quota RPCs continue to gate the request as a whole, unchanged.

---

## 12. Telemetry

Two new bounded boolean keys (`kPlusActive`, `styleDnaAvailable`) added to the existing, already-allowlisted `elise_advice_outcome` event — no new event type, no Closet field, no profile content, no user id ever emitted. `candidateCountsBySource` (already allowlisted) will naturally include a `closet` bucket once Track B rows are retrieved, with no telemetry code change required for that.

---

## 13. Test coverage

**Focused:** `node --test __tests__/eliseWardrobeRetrievalClosetSource.test.js __tests__/styleDnaServerPromptBlock.test.js __tests__/styleDnaProfileStore.test.js __tests__/edgeStyleDnaContext.test.js` — 38/38 pass (7 + 13 + 11 + 7).

**Full regression:** `node scripts/run-all-tests.js` — 4853 tests, 4763 pass, 31 fail, 59 pre-existing skips. **The failure set is byte-identical to the B4 baseline** (`diff` of the sorted failing-test-name lists between the B4 and B5 runs returns empty) — B5 introduces zero new failures. Two transient new failures appeared mid-implementation (the deploy-manifest parity scanner false-positive and the `edgeStyleDnaContext.test.js` harness gap, both in §7) and were fixed before this count.

---

## 14. Deliberate boundaries

- **Not a second Elise.** Every request still flows through the one `stylechat-generate` Edge Function, the one `runEliseAdvicePipeline`, the one response contract.
- **Not a new retrieval architecture.** Structured, deterministic, source-by-source authorization — no embeddings, no vector index, no extra LLM call to select candidates.
- **Not a new response protocol.** `EliseAdviceOutput`/`recommendations[]` unchanged; Track B items simply flow through the existing `candidateId`/`sourceType`/`actorRelationship` fields.
- **No client-supplied wardrobe context is trusted.** The client sends nothing new at all — every Track B candidate and every Style DNA value is retrieved and derived server-side, from the caller's own verified JWT.
- **No new persistent user-data class.** The one migration this phase adds is a write RPC for a table B4 already created and already registered for account deletion.

---

## 15. B5 handoff / Track B closing state

Historical migration (B3) feeds B2B's existing sync engine → cloud Closet facts land in `user_closet_items` → B4 derives a bounded, versioned, explainable Style DNA summary from those facts on demand → B5 lets Elise retrieve authorized Closet items and consume that summary, entirely inside the existing advice pipeline, gated server-side by the same K+ authority throughout. No phase in this train touched Scanner objectivity, introduced a new AI provider, sent unbounded Closet context, or left new persistent user data without deletion coverage.
