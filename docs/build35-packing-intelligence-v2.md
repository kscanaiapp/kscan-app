# Build 35 — Packing Intelligence V2: the day-by-day trip planner

Development build record. **Not a certification.** No merge, no deploy, no EAS.

## A. Authority

```
BASE_BRANCH       fix/notifications-final-convergence-v1
BASE_SHA          254f5dc4943d011c503374572795ab29f6a11144   (the PR #405 merge commit)
PR_405_CONTAINED  YES — 254f5dc is the #405 merge; it is the branch tip
WORKTREE_CLEAN    YES — fresh worktree, npm ci, no uncommitted state
BRANCH            feature/build35-packing-intelligence-v2
```

Baseline before editing: Packing Deno suites **109 / 0**; Packing + Concierge client
suites **199 / 0**.

## B. What Packing already did (reused, not rebuilt)

Packing V1 is a mature, flag-gated (`ELISE_PACKING_INTELLIGENCE_V1_ENABLED` /
`EXPO_PUBLIC_PACKING_INTELLIGENCE_V1`) versioned branch of `stylechat-generate`:
server K+ precheck + post-retrieval confirmation, quota reserved last, Closet-only
retrieval (`user_closet_items`, 200-row census with completeness), coverage-first
shortlist, one Gemini JSON call, a post-model ownership gate, census-derived role
gaps, destination forecast (Open-Meteo, provenance-labelled), absence-prose safety
through the Concierge guard, device-local actor-keyed plan cache, checklist UI.

## C. Actual product gaps found (rapid baseline, ADD-20)

Five fixtures through the **unmodified** V1 handler with a stub provider
(`scratchpad/baseline.ts`):

| Fixture | Current behaviour | Main failure | Cause | Target |
|---|---|---|---|---|
| F1 4-day trip | 2 looks, no days | cannot answer *what, when, what repeats* | plan keyed by occasion, not day | day/occasion slots |
| F2 shoe duplication | 3 pairs of shoes, both navy blazers packed | no trip-level coherence | reuse left to the model | deterministic consolidation |
| F3 "it's going to rain" + cotton chore jacket | no gap, no mention | stated rain ignored; any outer layer = rain cover | gaps read the role census only | evidence-bound, graded gaps |
| F4 "make Friday more casual" | whole trip regenerated | nothing local, no "Friday" | refinement = full regeneration from notes | structured state, slot-scoped change |
| F5 sightseeing + formal event | formal event silently has no look | uncovered occasion reported as success | no per-occasion coverage | coverage per slot |

Capability delta:

| Capability | Current | Target | Action |
|---|---|---|---|
| Trip model | PARTIAL (trip-level activity set) | days × occasions, explicit or derived | EXTEND contract |
| Closet retrieval / ownership | WORKING | unchanged | REUSE |
| Outfit composition | WORKING (model) | per-slot looks | EXTEND prompt |
| Garment reuse / redundancy | PARTIAL (prompt hint) | deterministic, category-aware | BUILD (one planner pass) |
| Gaps | PARTIAL (role census) | coverage + evidence graded | EXTEND |
| Activity coverage | MISSING | per-slot coverage | BUILD |
| Weather | WORKING (destination forecast) | + traveller-stated conditions | EXTEND (no new source) |
| Signature Style | PARTIAL (prompt text) | + deterministic tie-break | EXTEND |
| Refinement | PARTIAL (regenerate + client exclusion) | local, pinned, reversible, clarifying | BUILD on state |
| Persistence | WORKING (client store + device cache) | + structured state | EXTEND |
| Commerce boundary | WORKING (none routed) | labelled external ideas on request | EXTEND (no commerce call) |
| Feature flags | WORKING | reuse | REUSE |

## D. Reuse / extend / separate

| Component | Decision | Note |
|---|---|---|
| Closet ownership (`user_closet_items`, `actorRelationship`) | REUSE | unchanged retrieval, unchanged authorized index |
| Garment roles (`inferLayeringRole`) | REUSE | no second taxonomy |
| Garment classes (`eliseOutfitState.garmentClassOf`) | REUSE (+1 export) | Packing wraps it for compounds ("raincoat"); shared table untouched |
| Colour table (`COLOR_FAMILIES`, `colorTokensOf`) | REUSE | |
| Refinement vocabulary (`readRefinementDirectives`) | REUSE | Packing adds days, pins, restores, repeats, laundry, luggage |
| Concierge trust rule (rejections only remove; retained ids re-verified) | REUSE as principle | applied to trip state |
| Refinement STATE type | DELIBERATELY_SEPARATE | `EliseOutfitState` models one look across chat turns; a trip needs slots, pins and reuse against a schedule. Principles shared, shape cannot be |
| Absence prose guard | REUSE | via existing `packingProseSafety` |
| Gap engine | EXTEND | `derivePackingGaps` unchanged for V1; `derivePackingCoverageGaps` builds on it |
| Outfit composer | EXTEND (Packing prompt) | no new general composer; the planner substitutes within looks only |
| K+ entitlement | REUSE | same double check; no new gate |
| Weather | REUSE | destination forecast only; no geocoding/provider change |
| Feature flag | REUSE | existing Packing flags + `plannerVersion: 2` request negotiation |

## E. What was built

| Capability | Commit | Files |
|---|---|---|
| Structured trip schedule + plan state contract | `98036f4` | `packingContract.ts`, `packingSchedule.ts`, `packingPlanState.ts` |
| Trip-level planner, garment facts, coverage gaps, selection signals | `2a5adb4` | `packingGarmentFacts.ts`, `packingTripPlanner.ts`, `packingGaps.ts`, `packingCandidates.ts`, `eliseOutfitState.ts` (export only) |
| Planner path: refinement interpreter, slot-scoped prompt, ownership assertion, wiring | `8e0fe5e` | `packingRefinementIntent.ts`, `packingPlannerHandler.ts`, `packingPrompt.ts`, `packingValidation.ts`, `packingHandler.ts`, `index.ts`, `config/edge-function-manifest.json` |
| Backend development + adversarial tests | `ff39fbf` | `packingTripPlanner.test.ts` |
| App: days, notes, leave-at-home, clarifications, schedule editor | `db2e992` | `types/packing.ts`, `packingClient.ts`, `packingPlanStore.ts`, `usePackingPlan.ts`, `PackingPlanView.tsx`, `PackingTripForm.tsx`, `app/packing/index.tsx`, `packingPlannerV2Client.test.js` |

### PLANNING_ARCHITECTURE — deterministic vs model

| Model (one call, same provider) | Deterministic |
|---|---|
| a coherent look for each slot it is asked about, and why | slot schedule; ownership gate + final ownership assertion; rejections, pins, occasion hard rules; hygiene caps; formality nudges; role fill; reuse/redundancy consolidation; coverage grading; gaps; laundry/repeat assumptions; refinement interpretation; clarifications; all customer copy about decisions |

### STATE_CONTRACT

`plan.state` (`stateVersion: 1`, `plannerVersion: 2`): `planVersion`, `tripId`
(stable across refinements), `tripKey` (hash of destination+dates; state for another
trip is discarded), `slots[{slotId, activity, originalActivity, formalityShift,
itemIds}]`, `pinnedSlotIds`, `pinnedItemIds`, `rejections[{itemId, slotIds}]`,
`rejectedGarmentClasses`, `activeConstraints` (allow-listed codes), `gapCodes`.
Ids, enums and codes only — no titles, no destination, no prose, **no ownership
field to forge**.

Persistence: returned with the plan, held in the existing actor-bound client store
and device cache, sent back as `priorState`. On return it is untrusted:
`restorePackingPlanState` bounds and allow-lists every field;
`verifyPackingPlanState` re-resolves every carried/pinned id against THIS actor's
freshly retrieved Closet; if under half re-resolves the prior plan is treated as
unusable and the trip is rebuilt with an explicit acknowledgement. No table, no
migration, no server-side trip history.

### CONSTRAINT_MODEL (ADD-03)

Hard facts / constraints: Closet ownership (authorized index only), the schedule's
occasions and their hard rules (e.g. no athletic/casual pieces at a formal event),
rejections, pins, hygiene caps, owned-only, "no laundry".

Selection signals, in order: the latest explicit traveller instruction (e.g. colour
wish, "use sneakers") → explicit standing preference → Signature Style (top profile
colours) → heuristics (neutral versatility, recency). A later explicit instruction
supersedes an earlier one and says so ("You had Friday marked as a formal event.
I'll switch it to casual as requested."; "Earlier you asked for Closet-only
packing…").

Conflicts: a pinned look is never silently changed. "Keep Saturday" + "don't pack
the blazer" removes the blazer from every other day, keeps it in Saturday, and says
"Saturday dinner is locked and uses the navy blazer, so it stays packed."

### REUSE_MODEL (ADD-07/09)

Wears before laundry, by layering role: tops 1, dresses 1, bottoms 3, mid layers 3,
outerwear / shoes / accessories unlimited; unroled pieces 1. Overrides: "I don't want
to repeat trousers" → bottoms 1; "I don't mind re-wearing tops" → tops 2.

One consolidation pass per role (shoes, outer, accessories, mid, bottoms): a packed
piece stays home only if pieces already in the suitcase can cover **every** look it
is in — same role, allowed for the occasion, within caps, colour-compatible,
formality same-or-adjacent and never less suitable for the occasion, and, when
either piece's formality is unknown, the same garment class. Pins, explicit
preferences and pieces restored this turn are never consolidated away. Copy says a
piece "can take over", never that two products are identical.

Long trips: the first 7 days are planned look by look; later days re-wear a look
with the same occasion and the plan states the assumption ("assumes one laundry
stop" / "Without laundry, later days repeat looks…").

## F. Multi-day planning

Days × occasions (up to 3 per day, 21 planned slots). Explicit per-day schedule from
the new optional day editor, or a derived schedule (travel first/last day, other
occasions daily) that the plan states as an assumption. Every slot gets a look,
coverage (`covered` / `unconfirmed` / `uncovered`) and a label ("Friday dinner").

## G. Garment reuse / redundancy — after-baseline (same fixtures, planner path)

```
F2  before: 4 looks, 11 pieces, 3 shoes, 2 blazers
    after : 4 looks,  9 pieces, 2 shoes, 1 blazer
      "Leave the black boots home: the white sneakers can take over Thursday travel."
      "Leave the navy blazer (wool) home: the navy blazer can take over Saturday dinner."
      "Wear the black trousers 3 times: Thursday travel, Friday dinner and Saturday dinner."
```

## H. Gap reasoning

A gap needs a trip requirement + complete Closet census + item facts. Graded:

* `confirmed` — e.g. stated/forecast rain and no outerwear at all; formal event and
  every owned shoe's words say casual/athletic.
* `unconfirmed` — items exist but their words are silent: "You mentioned rain. You
  have outer layers, but I can't tell whether any of them handle rain."
* no gap — incomplete census, or no forecast and no stated condition.

One absence yields one gap (no "outer layer" + "rain layer" double count). Current
device weather is never an input: request fields like `weatherContext` /
`currentLocation` are dropped by the parser (tested).

## I. Signature Style

Resolved lazily after both K+ checks (one profile read per request, shared by the
prompt block and the signal). Top 3 profile colours → colour families → a
tie-break weight below any explicit instruction. Tests: neutral top chosen under a
neutral profile; red top chosen when the traveller asks for colour; shortlist order
follows the same precedence; the prompt labels an explicit wish as outranking
signature style.

## J. Elise refinement integration

Refinement goes through the same Packing endpoint and state. Deterministic ops: reject
item / class, restore ("actually, bring the loafers back"), include an owned item,
pin / unpin days, keep an item, prefer a class ("use sneakers instead"), no-repeat /
re-wear-ok, laundry, owned-only, shopping permission, pack light, stated conditions,
carry-on questions. Styling ops (formality shift, another look, colour wish, free
text) regenerate **only the targeted slots**. Ambiguity ("the blazer" with two in the
plan, "Friday" on a trip with two Fridays) returns a clarification; nothing changes
until answered.

Stability is structural: untouched looks are carried verbatim; hygiene caps count
kept looks first so a changed look gives way; consolidation is confined to touched
looks unless the traveller asked for a trip-wide rebalance (pack light / re-wear ok).

## K. Owned vs external safety

* Every packed item is `ownership: 'owned'` and must resolve to the actor's
  authorized Closet index — asserted over the finished plan (`assertPackingOwnership`),
  not just at model-output validation.
* External ideas (`considerBuying`) exist only for **confirmed** gaps, only after the
  traveller asks to shop, never under owned-only; they carry no item id, product,
  price or link, relationship fixed to `external`, rendered under "NOT IN YOUR
  CLOSET" after assumptions, nothing to tap.
* The client drops any packed item not labelled owned and any external idea with an
  id/price/link.
* "Pack my red raincoat" with no raincoat owned: "I don't see a red raincoat in your
  Closet, so I haven't added it." — no model call.

## L. Representative before / after

| Case | Before (V1) | After (V2) |
|---|---|---|
| 4-day trip | 2 undated looks | 6 dated looks, coverage per slot, repeats stated |
| boots + sneakers + loafers | 3 pairs | 2 pairs, boots left home with reason |
| two navy blazers | both packed | one, "can take over" |
| "It's going to rain" + cotton jacket | silent | unconfirmed gap, "can't tell" |
| "Make Friday more casual" | whole trip regenerated | only Friday's slots sent and changed; loafers → sneakers, blazer dropped |
| "Don't pack the loafers" | 1 model call, full regeneration | 0 calls, 0 quota; replaced in place |
| "Keep Saturday" then "don't pack the blazer" | not representable | Saturday kept, conflict stated |
| sightseeing + formal event same day | formal event silently missing | both slots, sneakers removed from the formal look |
| "Will this fit in a carry-on?" | would regenerate with a note | qualified answer, no fit claim, 0 calls |
| another actor's state | n/a | nothing carried; rebuilt with acknowledgement |

## M. Test results

| Suite | Result |
|---|---|
| `packingTripPlanner.test.ts` (new) | **39 / 39** |
| `packingIntelligence.test.ts` + `packingWeather.test.ts` (V1 regression) | **109 / 109** |
| Concierge / ownership Deno suites (shared `eliseOutfitState` export) | **144 / 144** |
| `__tests__/packingPlannerV2Client.test.js` (new) | **16 / 16** |
| Packing client suites (V1 regression) | **59 / 59** |
| `node --test __tests__/concierge*.test.js __tests__/elise*.test.js` | **531 / 531** |
| `npx tsc --noEmit` | **PASS** |
| `node scripts/check-edge-function-parity.js` / `edgeFunctionSourceParity.test.js` | **PASS / 23 of 23** |
| `node scripts/run-all-tests.js` | **8,727 tests: 13 fail, all 13 in the known baseline; 0 unexpected; exit 0.** The first run showed 1 unexpected failure: a source-shape actor-scope guard (`actorScopeAuthority.test.js`) that looks for the literal `applyPackingPlan({ actorId`; the call had been reformatted across lines. The guard itself was never removed; the line shape was restored. |
| `node scripts/run-backend-tests.js stylechat-generate` | **441 / 0** (includes the nested `deno check` compile gate) |

Negative controls (applied, run, restored byte-for-byte; none committed):

| ID | Mutant | Result |
|---|---|---|
| NC-1 | ownership assertion reports no violations | 1 fail (case 14b) |
| NC-2 | consolidation disabled | 4 fail (cases 2, 3, 12, ADD-21.2) |
| NC-3 | pins ignored | 2 fail (case 11, ADD-21.2) |
| NC-4 | refinement regenerates the whole trip | 4 fail (cases 8b, 9, 11, cost) |
| NC-5 | any outer layer counts as rain-capable | 2 fail (case 6, facts) |
| NC-6 | prior state accepted without re-verification | 1 fail (case 15) |

Defect found in this lane's own run: the edge-manifest dependency scanner read a
quoted-word array in the refinement stop list as an import (phantom specifier `", "`,
the B34-DEF-001 class) — `check-edge-function-parity.js` still printed PASS while
`edgeFunctionSourceParity.test.js` failed. Rewritten as one space-separated string;
scanner not modified.

## N. LLM / API / cost impact (ADD-19)

```
LLM_CALLS_BEFORE = 1 per plan, 1 per refinement
LLM_CALLS_AFTER  = 1 per plan; 0 for deterministic refinements; 1 for styling refinements
NEW_PROVIDER = 0   NEW_DEPENDENCY = 0   NEW_MIGRATION = 0   NEW_TELEMETRY_EVENTS = 0
```

Prompt size (characters, system + user; ~÷4 tokens), same fixtures:

| Request | V1 | V2 |
|---|---|---|
| initial 4-day plan | 4,254 | 4,379 (+slot list) |
| "Make Friday more casual" | 4,317 (full regeneration) | 4,134 (2 slots, #-referenced locked looks) |
| "Don't pack the loafers" / keep / restore / carry-on / clarify | 4,317 each | **0** (no call, no quota) |

Pre-model deterministic work is in-memory over at most 200 Closet rows and 21 slots.

## O. What still needs building

* A rain-capable outer layer is not automatically *added* to looks when rain is stated;
  the gap/qualification is surfaced, placement is left to the model.
* Formality and rain evidence are word-based; the Closet stores no formality, season or
  waterproof field. Richer garment attributes would sharpen coverage.
* Refinements that add or remove an occasion ("add a dinner on Saturday") go to the
  trip form, not the refinement box.
* External ideas are category labels; any product matching is a Commerce decision.
* The V1 client-side refinement resolver remains for V1 plans without state.

## P. What should wait for certification

Device QA of the day editor and day view (iOS/Android), live-model sampling of slot
adherence, staging deploy of `stylechat-generate` behind the existing flag (drift
check first — see the V1/V121 deploy notes), and a hostile pass over the refinement
interpreter's phrase tables.

## SCOPED_EXPANSION

Day-by-day schedule editor in the trip form (required for multi-activity days);
clarification UI; reason carry-over for unchanged looks and checklist ticks across
refinements of the same trip; compound garment words.

## DEFERRED

Commerce product matching for external ideas; destination geocoding changes; luggage
volume; new telemetry events; Concierge/Elise chat-surface integration of Packing
state.

## Q. Verdict

**READY_FOR_OWNER_REVIEW.** Packing now produces a day-by-day trip plan with deterministic ownership, realistic reuse, redundancy reduction, per-occasion coverage, evidence-graded gaps, Signature Style as a signal, and local, pinned, reversible refinement, at the same or lower model cost. This is a development outcome, not production certification: device QA, live-model sampling and a staging deploy behind the existing flag remain (section P).

```
MULTI_DAY_PLAN=YES            OWNED_FIRST=YES              GARMENT_REUSE=YES
REDUNDANCY_REDUCTION=YES      ACTIVITY_COVERAGE=YES        EVIDENCE_BOUND_GAPS=YES
OWNED_EXTERNAL_DISTINCTION=YES SIGNATURE_STYLE_CONSUMED=YES CONVERSATIONAL_REFINEMENT=YES
LOCAL_REFINEMENT_STABILITY=YES TRIP_LEVEL_COHERENCE=YES     ACTOR_ISOLATION=YES
```
