# K+ Packing Intelligence V1 — build ledger

Build 34 / Phase B. Autonomous build record: what was built, what was reused,
what was deliberately not built, and what an independent hostile audit should
attack first.

**Status: READY FOR INDEPENDENT HOSTILE AUDIT.** Not merged, not deployed, not
enabled. Both kill switches default OFF.

---

## 1. The product claim this build makes

> K Scan AI already knows the traveller's wardrobe, understands what the trip
> requires, and builds something useful out of what they actually own.

A generic packing assistant must ask "what clothes do you have". K Scan AI does
not, and everything below exists to make that difference real rather than
decorative: the plan is assembled from the traveller's authoritative Closet
first, and the screen leads with their own photographs.

## 2. Source authority

| | |
|---|---|
| Phase A parent | `integration/backend-kplus-complimentary-staging-v1` @ `157606c` (the PR #230 merge commit) |
| Post-#230 repair commits on that line | **none** — the live remote HEAD *is* the merge commit |
| Signature Style column-ambiguity repair | already inherited (`4c8caae` + test `206454b`, inside #230) |
| Packing branch | `feature/build34-kplus-packing-intelligence-v1` |
| Start SHA | `157606c` |

Phase A was consumed, never redesigned. No Closet identity, sync, restore,
migration, Signature Style, K+, RevenueCat, deletion, privacy, Scanner or
commerce contract was modified.

## 3. Architecture decisions (B0)

| Decision | Outcome |
|---|---|
| Outfit representation | Reused the existing wardrobe-candidate vocabulary (`EliseWardrobeCandidate`) and the layering roles `eliseFashionFeatures.inferLayeringRole` already derives. **No second garment taxonomy.** |
| Active plan state | `style_chat_messages.ui_blocks` (actor-scoped, RLS-protected, restored on session resume) plus actor-bound session state. Classification: **EXTENDABLE** |
| Persistence | **Option A.** No new table, no new durable personal-travel data class |
| Weather seam | Open-Meteo, already this function's weather authority. Extended to destination + date range. **No new provider, no new credential** |
| UI entry | A dedicated `/packing` route from a home FeatureChip. **No new navigation tab**, not a hidden chat command |

Everything Packing needed already existed inside `stylechat-generate`: JWT
identity, the account-lifecycle gate, the shared Elise burst/daily quota RPCs,
`has_active_k_plus()`, `user_closet_items`, and the server-derived Signature
Style profile. Packing is therefore a **versioned branch of that function**,
selected only by the exact top-level `schemaVersion: "packing-plan-v1"`. A new
Edge Function would have had to re-implement all seven.

**Database changes: NO. New persistence: NO. New Edge Function: NO.**

## 4. The security model is the request order

```
auth → lifecycle → schema → burst → daily quota → K+ → Closet → readiness → provider
```

- A malformed body cannot burn a generation.
- A burst-limited caller never reaches the Closet.
- A lapsed K+ subscriber never reaches the wardrobe.
- A Closet too sparse for an honest plan never reaches the provider.

### Ownership is total by construction

`packingRetrieval.ts` reads `public.user_closet_items` and **nothing else** —
deliberately not `retrieveAuthorizedWardrobeCandidates`, which merges saved
scans, inspiration items and Dressing Room rows. Those are things the traveller
photographed, saved or was shown; Packing may never call any of them owned.

Three independent guarantees, none trusting the client:

| Guarantee | Mechanism |
|---|---|
| Identity | `actorId` comes from the verified JWT, never the request body |
| Ownership | `.eq('user_id', actorId)`, an explicit per-row owner re-check, **and** RLS's own `user_id = auth.uid()` |
| K+ | RLS on `user_closet_items` requires `has_active_k_plus()`, so an expired entitlement returns zero rows even if every gate above it were bypassed |

`packingValidation.ts` then re-resolves every model reference against the
server-authorized shortlist. Hallucinated ids, another account's ids, a
saved-scan candidate smuggled in as owned, an excluded item and an id that was
simply never offered are all **dropped — never patched, never substituted**.

## 5. Candidate engine

```
authoritative Closet (≤40 rows, RLS-scoped)
        ↓  deterministic narrowing — coverage before truncation
bounded shortlist (~14, hard max 18)
        ↓
bounded fashion reasoning (the model)
        ↓
post-model validation (the ownership gate)
```

Selection fills each **required role** round-robin before any role gets a
second item, so a 200-item Closet cannot produce fourteen shirts and no shoes.
Required roles come from the trip's own occasions through the smallest new
mapping the feature needed — a *requirement* vocabulary (dinner, beach, work)
onto the *existing* layering roles. Recency is only ever a tie-break.

Closet readiness: fewer than 5 usable owned candidates ⇒ **GENERAL PACKING
MODE**, a clearly-labelled category checklist derived deterministically from the
same requirement table. It costs no generation, cannot time out and cannot
hallucinate. "I could not read your Closet" and "you own nothing" are different
answers and are reported differently.

## 6. Weather

| Provenance | When |
|---|---|
| `FORECAST` | Geocode + daily forecast both succeeded within the 16-day horizon |
| `SEASONAL` | **Never emitted.** No climate-normals authority exists in this project |
| `UNAVAILABLE` | Everything else — beyond horizon, geocode miss, HTTP error, timeout, all-null window |

`SEASONAL` stays in the contract because the prompt and the UI must be able to
distinguish it, and the handler carries it correctly if a real authority ever
appears. A test sweeps every reachable shape and asserts the shipped resolver
cannot produce it, so the gap is a **recorded decision, not an oversight**
someone later fills with a guess.

Cache: in-memory, keyed on normalized destination + date range, 30-minute TTL,
misses cached too. Ten refinements of one trip are one geocode and one forecast.
No `weather_history` table, no per-user weather profile.

What leaves the function: **the destination string, and nothing else.**
Coordinates come back and are rounded to ~1 km before use.

## 7. Gaps and trust signals

A gap is an **unmet requirement**, never a sales opportunity. Only two things
create one:

1. the trip requires a layering role the Closet cannot fill at all, or
2. the forecast **actually stated** rain, snow or a cold low and the Closet owns
   no outer or mid layer.

Not knowing the weather is not evidence of rain: an `UNAVAILABLE` provenance can
never produce a weather gap. Gaps are derived from a census over the whole
usable owned set — not the shortlist — so a coat that exists but lost its place
to the bound is never reported missing. Capped at three. Nothing in the gap path
can reach a retailer, a catalogue, a price or a product, and the client drops
any gap arriving with one.

Two trust signals ship, both checkable facts:

- **"Works across N looks"** — recomputed from the rendered outfits
- **"Your only outer layer"** — emitted only when the census says exactly one

Anything the model would have to be *believed* about is not a trust signal.

## 8. Refinement

Full regeneration, not an incremental patch framework (addendum §N). There is
exactly **one code path that can install a plan**, which is why the structured
state, the rendered cards and Elise's sentence cannot drift apart.

A refinement sentence takes two routes at once:

1. if it unambiguously names one packed item, that id becomes a **hard
   exclusion** enforced in post-model validation — the boots are gone whether or
   not the model cooperates;
2. the sentence is **also** forwarded as a constraint the model reads, so an
   undecodable refinement still shapes the next plan.

There is no third case where a refinement silently does nothing. Ambiguity is
never resolved by guessing: two black garments and "drop the black one" excludes
nothing and defers to the model, because removing the wrong garment is worse
than removing none.

Trip-scoped intent stays trip-scoped. An exclusion lives and dies with the plan
and touches no preference surface — it is never a Signature Style edit.

## 9. Structure is the authority

The assistant's visible sentence is **rendered from** the validated plan. The
plan is never reconstructed from prose. The client re-derives the header counts
and the reuse badge from what it will actually draw, so a summary can never
disagree with the list beneath it.

## 10. What was measured

Pre-model deterministic cost (`node scripts/measure-packing-performance.mjs`),
200 iterations per case:

| Closet | rows considered | shortlist | prompt chars | ~tokens | retrieval | selection | prompt | total |
|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 0 | 2,498 | 625 | 0.002 ms | 0.009 ms | 0.012 ms | **0.022 ms** |
| 2 | 2 | 2 | 2,837 | 709 | 0.025 ms | 0.006 ms | 0.013 ms | **0.044 ms** |
| 25 | 25 | 14 | 4,913 | 1,228 | 0.170 ms | 0.022 ms | 0.057 ms | **0.248 ms** |
| 50 (one category) | 40 | 14 | 4,941 | 1,235 | 0.195 ms | 0.029 ms | 0.052 ms | **0.276 ms** |
| 200 | 40 | 14 | 4,913 | 1,228 | 0.247 ms | 0.029 ms | 0.057 ms | **0.334 ms** |

A 200-item Closet produces the same bounded shortlist and the same ~1,228-token
prompt as a 25-item one. The provider round trip dominates by orders of
magnitude, so **no optimization was made**: measuring first is what justified
not spending the phase micro-optimizing work nobody would feel.

Cost per plan: one model call. Refinement is one more. Both draw on the existing
shared Elise burst/daily budget — **no second entitlement system**.

## 11. Staging verification (`yzqjvdfgefveprobvvyw`)

Production (`wyyuqfdxucjksghsmhry`) was never touched.

Verified live, read-only:

- All five RPCs Packing depends on exist as `SECURITY DEFINER`:
  `has_active_k_plus`, `kplus_has_active_entitlement`, `recompute_signature_style`,
  `check_and_increment_stylechat_burst`, `increment_stylechat_daily_usage`.
- Every one of the 13 `user_closet_items` columns Packing selects exists with
  the expected type.
- The live SELECT policy is exactly
  `user_id = auth.uid() AND has_active_k_plus()`.

Verified with synthetic fixtures (two actors, since removed):

| Control | Result |
|---|---|
| Golden path — actor A, K+ active | sees exactly A's 3 rows |
| Cross-account — A queries B's row **by id** | 0 rows |
| K+ expired mid-task | `has_active_k_plus() = false`, 0 rows, garments still owned |
| K+ revoked (the other lapse shape) | `has_active_k_plus() = false`, 0 rows |
| Account switch — B on the same connection | sees only B's 2 rows, 0 of A's |
| Stale plan item — garment soft-deleted | stops resolving immediately |
| Anonymous caller | **denied at the GRANT layer**, before RLS |

Two findings worth recording:

- `user_closet_items` **re-stamps `user_id` from `auth.uid()`**, so rows cannot
  be inserted on another account's behalf even by the service role. The fixtures
  had to be written through each actor's own authenticated context.
- Staging held **zero** Closet rows before and after this pass; the fixtures are
  fully removed (verified by explicit count, not by assuming the cascade).

Security advisors: 76, all pre-existing. Packing added no DDL, so it could not
introduce one. The two entitlement-adjacent warnings concern a Phase A trigger
function, and `auth_leaked_password_protection` is the known plan-tier blocker.

## 12. Deliberately not done

- **Not deployed to staging.** `stylechat-generate` is live there at v115 from a
  CLI deploy, and `supabase functions download` failed on this toolchain, so
  deployed-vs-committed parity could **not** be proven. Deploying committed
  source over a possibly-ahead deployment is exactly how this project lost
  `stylist-speech` work before. The Packing branch is unreachable without
  `ELISE_PACKING_INTELLIGENCE_V1_ENABLED=true`, so nothing is blocked by the
  wait — but the drift check is an owner action before any deploy.
- No production write, no production flag, no EAS build, no merge to master.
- No commerce, no shopping handoff, no price, no retailer.
- No drag-and-drop outfit editing.
- No Style Graph, no packing preference profile, no behaviour-learning system.
- No suitcase physics. The Closet stores no volume, so no plan claims to fit any
  bag, and no garment equivalence is ever asserted.

## 13. Carry-in repairs

Three defects found while establishing the regression baseline on the
**unmodified** Phase A authority. All three made governed gates report failures
unrelated to the tree under test, which would have made "0 new material
regressions" unprovable.

| ID | Severity | Encountered during | Location | Repair |
|---|---|---|---|---|
| CARRY-IN-1 | P3 | CI baseline | `.gitattributes` | `*.toml` unpinned ⇒ the one deployable `.toml` checks out CRLF on Windows and the manifest/parity gates fail against an unmodified tree. Worse, regenerating from such a checkout would have written CRLF hashes and broken Linux CI. Pinned to LF. |
| CARRY-IN-2 | P3 | CI baseline | `__tests__/nativeConfigParityGate.test.js`, `scripts/check-native-config-parity.js` | Negative controls wrote the repo's own `app.json` and restored it in `finally`; `node --test` runs files concurrently, so `oauthCallback`'s Apple sign-in test failed in the suite while passing alone. Controls now use an isolated fixture root via a new optional `NATIVE_CONFIG_PARITY_ROOT`. CI still checks the real tree; all four mismatch controls still bite. |
| CARRY-IN-3 | P3 | Backend gate | `supabase/functions/scan-identify/phase2b4CrossPath.test.ts` | Inventory assertion froze a three-name list from Build 3 Phase 4; the governed set has since grown to all 19 functions. Now derived from the functions directory — strictly stronger, since the old literal would also have passed a manifest that silently *dropped* a function. |

Full suite before: 26 observed / 21 known / **5 unexpected**.
Full suite after: 21 observed / 21 known / **0 unexpected**.
Backend gate before: 443 passed / **1 failed**. After: 443 passed / 0 failed.
No gate was weakened, suppressed or removed.

## 14. Gates

| Gate | Result |
|---|---|
| `node scripts/run-all-tests.js` | 21 observed / 21 known / **0 unexpected** |
| `node scripts/run-backend-tests.js` | **522 passed, 0 failed** |
| `npx tsc --noEmit` | clean |
| `deno check stylechat-generate/index.ts` | clean |
| `node scripts/check-edge-function-parity.js` | PASS |
| `node scripts/generate-edge-function-manifest.js --check` | PASS |

New Packing tests: **65 backend + 40 client = 105.**

Inherited red, **pre-existing and not caused by Packing**: the
"Security - Code and Dependencies" workflow already fails on the Phase A
authority itself (both the merge commit and the PR head) with 6 runner-specific
failures that do not reproduce locally. Classified and carried forward per the
starting addendum; the backend step never runs there because the JS suite fails
first, which is why CARRY-IN-3 had gone unnoticed.

## 15. Where a hostile audit should start

1. **The one client-side decision.** Refinement matching runs on the device.
   Its only output is item ids, every id comes from a server-built plan, and the
   server re-resolves them — but this is the single place the client influences
   what gets excluded.
2. **`ui_blocks` is client-written.** A malicious client can write a fabricated
   plan into its *own* session. Nothing cross-account follows (rendering needs
   local Closet rows, and the next generation re-validates server-side), but the
   blast radius deserves a second opinion.
3. **The destination string reaches Open-Meteo.** Intended and minimal, but it
   is a new outbound flow of user-entered text to a third party.
4. **`layeringRole` is a heuristic.** A garment whose category words the
   existing `inferLayeringRole` cannot classify falls into the unroled pool. It
   can still be packed, but it cannot satisfy coverage or a gap check.
5. **Gap copy is a fixed table.** It is small and evidence-gated, but it is
   product copy asserting something about the traveller's wardrobe.

## 16. Remaining risks

**Blocking:** none.

**Non-blocking:**
- Staging deploy deferred pending an owner-run drift check on `stylechat-generate` v115.
- `SEASONAL` is unreachable until a climate-normals authority exists.

**Deferred:**
- Device runtime verification (both platforms) — the flag ships OFF.
- Conversational entry from Elise's own chat routing; Packing V1 is entered from its own surface.

**Pre-existing:**
- The Phase A "Security - Code and Dependencies" red described in §14.
- `auth_leaked_password_protection` on staging (plan-tier, owner billing action).
