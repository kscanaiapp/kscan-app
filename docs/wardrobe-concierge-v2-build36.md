# Wardrobe Concierge V2 — development build report (Build 36)

**Verdict: `READY_FOR_OWNER_REVIEW`. No merge, no deploy, no EAS build.**

This is a **development lane**, not a certification lane. It builds unfinished
Concierge capability, reuses the K Scan intelligence that already exists, and
documents honestly what it did not verify.

---

## 1. Authority

```
BASE_BRANCH         fix/notifications-final-convergence-v1
BASE_SHA            b729a947768b4fef99c4d999befc821a714b62d4
PR_403_CONTAINED    YES  — 0f7be99 is an ancestor of b729a94 (merge commit b729a94)
PR_403_MERGE_METHOD merge commit ("Merge pull request #403 …")
BRANCH              claude/wardrobe-concierge-v2-3hlfo9
WORKTREE_CLEAN      YES at start
```

**The session's starting checkout was the wrong line.** It began on `master`
@ `bc3a306`, which does **not** contain PR #403 (`git merge-base --is-ancestor
b729a94 master` → false) and has no avatar files at all. PR #403 merged into
`fix/notifications-final-convergence-v1`, which is the Build 35 development
authority named by PR #403 itself. The branch was re-pointed at `b729a94`
before any edit.

**Baseline regression battery (run before editing):**

```
node scripts/run-all-tests.js
# tests 8676 · pass 8598 · fail 13 · skipped 65
Observed failures: 13; known: 13; unexpected: 0        exit 0
```

Green, and identical to the baseline PR #403 declared. The first run of this
suite reported 295 unexpected failures — that was a missing `node_modules`, not
a regression; `npm ci` resolved it and is recorded here so the number is not
mistaken for a real signal.

**Existing Concierge work searched before branching.** Eight open PRs, none
touching `stylechat-generate`. Twenty-one Concierge/Wardrobe/StyleChat remote
branches, all Build-34-era and already contained. **No competing lane to
resume.**

---

## 2. What already existed

Wardrobe Concierge is **not** an unbuilt feature. It is a mature, flag-gated
(`conciergeV1`) capability layer inside `supabase/functions/stylechat-generate`.
Mapped before editing:

| Capability | State | Authority |
|---|---|---|
| Ownership vocabulary (`actorRelationship`) | **ACTIVE** | `eliseAdviceTypes.ts` — 7 values, owned/saved/scanned/shared/discovered/unverified/unknown |
| Owned/external boundary | **ACTIVE** | `eliseWardrobeRetrieval.ts` — per-source relationship mapping, owner-scoped |
| `adviceMetadata` output contract | **ACTIVE** | v1/v2 dual contract, `displayFacts` server-copied |
| `wardrobeContextMode` | **ACTIVE** | none/closet/mixed, client gates on it rather than on entitlement |
| Deterministic ownership prose guard | **PARTIAL** | `eliseOwnershipProseSafety.ts` — real, but two holes (§3) |
| Closet census + exhaustiveness | **ACTIVE** | `eliseClosetCensus.ts` — `exhaustive`, `unclassifiedItems`, `categoriesTruncated` |
| Evidence-bound wardrobe gaps | **ACTIVE** | `eliseWardrobeGap.ts` + `evidenceIsExhaustive`; prompt scopes language when bounded |
| Absence prose guard | **ACTIVE** | `enforceClosetAbsenceProseSafety` — census-gated |
| Context contract | **ACTIVE** | `styleChatPromptAssembly.ts` — closet / signature_style / style_dna / user_input as separate trust-labelled envelope sections |
| Outfit composition | **ACTIVE** | `eliseCompatibilityScoring.ts` + `buildMultiLooks` |
| Conversation persistence | **ACTIVE** | `style_chat_messages`, `ui_blocks` jsonb, client-written |
| **Proposed-outfit / refinement state** | **MISSING** | — nothing; the only refinement state in the repo is Packing's |
| Elise evaluation harness | **ACTIVE** | `tools/elise-concierge-eval/` — 42/42 green, instrument-validation framing |

**Conclusion that shaped this lane: most of the prompt's BUILD sections were
already satisfied.** Building them again would have created exactly the parallel
vocabularies ADD-03 forbids. Only the items in §3 were actually deficient.

---

## 3. What was actually broken

Reproduced by **executing the real production modules** (Node type-stripping,
the same seam `tools/elise-concierge-eval/context-assembly/l15ContextAssembly.js`
already uses). Synthetic Closets, real code, no model.

### D1 — `VALIDATION_GAP`: the bare possessive was never examined

Every pattern in `OWNERSHIP_ASSERTIONS` required a verb of possession
("you own", "you have") or the word *closet*/*wardrobe*. The most natural false
ownership claim in English needs neither — and it is the exact sentence this
subsystem's own product truth names as the one that may be said **only** when
ownership is verified:

```
owns: brown loafers, charcoal trousers
said: "Wear your black loafers with the charcoal trousers."
→ conflictDetected: false        ← reached the customer unchanged
```

Also missed, all measured: *"Pair your red dress with a camel coat."*,
*"Your leather jacket would finish this look."*, *"Throw on your denim jacket."*

**Root cause:** an assertion list built from verb phrases, with no possessive
form in it.

### D2 — `VALIDATION_GAP`: the owned vocabulary was colour-blind

`ownedGarmentVocabulary` recorded garment **class** only. Owning brown loafers
therefore licensed a claim about black ones:

```
owns: brown leather loafers
said: "You already have black loafers."
→ conflictDetected: false        ← class matched, so the claim was "supported"
```

**Root cause:** the class check was necessary and was never sufficient. The
customer was never told about a class; they were told about a garment.

### D3 — `STATE_GAP`: refinement continuity was prose, not state

`runEliseAdvicePipeline` received exactly one field about the conversation:
`message`. Measured on the real pipeline with a five-item Closet:

```
turn 1  "Build me an outfit for dinner"    → [blouse, trousers, blazer, loafers, sneakers]
turn 2  "Not the loafers, something else"  → [blouse, trousers, blazer, loafers, sneakers]
```

Identical, loafers included, same position. Whether the rejection was honoured
depended entirely on the model re-reading its own previous reply out of the
history window.

**Root cause:** there was nothing to remember with. Telling the model harder to
remember does not create state.

### D4 — `PROMPT_GAP`: no stated conflict precedence

The system prompt said Signature Style is "background context only" but never
stated that an **explicit current request outranks an inferred preference**. The
context contract already keeps the two in separate trust-labelled sections
(so this is a prompt gap, not a context gap), but nothing said which wins.

### Not a defect — deliberately not built

Outfit composition, wardrobe-gap evidence rules, duplicate awareness, Signature
Style influence, abstention copy and the context contract were all measured as
**already correct** and were left alone (ADD-12: do not implement an item merely
because it is on the list).

---

## 4. Reconciliation map (ADD-03)

| Capability | Decision | Why |
|---|---|---|
| Ownership vocabulary | **REUSE** | `actorRelationship` is the one taxonomy; no second enum was introduced |
| Ownership validation | **EXTEND** | Two patterns + one qualifier check added to the existing guard |
| Colour vocabulary | **EXTEND (shared)** | 12 colours added to `COLOR_FAMILIES`, then exported as `COLOR_TOKENS`/`colorTokensOf` so the guard asks the **scorer's** table. Two colour tables would be two answers to "is this a colour?" |
| Context contract | **REUSE** | `assembleStyleChatPrompt` already separates Closet / Signature Style / Style DNA / user input |
| Outfit composition | **REUSE** | No third composer. Refinement filters the existing ranked shortlist |
| Wardrobe gap | **REUSE** | Gap analysis now runs *after* exclusions, so it reasons about what is actually left |
| Recommendation roles | **REUSE** | `EliseRecommendationRole` is the slot vocabulary for outfit state |
| Conversation persistence | **EXTEND** | State rides in `ui_blocks` exactly as `concierge_evidence` already does — no migration, no new table, no extra query |
| Refinement state | **DELIBERATELY_SEPARATE** | Packing's refinement state models a trip plan, not a styling turn. Documented below |

**Why refinement state is separate from Packing's.** `services/packing/
packingRefinement.ts` refines a persisted multi-day *plan* keyed by trip, held
in a client store, with per-day slots. A Concierge refinement is a single
styling decision inside one chat turn, server-derived, and must be re-verified
against fresh retrieval every turn because ownership is re-derived every turn.
Sharing the type would have coupled a trip planner to an ownership boundary.
What **is** shared: the recommendation-role vocabulary, the candidate model, the
scorer, the retrieval layer and the gap engine.

---

## 5. What was built

### Build A — ownership validator repair (`eliseOwnershipProseSafety.ts`, +255)

**CON-PROSE-005 — possessive claims.** `your <modifiers> <garment>` is now an
ownership assertion, extracted as a **phrase** by a forward token scan.

Why a scan and not a regex: a bounded-gap regex is greedy about the gap, so in
*"your black loafers with the trousers"* it consumed `black loafers with` as
modifiers and offered `the` as the head noun — finding no garment and passing
the very sentence it was added for. That was caught during the build and is
pinned by a test.

Why phrase-scoped and not sentence-wide: *"That dress would suit your figure."*
— `your` governs *figure*, not *dress*. A sentence-wide sweep would delete
ordinary styling advice. The scan stops at clause terminators and at an
intervening owner (*"your friend's jacket"*).

**CON-PROSE-006 — colour qualifier.** A claim naming a colour is checked against
the colours the actor's owned items of that class actually have.

**Abstention is the default, in both directions.** No colour named → nothing to
contradict. Owned rows carry no colour → the evidence cannot disagree, so the
sentence survives. Deleting a true sentence for want of metadata is the mirror
of the failure being fixed, and a worse one. Colour only — material, brand and
silhouette are far more often absent on a real Closet row.

**Unchanged:** the guard still *drops* offending sentences and never rewrites
them; conflict codes still carry garment class only.

### Build B — structured refinement state (`eliseOutfitState.ts`, new, 572 lines)

`EliseOutfitState` = `outfitId`, `turn`, `items[{candidateId, role,
relationship, sourceType}]`, `retainedCandidateIds`, `rejectedCandidateIds`,
`rejectedGarmentClasses`, `activeConstraints`. Ids, roles and enums only —
**no prose, no titles, no URIs** (asserted by test).

**Where it lives — and why there is no migration.** In the assistant message's
`ui_blocks`, exactly as `concierge_evidence` already does: the server returns it
in `adviceMetadata`, the client persists it with the message, and the server's
**existing** history read — which already selects `ui_blocks` — hands it back
next turn. No new table, no new column, no second query, no extra round trip.

**Actor scoping is inherited, not reinvented.** That read is
`.eq('session_id', …).eq('user_id', actorId)` under RLS, so another actor's
outfit is *unreadable*, not merely filtered. Only **assistant** rows are
consulted: a user row's `ui_blocks` is client-authored content for a message the
server never generated, and trusting one would let a crafted message seed the
outfit.

**The trust rule.** The state round-trips through the client, so it is
**untrusted** coming back. The contract is shaped so that cannot matter:

- `rejectedCandidateIds` can only ever **remove** a candidate. A forged
  rejection costs a suggestion; it cannot invent one.
- A retention is honoured **only** after the id is re-found in *this* turn's
  freshly authorized evidence; one that cannot be re-verified is **reported as
  dropped**, never silently kept.
- `relationship` is advisory and re-derived from retrieval every turn. A forged
  `owned` never reaches ownership language.

The worst a tampered state can do is ask for fewer options. **It can never
manufacture an ownership claim** — pinned by test.

**Where it is applied.** After retrieval/scoring and commerce deferral, before
gap analysis and look building. Load-bearing in both directions: exclusions must
act on the ranked list the answer would otherwise have used, and gap/look logic
must reason about what is actually left rather than about a shortlist the
customer has already turned down.

**The prompt is told, but is not the enforcement.** The `[ACTIVE OUTFIT -
REFINEMENT]` block explains *why* the candidate list changed. The removal itself
is deterministic and has already happened — the rejected piece is not in the
list. That distinction is the whole repair.

### Build C — precedence in the system prompt (`index.ts`)

A seven-line ordering: ownership truth → explicit request → explicit constraints
→ Closet facts → stated preferences → Signature Style → convention, with the two
cases named in plain language (honour bright blue over inferred neutrals; say so
rather than substituting when an owned-only request cannot be met).

### Build D — output contract (ADD-05)

`adviceMetadata` gains `outfitState` and `refinement`. Item references already
carried `candidateId` / `sourceType` / `actorRelationship` /
`recommendationRole` / `displayFacts.clientId`; `role` in the outfit state
completes `ROLE_IN_OUTFIT`. v2-only — a flag-off payload is byte-identical v1,
asserted by test.

---

## 6. Before / after

| # | Case | Before | After |
|---|---|---|---|
| 1 | `"Wear your black loafers…"`, owns brown | **not detected** | **detected**, sentence dropped |
| 2 | `"Your leather jacket would finish this look."` | **not detected** | **detected** |
| 3 | `"You already have black loafers."`, owns brown | **not detected** | **detected** |
| 4 | `"Wear your brown loafers…"` (true) | survives | survives |
| 5 | `"A brown loafer would work here."` (hypothetical) | survives | survives |
| 6 | `"That dress would suit your figure."` | survives | survives |
| 7 | `"you already have black loafers"`, owned row has **no** colour | survives | survives (abstains) |
| 8 | Reject loafers → next turn | **loafers returned** | **removed**, deterministically |
| 9 | Reject → two turns later | **loafers returned** | **still removed** |
| 10 | `"Keep the shoes, change everything else"` | no effect | resolves to a candidate id |
| 11 | Retained id absent from this turn's evidence | n/a | **reported dropped**, not kept |
| 12 | `"Make it less formal"` then `"more formal"` | no memory | replaces, does not stack |
| 13 | New styling request after refinements | n/a | new outfit, exclusions dropped |
| 14 | Actor B handed actor A's state | n/a | 0 owned candidates, 0 retentions |
| 15 | Forged `owned` in restored state | n/a | cannot enter the shortlist |
| 16 | Flag off | baseline | **byte-identical v1**, no exclusions |

---

## 7. Test results

| Verification | Result |
|---|---|
| `npx tsc --noEmit` | **PASS** |
| `__tests__/conciergeOwnershipProseV2.test.js` (new) | **16 / 16** |
| `__tests__/conciergeRefinementState.test.js` (new) | **19 / 19** |
| Edge Function Concierge suites (8 files) | **165 / 165** |
| `node --test __tests__/concierge*.js __tests__/elise*.js` | **496 / 496** |
| `tools/elise-concierge-eval` own suite | **42 / 42** |
| `node scripts/run-all-tests.js` | **8633 / 8711**, 13 fail — **all 13 known baseline, 0 unexpected**, exit 0 |
| `node scripts/check-edge-function-parity.js` | **PASS** (manifest regenerated — see below) |

Test count moved **8676 → 8711: +35, exactly this lane's cases**.
`config/test-failure-baseline.json` is **unmodified and not widened**.
`NEW_FAILURE_COUNT = 0`.

### One defect found in this lane's own first full-suite run

The first post-build full suite reported **5 unexpected failures**, all from the
edge-function parity gate. Two distinct causes, both fixed:

1. **`config/edge-function-manifest.json` was stale.** It is a generated
   artifact that must be regenerated whenever an Edge Function's source
   changes. Regenerated with `scripts/generate-edge-function-manifest.js`; the
   diff touches **stylechat-generate entries only** (verified).

2. **A bogus import specifier — the B34-DEF-001 false-positive class.** The new
   `PHRASE_TERMINATORS` table contained the quoted word `'from'` followed by
   `, '`, which `scripts/edge-function-manifest-lib.js` reads as the start of a
   `from '<spec>'` import and captures as the specifier `", "`. Its own comments
   document this class: line comments are deliberately not stripped, so prose
   and data containing `from '` can be misread. The manifest tool was **not**
   modified (out of this lane's scope and a governance surface); the data table
   is written as one space-separated string instead, with a comment saying why
   so it is not "tidied" back into an array.

**Deno is not installable in this environment** (egress policy blocks
`deno.land`). The Edge Function `.test.ts` suites were executed under `node
--test` with a 12-line `Deno.test`/`Deno.readTextFile` shim. They exercise the
real modules; they are **not** a substitute for a real `deno check` compile gate,
which is listed in NOT_RUN.

### Negative controls (ADD-11 — targeted, none committed)

| ID | Mutant | Suite | Result | Reverted |
|---|---|---|---|---|
| NC-1 | bypass the possessive check | ownership | **7 fail** ✓ | clean |
| NC-2 | bypass the colour qualifier check | ownership | **5 fail** ✓ | clean |
| NC-3 | drop refinement exclusions | refinement | **5 fail** ✓ | clean |
| NC-4 | remove actor scoping from retrieval | refinement | **1 fail** ✓ | clean |

After revert: **35 / 35** green, `eliseWardrobeRetrieval.ts` diff empty.

---

## 8. LLM call and context impact (ADD-09)

```
LLM_CALLS_BEFORE = 1 per turn      LLM_CALLS_AFTER = 1 per turn
NEW_AI_PROVIDER  = 0               NEW_DEPENDENCY   = 0
```

Proof, run over the full diff against `b729a94`:

```
$ git diff b729a94 -- '*.ts' '*.tsx' | grep -E '^\+' | grep -iE \
    'fetch\(|axios|XMLHttpRequest|WebSocket|EventSource|\.invoke\(|generateContent|https?://'
(no output)
$ git diff b729a94 --name-only | grep -E 'package(-lock)?\.json'
(no output)
```

No reflection pass, no critic pass, no second inference loop. Every new
mechanism is a pure function.

**Context size.** Proxy: characters of the Elise advice grounding block, and the
`length/4` estimator the production path already uses for `token_estimate`. One
proxy, stated.

| Turn | chars | ~tokens |
|---|---|---|
| flag OFF (pre-Concierge) | 1946 | 487 |
| turn 1 — new outfit, no refinement block | 2634 | 659 |
| turn 2 — refinement block present | 2748 | 687 |
| turn 3 — reject + keep + constraints | 2846 | 712 |

**Delta attributable to this lane: +26 tokens on a refinement turn, +0 on every
other turn** (the block is emitted only when a turn continued an outfit). Well
inside the ~500-token budget. The persisted state is 721 chars and is **never
sent to the model** — it goes to `ui_blocks` and comes back as structured input.

Context selection is unchanged: the existing relevance-bounded shortlist
(`groundedShortlist: 10`) still governs. No Closet dump was introduced.

---

## 9. What still needs building

- **Refinement vocabulary is literal pattern matching.** Deliberately, for the
  same reason the ownership guard is blunt — but it will miss phrasings not in
  the table (*"ditch the loafers"*, *"anything but brown"*). It fails to
  `new_outfit`, which restarts rather than misapplying stale exclusions.
- **Qualifier checking is colour-only.** Material, brand and silhouette claims
  ("your silk blouse" when the owned blouse is cotton) are still class-checked
  only. Extending needs better Closet metadata coverage first, or it will delete
  true sentences.
- **Retention is role-based.** *"Keep the trousers"* resolves via role/class, not
  via a specific named item; an actor with two owned trouser pairs in one outfit
  is not disambiguated.
- **State lives on the newest assistant message carrying a block.** A client that
  fails to persist it degrades to pre-V2 behaviour silently. That is fail-safe,
  not fail-loud.
- **No K+ gating change.** Untouched, deliberately.

## What should wait for certification

Live model-in-the-loop evaluation, real-device QA, `deno check` on the Edge
Function, staging deployment, and multi-run behavioural stability sampling.

---

## 10. Counter-report

**The strongest remaining reason Elise could still hallucinate.** The guard is
a *lexical* check over a *bounded* garment list. A false ownership claim phrased
with a garment noun not in `GARMENT_NOUNS` (a "gilet", a "peacoat", a "kaftan")
is still invisible to it — and that list is hand-maintained. Both new checks
narrow the hole; neither closes the class of failure. The structured metadata and
the grounded prompt remain the layers doing the real work, exactly as the
module's own header says.

**Deterministic vs model-dependent.** Deterministic: the ownership and colour
checks, candidate exclusion, retention re-verification, actor scoping, the
untrusted-state validation, and the flag-off parity. Model-dependent: whether
Elise *uses* the retained pieces gracefully, whether it explains an owned-only
gap well, and whether it honours the stated precedence — Build C is a prompt
change and carries a prompt change's confidence, which is lower than the rest of
this lane's.

**What was not tested with a real model or runtime.** Everything behavioural.
`RUNTIME_MODEL_EVAL = NOT_RUN` — no live Gemini call was made and no server flag
was changed to manufacture one. The synthetic fixtures here validate
*deterministic contracts*; they are **not** evidence about production Elise
quality, and the existing harness's own framing banner says the same thing about
its numbers.

**Did quality come from more prompt/context?** No. +26 tokens on refinement
turns only, and the refinement block is *explanatory* — the enforcement is the
deterministic exclusion that already happened. NC-3 proves this: bypassing the
exclusion fails the tests while the prompt block is still emitted.

**Did this lane duplicate logic?** One judgement call worth naming: the
`wordStems`/`garmentClassOf` helpers in `eliseOutfitState.ts` mirror private
helpers in `eliseOwnershipProseSafety.ts`. They were **not** imported because
the guard's copies are deliberately private and the two lists answer different
questions (what may be *claimed* vs what may be *rejected*). That is ~30 lines
of near-duplication, consciously accepted; extracting a shared module is a
reasonable follow-up but would have widened this diff into the guard's internals
for no behavioural gain. Everything else — ownership vocabulary, candidate
model, scorer, retrieval, gap engine, colour table, role vocabulary,
persistence — is reused.

---

## 11. Verdict

```
READY_FOR_OWNER_REVIEW
```

Three real defects were reproduced against the real pipeline, diagnosed to root
cause, and repaired with the smallest change that fixes them. Ownership safety
is materially stronger and is enforced deterministically rather than by prompt
wording. Multi-turn styling now operates on structured state instead of on the
model's recollection. No second AI pipeline, no new provider, no migration, no
new dependency, and no measurable context growth outside refinement turns.

READY does **not** mean the behaviour was certified with a live model. It was
not. **No merge. No deploy. No EAS build.**
