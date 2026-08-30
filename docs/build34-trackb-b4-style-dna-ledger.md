# Build 34 — Track B — Phase B4: Server-Side Style DNA

**Status:** SOURCE COMPLETE — FOCUSED + FULL REGRESSION GREEN (0 new failures vs. baseline) — STAGING MIGRATION NOT YET APPLIED IN THIS ENVIRONMENT
**Scope:** Deterministic, versioned, explainable wardrobe-evidence summary derived server-side from a user's own cloud Closet facts. No Scanner change, no LLM call, no new mobile source.

---

## 1. Source authority

| | Backend |
|---|---|
| B4 parent branch | `maintenance/b34-def001-backend-authority` |
| B4 parent SHA (live-verified) | `ca2d781fb051055408b29c28970b2681414741ae` — identical to the SHA the B2C ledger already recorded as the current backend authority |
| B4 branch | `feature/backend-build34-style-dna-v1` |

`git fetch --all --prune` was run and the live tip was verified with `git log --oneline -1` immediately before branching.

Per the governing addendum's platform-ownership bias (Micro-addendum F), B4 is **backend-only**. No iOS or Android source file was touched, and none was needed: nothing on the client reads or writes Style DNA. The consumer is B5, entirely server-side inside `stylechat-generate`.

---

## 2. Phase-entry question, answered before writing any code

Per the final micro-addendum's mandatory phase-entry question: **before creating any new persistence, is there an existing suitable profile authority?**

Live-inspected: `services/style-dna/*` (client-side, purely local — `localStyleDnaFeedbackStore.ts`, `localStyleDnaPreferences.ts`, `localStyleDnaProfile.ts`), and `supabase/functions/stylechat-generate/styleDnaContext.ts` (server-side, but **purely a pass-through parser of client-supplied feedback-signal counts** — `parseStyleDnaContext(raw)` requires `raw.enabled === true` and trusts `raw.signalCount`/`raw.helpfulCount`/`raw.notMyStyleCount` from the request body; nothing is read from or written to a database). No migration named anything like `style_dna` or `style_memory` creates a per-user aggregate profile table anywhere in this branch's `supabase/migrations/`. `style_memory_events` (from an earlier build) is an **event log** — one row per signal occurrence — not a bounded aggregate profile, and is architecturally distinct from what B4 needs.

**Conclusion: no suitable existing authority exists.** B4 creates exactly one new, narrow, user-level companion table (`user_style_profiles`), per the addendum's fallback data model (Micro-addendum G) — not a redesign of Style Memory or the client-side `styleDnaContext`, both of which are left completely unmodified by this phase.

---

## 3. What was built

| File | Role |
|---|---|
| `supabase/migrations/20260830060000_user_style_profiles.sql` | New table, RLS (SELECT-own-row only, mutation is service_role-only — same pattern as `user_entitlements`), 64 KiB size CHECK, `updated_at` trigger |
| `supabase/functions/_shared/styleDna/styleDnaProfileTypes.ts` | Pure types/constants: `STYLE_DNA_PROFILE_VERSION = 1`, `STYLE_DNA_TOP_N = 10`, the `StyleDnaProfileDataV1` shape |
| `supabase/functions/_shared/styleDna/styleDnaEvidenceRevision.ts` | Pure: the `{MAX(updated_at)}:{COUNT}` V1 fallback evidence revision (Micro-addendum E) |
| `supabase/functions/_shared/styleDna/styleDnaProfileDerivation.ts` | Pure: deterministic aggregation of Closet facts rows into bounded top-10 frequency lists — **no LLM call** |
| `supabase/functions/_shared/styleDna/styleDnaProfileStore.ts` | The only writer of `user_style_profiles`: read-or-recompute orchestrator (Micro-addendum F) — compares evidence revision, reuses on match, recomputes+persists on mismatch |
| `supabase/functions/_shared/deletion/userDataResources.ts` (extended) | `user_style_profiles` added to `USER_DATA_RESOURCES`, same commit as the migration (Micro-addendum L) |
| `lib/account-deletion/user-data-resources.json` (extended) | The Node-side deletion registry mirror, kept in parity |
| `__tests__/styleDnaEvidenceRevision.test.js` | 7 tests |
| `__tests__/styleDnaProfileDerivation.test.js` | 10 tests |
| `__tests__/styleDnaProfileStore.test.js` | 11 tests |

**No `stylechat-generate/index.ts` change, no Scanner file, no `scan-identify` file, no client source file.** B4 delivers the persistence + derivation capability; wiring a caller into `stylechat-generate` is B5's job (Micro-addendum Q — the retrieval/consumption logic belongs inside `stylechat-generate` itself, not a second Edge Function).

---

## 4. The B4/Scanner firewall

`styleDnaProfileDerivation.ts` and `styleDnaProfileStore.ts` import nothing from, and are imported by nothing in, `scan-identify` or any Scanner/classification module. Verified by direct inspection: neither file exists anywhere in `supabase/functions/scan-identify/`, and the new `_shared/styleDna/` directory has zero inbound references from Scanner code on this branch. Style DNA cannot influence what Scanner thinks an item is, because nothing in Scanner's request path reads it.

---

## 5. Data model

```sql
user_style_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  profile_version   integer not null default 1,
  evidence_revision text not null,
  derived_at        timestamptz not null default now(),
  profile_data      jsonb not null,           -- CHECK: object, <=64 KiB
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
)
```

RLS: `authenticated` may `SELECT` only their own row (`auth.uid() = user_id`). No INSERT/UPDATE/DELETE grant to `anon` or `authenticated` — mutation exists only through server code using the service-role client (`styleDnaProfileStore.ts`), identical to the precedent `user_entitlements` already established. Account deletion is fully independent of K+ status, matching the reasoning already stated (and tested) for `user_closet_items`.

**`profile_data` shape** (all fields are bounded, derived aggregates — never an item id, storage path, or raw note):

```ts
{
  evidenceCount: number,
  colorFrequency: { value: string, count: number }[],      // top 10
  categoryFrequency: { value: string, count: number }[],   // top 10
  garmentTypeFrequency: { value: string, count: number }[],// top 10
  brandFrequency: { value: string, count: number }[],      // top 10
  materialFrequency: { value: string, count: number }[],   // top 10
}
```

Five dimensions × 10 entries × a short label and a small integer is on the order of low single-digit KB when serialized — far below the 64 KiB bound, which exists purely as a belt-and-suspenders database backstop (Micro-addendum H), not a target.

---

## 6. Evidence revision (Micro-addendum E)

```
{MAX(updated_at) of the user's non-tombstoned user_closet_items}:{COUNT of same}
```//
e.g. `2026-08-30T04:22:17.123456Z:37`, or `empty:0` for a Closet with no live rows.

This is sufficient because B1A's own update-authority trigger already advances `updated_at` on every authoritative facts or media write, and a deletion changes the live-row count — together these catch every practical evidence change this phase needs to catch, without event sourcing, a Merkle tree, or a new revision service. Proven by test: an edit that changes a field but not the count changes the revision; a deletion changes it too; unrelated re-derivations of the same evidence are byte-identical.

---

## 7. Recompute trigger (Micro-addendum F)

There is no scheduler, cron, worker, or per-item-mutation hook. `getOrRecomputeStyleDnaProfile({ supabase, userId })` is the single entrypoint: it computes the current evidence revision (one bounded `SELECT updated_at, ... WHERE user_id = $1 AND deleted_at IS NULL`), compares it (and the profile-schema version) against the stored row, and only recomputes+upserts when either has changed. A batch of Closet writes (a B3 migration pass, several quick edits) is naturally debounced: nothing recomputes until B5 actually asks, and it asks at most once per Style DNA-relevant request.

---

## 8. Deterministic V1, no LLM (section 30)

`styleDnaProfileDerivation.ts` has zero network imports and makes zero model calls. The same input always produces the same output (pinned by test `DETERMINISM`). Values are case/whitespace-normalized into one bucket (`Acme` / `acme` / `  ACME  ` all count as one), null/empty/whitespace-only facts are never counted, and every output signal is a raw frequency traceable to the exact Closet field it came from — never a psychological or taste inference (section 29's explainability rule: "neutral colors dominate 62%" is expressible from this data; "user is adventurous" is not, and this module never attempts it).

---

## 9. Test coverage

28 new focused tests across three files, all loading the REAL `.ts` modules through the same `typescript.transpileModule` + `vm` harness convention this repository already uses for backend Deno-style modules (`__tests__/edgeStyleDnaContext.test.js` is the direct precedent). One implementation note pinned by trial and error: object/array literals constructed *inside* the sandboxed module belong to a different V8 realm than the test file's own literals, so any whole-object/array comparison must use loose `assert.deepEqual` (`require('node:assert')`), not the `/strict` alias — `assert/strict`'s `deepEqual` checks prototypes and fails on structurally-identical cross-realm values. Individual primitive-field assertions (`assert.equal`) are unaffected either way.

Coverage: empty Closet → valid empty profile; single/dominant/mixed color; brand frequency; case/whitespace normalization; missing fields never counted; >10 distinct values bounded to top 10; determinism (same evidence → byte-identical profile); non-array malformed facts handled without throwing; reuse-vs-recompute on evidence-revision match/mismatch; a profile-version bump always forces recompute even with unchanged evidence; cross-account isolation; closet-read and profile-write failures reported distinctly, never silently fabricating a profile.

**Focused:** `node --test __tests__/styleDnaEvidenceRevision.test.js __tests__/styleDnaProfileDerivation.test.js __tests__/styleDnaProfileStore.test.js` — 28/28 pass.
**Full regression:** `node scripts/run-all-tests.js` — 4833 tests, 4743 pass, 31 fail, 59 pre-existing skips. **All 31 failures are pre-existing** — a baseline run against this exact branch tip with B4's changes stashed reproduces the identical 31 failures (verified directly: `git stash` → rerun → 31 failures, none of them naming `user_style_profiles` → `git stash pop`). B4 introduces **zero new test failures**. One of the 31 pre-existing failures (`USER_DATA_RESOURCES covers all user-linked tables in migrations`) is itself a deletion-registry coverage gap test — its failure output lists several *other*, unrelated tables already missing from the registry before this phase (`apple_auth_credentials`, `wearable_pairings`, etc.); `user_style_profiles` does **not** appear in that failure's missing-table list, confirming B4's own deletion coverage is correctly registered.

---

## 10. Staging

Not applied in this environment (no live Supabase MCP session against the staging project `yzqjvdfgefveprobvvyw` was run for this phase). The migration follows the exact structural precedent (`user_entitlements`) that was already staging-verified for B34's K+ foundation, and the account-deletion coverage addition follows the exact pattern already staging-verified for `user_closet_items`. Applying `20260830060000_user_style_profiles.sql` to staging and re-running the schema/RLS preflight B2B/B2C already used is the concrete next step before this phase can be considered staging-verified.

**Production (`wyyuqfdxucjksghsmhry`) was never contacted.**

---

## 11. Deliberate boundaries

- **Not a Scanner change.** See §4.
- **Not an LLM call.** See §8.
- **Not a second profile system.** Style Memory (`style_memory_events`) and the client-side `services/style-dna/local*` modules are untouched; the existing server-side `styleDnaContext.ts` (client-fed feedback-signal parser) is untouched — B4 does not reinterpret its fields, per Micro-addendum P. A future phase may additively extend that seam; this phase does not.
- **No mobile Style DNA sync path** (Micro-addendum I). Nothing on the client queries `user_style_profiles` directly; B5 consumes it server-side only.
- **No embeddings, no vector database.** Frequency counting only.

---

## 12. B4 handoff

**Ready for B5 to consume:** `getOrRecomputeStyleDnaProfile({ supabase, userId })` from `supabase/functions/_shared/styleDna/styleDnaProfileStore.ts`, callable directly from `stylechat-generate` with either the request's authenticated client or a service-role client. Returns a bounded, versioned, explainable summary or a typed failure reason — never a fabricated profile on error.

**B4 does not build:** any UI, any "Your Style DNA" display surface, any client API, or any wiring into `stylechat-generate`'s prompt assembly. All of that is B5's explicit job.
