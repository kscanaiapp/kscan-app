# Build 35 — Packing and Wardrobe Concierge refinement quality

Development build record. **Not a certification.** No merge, no deploy, no EAS,
no Supabase mutation.

Target behaviour: **small user correction → small, intelligent system correction**,
not a new answer.

## A. Authority

```
BUILD35_BASE_BRANCH  fix/notifications-final-convergence-v1
BASE_SHA             d66f03d6  (Merge PR #414; tip of the Build 35 authority at start)
UPSTREAM_SHA         d66f03d6  (origin/fix/notifications-final-convergence-v1, fetched 2026-09-22)
BRANCH               feature/build35-packing-concierge-refinement-quality
WORKTREE             C:/src/B35-PCQ2-20260922 (fresh; npm ci; own node_modules)
WORKTREE_CLEAN       YES at start
```

## B. Architecture as found (source, not docs)

Both refinement authorities are **deterministic readers inside `stylechat-generate`**;
the model is only asked for styling.

**Packing** — `packingRefinementIntent.interpretPackingRefinement` reads the message into
ops → `packingPlannerHandler.runPackingPlannerV2` applies them to the verified prior
`plan.state` (client-held, ids/codes only, re-verified against this actor's Closet) →
`packingTripPlanner.planPackingTrip` enforces rejections, pins, caps, consolidation →
at most one model call, for the slots being restyled only. State carries slots, pins,
rejections, rejected classes and allow-listed constraint codes. Restore semantics exist
(rejections are restorable). Client: `usePackingPlan.refineWith` → `packingClient`.

**Concierge** — `eliseAdvicePipeline.runEliseAdvicePipeline` → `eliseOutfitState`
(`readRefinementDirectives` → `planRefinement` → `applyRefinementExclusions` →
`projectOutfitState`). State (`concierge_outfit_state`) rides in the assistant
message's existing `ui_blocks`; untrusted on return (exclusion-only, retention
re-verified). Looks are composed deterministically by `buildMultiLooks` from the
shortlist order. StyleChat single-flights sends (`isSendingRef`).

Precedence (explicit request → task state → Closet facts → Signature Style →
heuristics) already existed in both prompts; it was not changed.

## C. What was broken (measured on the unmodified code)

Probes drove the real handler/pipeline with a stub stylist that cites only offered ids.

**Packing** — 27 refinement turns, 4-day trip:

| Message | Before | Cause |
|---|---|---|
| "Different shoes", "Change Friday's shoes", "Only two pairs of shoes", "Just one pair", "Not black", "Make it warmer", "It's colder than expected", "Go back", "I don't own that anymore" | fell through to free text: **all 6 looks restyled**, 1 model call, tops/trousers changed too | no op for role swap, counts, colour/material exclusion, warmth; "go back" not recognised; "Friday's" not read as Friday |
| "I don't want black" | **"Leaning into black"** — black boots and heels packed | colour preference reader ignored negation |
| "Why did you pack two blazers?" | **"Switching to blazers"** — a blazer added to every casual look | a question read as `prefer_class` |
| "Keep everything except Saturday" | **pinned Saturday** (the day to change) | no `except` handling |
| "Keep Friday daytime, change dinner" | **pinned both Friday looks**; dinner never changed | ", change" not a clause boundary; no day carry-over |
| "Keep these pants" | *"I don't see a these pants in your Closet"* (false absence) | umbrella word "pants" vs jeans/trousers; determiner not stripped |
| "Carry-on only" | answered as a question; nothing recorded | constraint and question conflated |
| any restyle that returned the same look | "Only Friday dinner changed." | copy from the regenerate set, not the result |

**Concierge** — same 10-piece Closet:

| Message | Before |
|---|---|
| "Different shoes" | **every shoe excluded**; the next shortlist had none |
| "No heels", "No blazer", "Not black", "Too formal", "Another" | read as a **new outfit**: continuity and all earlier exclusions silently dropped, and the new exclusion never applied |
| "I don't like those boots" | the whole **boot class** rejected |
| "Keep the jacket, change everything else" | nothing kept (the look's blazer is not class "jacket"; bucket-only rows have no layering role) |
| "Something different for the beach" after dinner | continued the dinner outfit with its exclusions |

## D. What changed

### Packing (all deterministic; 0 model calls unless restyling is asked for)

| Request | New behaviour |
|---|---|
| different / other / swap / change + role or garment | `replace_role`: swaps only that role in the targeted looks. Trip-wide = rejection of those pieces (restorable); day-scoped = slot exclusion for this run, and the day's pairs are never traded between its looks. No alternative owned → kept, and said so |
| "only two pairs", "one jacket only", "fewer shoes" | `max:<role>:<n>` constraint; a trip-wide planner stage re-plans that role only; strict occasions keep a proven piece; unreachable limits are reported (`max_role_conflict`), never silently exceeded or forced |
| "carry-on only" | `carry_on` + `pack_light` + `max:shoe:2`; fit is never claimed (no volume data). "Will this fit in a carry-on?" stays a question |
| "not black", "I don't want black", "no black shoes", "no leather" | `not_color` / `not_material` hard exclusions on **positive evidence only**; a piece with no recorded colour/material is kept and the copy says it cannot be confirmed. "No black shoes" rejects black shoes by id — never every shoe |
| "warmer", "colder than expected", "lighter layers" | adds (or drops) one layer per look from the item's own warmth words; never rewrites the rest; lighter never strips rain/cold protection |
| "why …?" | answered from the finished plan; no state change |
| "keep everything except Saturday", "keep Friday daytime, change dinner" | only the named looks restyle; nothing pinned behind the traveller's back; a day named earlier in the message scopes a later occasion |
| "go back" | restores the last removal; with nothing removed says so (no restyle) |
| "I don't own that anymore" | uses the structured selection (`resolvedItemId`); without one, asks — never guesses. "I don't own the loafers anymore" removes them from this plan and says the Closet still lists them (no Closet write) |
| what changed | `plan.changes` (ids only) + copy per swap ("Friday dinner: brown loafers → white sneakers. Everything else stays the same.") |

### Concierge

| Request | New behaviour |
|---|---|
| "no heels", "no blazer" | class exclusion, and the outfit **continues** |
| "not black", "nothing black" | `not_color:*` constraint; persists; positive-evidence only, unknown colours flagged `UNVERIFIED` in the prompt |
| "no leather" | `not_material:*` only when this Closet's own records use the word |
| "the loafers", "those boots" | the piece by id (presented look first); two plausible pairs → question; never broadened to a class |
| "different shoes", "swap the jacket" | replaces the presented piece of that role; the rest of the presented look is **preserved** (leads the shortlist so the deterministic look builder keeps it) |
| "too formal", "don't overdress me", "less formal" | `less_formal`; exactly one wrong-side piece (outer, then shoe, then bottom — read by the shared Packing formality facts) is moved; the rest preserved |
| "keep the jacket" | umbrella role resolves the blazer the look actually holds |
| "the second one", "look 2" | resolved against the **structured** looks recorded in state; out-of-range is reported |
| "the other one", "that" | one candidate → resolved; several → `AMBIGUOUS` question, nothing removed |
| "that's a cardigan, not a blazer", "navy, not black" | `correct:*` constraint for this task; prompt says do not claim the Closet changed |
| "make it red" | `prefer_color:red`; the same scorer ranks a slightly wider window so a red piece can surface; outranks Signature Style |
| "another" (bare) | variation; exclusions kept |
| new occasion / "what should I wear to…" / "something … for the beach" | new task; old exclusions dropped |
| continuation | task intent and occasion tokens carry over, so "different shoes" is still the dinner outfit |

State additions are optional and additive (`intent`, `occasionTokens`, `looks`); an
older block restores exactly as before. Ids, enums and vocabulary tokens only.

### Shared semantics (one authority each)

| Concept | Authority | Used by |
|---|---|---|
| garment class | `eliseOutfitState.garmentClassOf` | Packing, Concierge (unchanged) |
| umbrella role ("pants", "shoes", "jacket") | **new** `eliseOutfitState.layeringRoleOfWord` — replaces Packing's private `ROLE_BY_WORD` copy | Packing, Concierge |
| refinement role of a piece | **new** `eliseOutfitState.refinementRoleOf` | Concierge planner + pipeline |
| colour words | `eliseFashionFeatures.COLOR_TOKENS / colorTokensOf` | both (unchanged) |
| formality band | `packingGarmentFacts.formalityBandOf` | Packing, and now Concierge's "less formal" step |
| warmth evidence | `packingGarmentFacts.hasWarmthEvidence` | Packing |
| chips | **new** `services/refinementChips.ts` — each chip is a sentence sent through the same path as typed text | Packing screen (Concierge mount deferred, §N) |
| refinement ordering | **new** `services/packing/packingRefinementSequence.ts` (ordering only) + request generation in `usePackingPlan` (same idiom as `useCloset`) | Packing |

The refinement STATE types stay deliberately separate (a trip plan vs a single
look), as both earlier lanes documented.

## E. Before / after (same fixtures, same stub stylist)

**Packing, 27 refinement turns:** pieces changed **156 → 50**; model calls **15 → 6**
(the 6 are genuine restyle requests). For shoe-only requests, non-shoe pieces changed
**18 → 0** per request.

| Sequence | Before | After | Preserved | Changed |
|---|---|---|---|---|
| "Different shoes" | 12 pieces in 6 looks, 1 call | 6 pieces (shoes only), 0 calls | every top, bottom, layer | both pairs → boots |
| "Change Friday's shoes" | 12 pieces, whole trip, 1 call | 2 pieces, Friday only, 0 calls | Thu/Sat/Sun untouched | Friday's shoes |
| "Just one pair of shoes" | 12 pieces, 1 call | 2 pieces, 0 calls | every non-shoe piece | dinners: loafers → sneakers |
| "Only two pairs" (already 2) | 12 pieces, 1 call | 0 pieces | everything | — |
| "No blazer" → "Make it warmer" | warmer restyled all 6 looks: "Your plan is up to date." | 3 looks gain the wool sweater, 0 calls | every piece; still no blazer | +sweater |
| "I don't want black" | packed black boots and heels | black pieces out, 0 calls | non-black pieces | 4 pieces |
| "Why did you pack two blazers?" | blazer added to 4 looks | answer only | everything | — |
| "Keep everything except Saturday" | pinned Saturday | Saturday restyled, 1 call | Thu/Fri/Sun | Saturday |
| "Go back" (after loafers removed) | 10 pieces restyled | loafers restored, 0 calls | everything else | 2 pieces |

**Concierge** (deterministic contract; prose quality needs a live model):

| Sequence | Before | After |
|---|---|---|
| dinner → "Different shoes" | 0 shoes left | 1 pair excluded; blouse, trousers, blazer preserved; task stays `occasion_fit` |
| dinner → "No heels" → "Make it warmer" | "No heels" started a new outfit; heels back | heels excluded on both turns |
| dinner → "Not black" → "Make it warmer" | new outfit; nothing excluded | `not_color:black` persists; black pieces out |
| dinner → "Make it less formal" | constraint only; same shortlist | blazer moved; blouse + trousers preserved |
| dinner → "I don't like those boots" → "Another option" | boot class rejected | that pair only; it does not return |
| dinner → "Keep the jacket, change everything else" | nothing kept | the blazer kept |
| dinner → "No heels" → "Something different for the beach" | continued with heels excluded | new task, exclusions dropped |

## F. Ownership

Unchanged guarantees, re-tested: every Packing piece must resolve to this actor's owned
Closet (`assertPackingOwnership`); Concierge state is exclusion-only and a forged
`owned`/look/intent cannot add a piece (new test with forged `looks` and `intent`).
Chips send text; nothing on the client can mark an item owned. Corrections never write
the Closet.

## G. Gap truth

No gap logic changed. Confirmed / unconfirmed grading (`derivePackingCoverageGaps`) and
the absence-prose guard are untouched; "colder than expected" now records
`condition:cold`, so a Closet with no warm layer gets the existing evidence-bound gap.

## H. Commerce boundary

No Commerce path was added or changed. Refinements (including "warmer") search owned
pieces only; a continuation inherits the task intent, so it cannot become a shopping
intent. Packing's external ideas still need a confirmed gap AND an explicit ask.
"Find me some shoes to buy" still activates the existing path; "I don't own shoes for
this. Find me some." does not (the existing `intentAllowsCommerce` needs buy/shop) —
recorded as `COMMERCE_V2_FOLLOWUP`, not changed here.

## I. Model / cost

```
MODEL_CALLS_FULL_PLAN              1
MODEL_CALLS_REFINEMENT_BEFORE      1 for 15 of 27 probe turns (whole-trip restyles)
MODEL_CALLS_REFINEMENT_AFTER       0 for every deterministic op; 1 only for restyle
                                   requests, and only for the targeted slots
ADDITIONAL_MODEL_CALLS_PER_REFINEMENT  0
NEW_PROVIDER                       NO
NEW_DEPENDENCY                     NO
Concierge                          1 call per turn, unchanged; prompt grows only on
                                   continued turns (UNCHANGED / AMBIGUOUS / CORRECTION lines)
```

## J. Backend boundary

```
DATABASE_SCHEMA_CHANGED   NO
MIGRATION_CHANGED         NO
EDGE_FUNCTION_DEPLOYED    NO   (source-only changes to stylechat-generate)
STAGING_MUTATED           NO
PRODUCTION_MUTATED        NO
SECRETS / RLS / STORAGE   untouched
```

Flagged: `config/edge-function-manifest.json` was regenerated for `stylechat-generate`
entries only (it pins source hashes; required whenever that function's source changes).
A first regeneration hashed CRLF working copies; it was redone from LF sources in its own
commit, and `check-edge-function-parity` + `edgeFunctionSourceParity` pass.

## K. Performance

See the PR body for measured deterministic server-side time. Real model latency was not
measured (no live call). The structural gain is that most refinements no longer make the
model call at all.

## L. UX

* Packing refinement chips: Lighter layers, Warmer, Fewer shoes, More repeats, No heels,
  Carry-on only. Constraint chips show "on" only once the plan's state says so and are
  then disabled; action chips never toggle. Tap = `selectionTick()` from the shared
  `services/haptics` authority. Only local optimistic state: which chip is pending.
* `UPDATED` badge on looks the last refinement changed; message names each swap.
* Accessibility: chips have roles, labels ("…, already applied") and selected/busy state.

## M. Tests

See PR for exact totals. New: `packingRefinementQuality.test.ts` (28),
`conciergeRefinementQuality.test.js` (26), `refinementChipsAndSequence.test.js` (9).
Negative controls (applied, run, restored byte-for-byte; none committed):

| ID | Mutant | Result |
|---|---|---|
| NC-1 | Concierge preservation disabled | 2 fail |
| NC-2 | Packing role swap ignored | 4 fail |
| NC-3 | max-role limit not enforced | 2 fail |
| NC-4 | attribute exclusion never matches | 2 fail (after making the leather test non-vacuous) |
| NC-5 | bare negation reads as a new outfit again | 15 fail |
| NC-6 | specific rejection broadened to class | 1 fail |
| NC-7 | explain question falls through to a change | 1 fail |
| NC-8 | stale-completion guard removed | 1 fail |
| NC-9 | continuation drops prior exclusions | 1 fail |

## N. Deferred

* `SHARED_SURFACE_FOLLOWUP_REQUIRED` — Concierge chips: semantics shipped and tested
  (`CONCIERGE_REFINEMENT_CHIPS`), but mounting them needs a send callback through
  `StyleChatBubble` and the StyleChat session screen, which the active Elise
  Conversation Quality V2 lane owns. Same for any Concierge-specific "UPDATED" marker.
* `SHARED_SURFACE_FOLLOWUP_REQUIRED` — `eliseAdvicePipeline.ts` / `eliseOutfitState.ts`
  are Elise surfaces; the Elise Q2 lane (branch created at the same base, no commits yet)
  must rebase over or merge with these.
* `VOCABULARY_FOLLOWUP_REQUIRED` — Concierge normalisation ignores `clothing_type`, so a
  bucket-only `outerwear`/`bottoms` row has no layering role in the scorer. Worked around
  inside refinement (`refinementRoleOf`); the scorer table was not changed.
* `VOCABULARY_FOLLOWUP_REQUIRED` — no shared material vocabulary exists; material
  exclusions match the Closet's own recorded words.
* `RESTORE_FOLLOWUP_REQUIRED` — "go back" restores removals only; there is no plan
  history, so a formality/colour change cannot be undone to the previous plan.
* `SCHEDULE_FOLLOWUP` — "Friday is actually dinner, not casual" changes the trip's
  schedule, which is client-held; it still goes through the trip form.
* `COMMERCE_V2_FOLLOWUP` — see §H.
* `HAPTICS` — reused the landed authority; no follow-up.
* Device QA, live-model sampling, staging deploy of `stylechat-generate` (drift check
  first) — not done in this lane.
