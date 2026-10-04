# Build 35 — Elise Conversation Quality V2

Lane record for the Elise conversation-quality refinement. Source-only: no
database, no migration, no Edge Function change or deploy, no new provider, no
new persistence, no additional model call.

## A. Authority

| Field | Value |
|---|---|
| `BUILD35_BASE_BRANCH` | `fix/notifications-final-convergence-v1` (Build 35 product authority; every Build 35 lane since #403 merges here) |
| `BASE_SHA` | `d66f03d6126bdfb65bfa0301bf8474d2e584a544` (PR #414 merge, current remote tip at dispatch) |
| `UPSTREAM_SHA` | `d66f03d6126bdfb65bfa0301bf8474d2e584a544` |
| Branch | `feature/build35-elise-conversation-quality-v2` |
| `WORKTREE_CLEAN` at start | `YES` (fresh worktree `C:/src/B35-ELISE-Q2-20260922`) |

The Build 34 line and `rebuild/backend-authority-v2` (the active Supabase/backend
lane) were not touched.

## B. The Elise conversation path, as it actually is

```
USER INPUT            app/style-chat/[sessionId].tsx  (composer; disabled while isSending)
  ↓
CLIENT CHAT STATE     hooks/useStyleChat.ts  (messages[], isSendingRef, sendScopeVersionRef,
                      retry state, actor epoch via services/actorScope.ts)
  ↓
MESSAGE CONTRACT      services/style-chat/providers/edgeStyleChatProvider.ts
                      {sessionId, message, weatherLocation, styleDnaContext, activeContext,
                       genderStylingContext, sourceMessageId[, attachments, fashionContextV2]}
  ↓
CONTEXT ASSEMBLY      supabase/functions/stylechat-generate/index.ts (SERVER)
                      newest 6 non-greeting messages (+3 greeting buffer), contextMessages.ts;
                      Signature Style / Closet / Concierge / weather / attachments blocks
  ↓
INTENT / ROUTING      server: eliseAdviceIntents.ts, eliseCommerceIntent.ts (reducer),
                      eliseOutfitState.ts (Concierge V2), packingHandler/packingPlannerHandler
  ↓
MODEL REQUEST         ONE Gemini call (SINGLE_PASS); ≤1 provider-error retry, ≤1
                      incomplete-response retry
  ↓
STRUCTURED RESPONSE   {message, whyThisWorks, actions, adviceMetadata, shoppingIntent,
                       signatureStyleTokens, weatherContext, usage}
  ↓
UI BLOCKS / ACTIONS   ui_blocks jsonb: why_this_works, stylechat_actions, concierge_evidence,
                      concierge_outfit_state, commerce_shopping_intent, commerce_products
                      → components/style-chat/StyleChatBubble.tsx
  ↓
FOLLOW-UP STATE       next turn: server re-reads outfit state + shopping intent from the
                      SAME fetched rows (assistant rows only); client Commerce shelf memory
                      re-read from loaded commerce_products blocks
```

Source authorities: `useStyleChat` — `hooks/useStyleChat.ts`; message type —
`services/style-chat/types.ts`; history — `style_chat_messages` via
`services/style-chat/styleChatRepository.ts` (client) and the server window in
`index.ts`; `ui_blocks` — the hook (writer) and `StyleChatBubble.tsx` (renderer);
shopping intent — `eliseCommerceIntent.ts` (server reducer) +
`services/style-chat/commerceActivation.ts` (client activation); Closet context —
server retrieval + `services/ownedClosetItems.ts`; Signature Style — server
`styleDnaContext`/profile + `signatureStyleTokens`; Packing — `packingHandler.ts`;
Dressing Room — `eliseRoomItemEvidence.ts`/`eliseSharedRoomAccess.ts`; VTO actions —
`stylechat_actions`; Commerce activation — `runCommerceActivation`; product
references — `commerceShelfMemory.ts`; reason feedback —
`StyleChatReasonChips.tsx`; reset — hook effect on `[actorId, sessionId]`; stale
protection — `isCurrentSend()` (scope version + actor epoch); retries —
`styleChatRetryState.ts`; errors — `styleChatErrors.ts`/`styleChatOutcome.ts`.

**The structural fact that shaped this lane:** every model-facing input —
history window, prompt, Signature Style, Closet — is assembled inside
`stylechat-generate`, which this lane is fenced out of. The client sends only the
current message. So model-facing prompt/context improvements are a
`BACKEND_FOLLOWUP_REQUIRED` (section K), and this lane's improvements are the
deterministic ones the client can own.

## C. Parallel lanes

`ACTIVE_BUILD35_LANES`:

- PR #427 — cross-platform haptics + optimistic UI (touches `ProductShelf.tsx`,
  `StyleChatReasonChips.tsx`, `latestIntentMutationQueue.ts`, dressing rooms, voice).
  **Not touched here.**
- `rebuild/backend-authority-v2` + `governance/*` — Supabase/data-room/backend
  authority. **Not touched here.**
- Commerce V2 (#412/#414, merged) — shelf memory and activation. **Contract not
  changed;** its call site in the hook gained a precondition (below).

`ELISE_OWNED_FILES` (new): `services/style-chat/eliseConversationFrame.ts`,
`services/style-chat/eliseConversationTelemetry.ts`,
`components/style-chat/EliseConversationNotice.tsx`,
`tools/elise-concierge-eval/conversation/*`, tests, this doc.

`SHARED_FILES` (edited, minimal): `hooks/useStyleChat.ts` (Elise send path;
also hosts the Commerce call site), `components/style-chat/StyleChatBubble.tsx`
(one new block branch), `tools/elise-concierge-eval/runner.js` (one new mode),
and two test harness require-maps (`__tests__/eliseStaleCompletionIsolation.test.js`,
`__tests__/commerce/commerceSignatureStyleProductionWire.test.js`) — each gained
two map entries for the new zero-import modules; **no assertion was changed**.

`SHARED_SURFACE_FOLLOWUP_REQUIRED`:

1. The Commerce call site in `useStyleChat.ts` now runs only when
   `decideEliseCommerceActivation` allows it. `runCommerceActivation`, its deps,
   shelf memory and ranking are unchanged. Commerce V2 owners should review the
   hold rules (section E, "Commerce intent").
2. Telemetry sink is **not bridged** to PostHog: bridging means adding it to
   `services/analytics/analyticsEventRegistry.ts` and `posthogClient.core.ts`,
   which the PH35 analytics-governance lane owns.

## D. Context

`CONTEXT_POLICY_BEFORE`: server sends the model the newest 6 non-greeting
messages (3 exchanges), plus system context; the client sends the current
message only. Constraints stated more than 3 exchanges ago ("no heels") are
**absent from the model's context** and nothing re-checks them.

`CONTEXT_POLICY_AFTER`: **model context unchanged** (0 bytes added to the
request — pinned by `BLOCK-ELISE-Q2-20`, which asserts the exact request key set).
The client additionally derives a bounded task frame locally from the history it
already holds: ≤16 newest messages, ≤8 user turns per task, ≤8 negations, ≤6
rejections, ≤4 corrections, ≤3 colours, ≤2000 chars read per message; reset on a
new task. Nothing is persisted except, when needed, one notice block on the reply.

## E. Conversation improvements (what is deterministic, where it lives)

All in `services/style-chat/eliseConversationFrame.ts` — pure, zero-import,
re-derived every send (no store), closed English phrase sets, no model call.

| Area | Implementation |
|---|---|
| Follow-ups | Turn relation: `new_task` / `refinement` / `reference` / `rejection` / `correction` / `acceptance`. Anaphora + refinement openers ("more casual", "make it…", "what about…", "same…") continue the task. |
| Task reset | Positive evidence only: packing switch, explicit restart ("new question", "start over"), a fresh request with a new occasion / new anchor garment / different task family, a new shopping category (mirrors the server reducer), or the 8-turn bound. When unsure, the task continues. |
| Negation | "no heels", "not leather", "not black", "nothing cropped", "anything except denim", "never wear boots" → class exclusions (garment / material / colour / silhouette). `heels` is a group (pumps, stilettos, slingbacks). "Actually heels are fine" lifts it. A determiner ("don't use the boots") is an object rejection, not a class. |
| Budget | "under $150" (USD/EUR/GBP only — a number without a currency is not held); "any price" clears. Sticky within the task. |
| References | Ordinal → the options the previous turn rendered (Commerce shelf first, then numbered prose). Demonstrative + garment ("that jacket") → vocabulary-qualified mentions in the previous turn. Two distinguishable candidates → **ambiguous**; indistinguishable duplicates → not resolved and not asked about. |
| Local clarification | Ambiguous reference, or an out-of-range ordinal on prose options → a one-line clarification written **without a model call** ("Do you mean the denim jacket or the leather jacket?"), persisted as an assistant row (`provider: 'elise_clarification'`), spoken like any reply. Never when an attachment, visual collection or active scan context is in view. Commerce-shelf out-of-range stays Commerce V2's (`reference_out_of_range`). |
| Ownership | "from what I own", "from my closet", "which … do I own", "don't make me buy", "shop my closet" → `ownedOnly`, sticky until the customer explicitly opens shopping. The frame has **no ownership field** — it never grants ownership; Saved/Watched/Scanned/Tried-On language does not set anything. |
| Rejection | "I don't like those shoes" → the last footwear mention in the previous reply (e.g. `white sneakers`) is rejected; the category is not. Identity is "known" only when a vocabulary modifier was shown. Reasons ("too formal") move formality. |
| Corrections | "Those are boots, not loafers" / "They aren't boots, they're loafers" → `{from, to}`; the "not loafers" half is NOT an exclusion; the turn never shops. No product truth is written. |
| Signature Style | The frame takes no profile input at all, so it cannot override a stated colour/material/occasion; Commerce already ranks `USER_EXPLICIT` on top; the server prompt already carries the precedence ladder (verified, not changed). |
| Commerce intent | The model proposes `find_products`; the client now requires the customer's words to corroborate it: explicit request ("find", "where can I buy", "show me some", "$150"), discovery need ("I need a new…"), an elliptical item request opening a task ("Only black boots please."), a memory op inside a live shopping task, or acceptance of a held offer. **Held** otherwise — owned-only always holds unless the customer explicitly opens shopping. A hold keeps the intent block (so "yes, show me" resumes it) and adds one line. |
| Contradiction | After the reply lands, it is checked against live negations and known-identity rejections. Affirmative mentions only ("skip the heels", "since you said no heels", "swap the white sneakers for…" are not violations). A violation adds one line under the reply; the reply text is never rewritten and no second model pass runs. |

Notice copy lives in `components/style-chat/EliseConversationNotice.tsx`; the
persisted block carries only a closed code and closed-vocabulary tokens.

## F. Model / cost

| | Before | After |
|---|---|---|
| `BASELINE_MODEL_CALLS_STYLING` | 1 (≤2 on a provider-error retry, ≤1 more on an incomplete-response retry) | same |
| `BASELINE_MODEL_CALLS_SHOPPING` | 1 model + 0–1 Commerce retrieval (≤1 exhaustion refresh) | same when allowed; **0 Commerce** when held |
| `BASELINE_MODEL_CALLS_FOLLOWUP` | 1 | 1; **0** when answered by a local clarification |
| `MODEL_CALLS_AFTER` | — | ≤ before on every path |
| `ADDITIONAL_MODEL_CALLS_PER_TURN` | — | **0** |
| `COMMERCE_PROVIDER_CALLS_BEFORE / AFTER` | 0–2 per shopping turn | 0–2 when allowed, 0 when held |
| `NEW_PROVIDER` | — | **NO** |
| `ADDITIONAL_NETWORK_ROUND_TRIPS` | — | **0** (a local clarification removes one) |

## G. Supabase boundary

```
DATABASE_SCHEMA_CHANGED=NO
MIGRATION_CHANGED=NO
EDGE_FUNCTION_DEPLOYED=NO
STAGING_MUTATED=NO
PRODUCTION_MUTATED=NO
```

No file under `supabase/` changed (pinned by `BLOCK-ELISE-Q2-16`). The local
clarification writes an ordinary `style_chat_messages` row through the existing
`saveStyleChatMessage` (the same path the greeting uses; `provider` is free text,
`source_message_id` deliberately omitted so it never meets the assistant
idempotency index).

## H. Quality harness

Extended the existing `tools/elise-concierge-eval` harness (no second framework):
`conversation/conversationSequences.json` (22 sanitized synthetic sequences
covering all 20 journeys + two negative controls), `conversation/conversationEvaluator.js`,
runner mode `CONVERSATION`, tests in `__tests__/conversationSequences.test.js`
(including a negative control proving the evaluator can fail). The evaluator
imports the real frame via Node type-stripping, exactly as L1.5 imports
production code.

Deterministic result: **22/22 sequences pass**; by dimension — task reset 7/7,
context retention 21/21, constraint retention 19/19, action selection 12/12,
contradiction 12/12, ownership grounding 4/4, rejection/correction 2/2,
reference resolution 5/5.

Subjective dimensions (response relevance, fashion specificity, verbosity) are
reported as `HUMAN_REVIEW` and never scored — they are the model's, and the
model prompt is outside this lane.

### Subjective before/after (sanitized fixtures)

**1. "No heels", four turns later** — *Dress me for dinner.* → *No heels.* → *More
colour?* → *Warmer, please.* → *Something dressier.*
Before: the model's 6-message window no longer contains "No heels"; if it
suggests pointed-toe pumps, the reply is shown as a normal recommendation.
After: same reply text, plus one line: *"That mentions heels, which you asked me
to leave out. Ask me for a swap and I'll keep it out."*
Why better: an ignored constraint is never presented as compliant; the customer
does not have to notice it.

**2. Ambiguous jacket** — Elise: *Layer the denim jacket or the leather jacket
over it.* → *Use that jacket.*
Before: a full model turn (and a daily-quota message) where the model picks one
and may style the wrong jacket.
After: *"Do you mean the denim jacket or the leather jacket?"* immediately, zero
model calls, zero quota.
Why better: the ambiguity is about what was shown — a fact the client already
has — so it is answered exactly and instantly.

**3. Owned-only with a shopping proposal** — *Which jacket I own works best?*
(Commerce activation on; model also proposes `find_products`.)
Before: an external shelf could attach under an owned-only question.
After: no shelf, no provider call, and *"You asked to stick to what you own, so I
haven't pulled up anything to buy. Say “show me options to buy” if you'd like to
shop."* — then *Yes please* resumes the held request.
Why better: owned-only is a hard constraint and shopping becomes an offer the
customer accepts.

**4. Category mention is not shopping** — *What shoes work with this?*
Before: if the model proposed `find_products`, a shelf fired on a styling
question.
After: held with *"I haven't pulled up anything to buy. Say “show me options” if
you'd like to shop."*
Why better: advice stays advice; Commerce runs when asked.

**5. Rejected pair comes back** — Elise: *White sneakers keep it easy.* → *I don't
like those shoes.* → reply *Try white sneakers with a thicker sole.*
After: *"That brings back the white sneakers you passed on. Ask me for a swap and
I'll suggest something else."* — while *"Swap the white sneakers for tan suede
loafers"* and *"Try black leather sneakers"* pass untouched (the object is
rejected, not the category).

**6. Correction** — *Those are boots, not loafers.*
Before: the garment words could be read as a shopping cue or an exclusion.
After: recorded as a correction; "not loafers" is not an exclusion and the turn
never shops.

## I. Regression

See the PR for exact totals. Suites run: Elise, StyleChat, Wardrobe Concierge,
Commerce activation/V2, ProductShelf contract (read-only), Closet context,
Signature Style, avatar/speech, UI-block rendering, stale completion, TypeScript,
source architecture gates, the full governed suite (`node scripts/run-all-tests.js`)
and the eval harness.

## J. Performance

Measured on the dev host (Node 24, desktop CPU, 2000 runs after warm-up):

| History | Frame derivation | Reply validation |
|---|---|---|
| empty | 0.027 ms | 0.007 ms |
| typical (6 messages) | 0.115 ms | 0.007 ms |
| full window (16 messages, shelves, numbered lists) | 0.392 ms | 0.007 ms |

A phone JS engine is slower than desktop V8; even at 10× the full-window cost
stays around 4 ms, against a network round trip of hundreds. The perf test
asserts a < 5 ms mean on the CI host; the evaluator records per-sequence
`frameMs`. Context/token delta to the model: **0**. Network delta: **0**, or
**−1** round trip on a local clarification.

## K. Deferred architecture

`BACKEND_FOLLOWUP_REQUIRED` — the model-facing half. Proposed, not applied:

1. **Send the task frame to the model.** Add an optional, validated
   `conversationFrame` request field (codes + closed-vocabulary tokens only:
   `negations`, `budget`, `colors`, `occasion`, `ownedOnly`, `formality`,
   `warmth`, `rejections`, `corrections`, `relation`), rendered server-side as a
   short `[Current task]` block under `promptEnvelope` trust separation. This is
   what lets the model *honour* "no heels" after it leaves the 6-message window,
   rather than the client only *flagging* it. Zero additional model calls. The
   frame module is zero-import and erasable-TS so it can move to `_shared/` as-is.
2. **Prompt refinements** (section 32): a clarification rule ("ask one concise
   either/or question only when two shown items fit"), the "different ≠ random /
   another = one more" semantics for non-Commerce styling, minimal-change outfit
   refinement, and a brevity budget for either/or questions.
3. **Garment-class exclusions for Commerce.** "No heels" is not a Commerce
   exclusion axis (the reducer knows `material` and `color` only), so a shelf can
   still include a pump — see `COMMERCE_V2_FOLLOWUP`.

`FUTURE_MEMORY_ARCHITECTURE_OPPORTUNITY` — standing preferences across sessions
("I never wear heels") would need a governed, consented store. Deliberately not
built; the frame forgets on task reset by design.

`COMMERCE_V2_FOLLOWUP` — (a) a `garment` exclusion axis ("no heels", "no
blazers") in `eliseCommerceIntent.ts` + ranker Stage A; (b) review of the new
activation precondition in `useStyleChat.ts`.

`HAPTICS_FOLLOWUP_REQUIRED` — none required. #427 has not landed on the base;
the notices are static text and use no haptics.

## Recorded, not repaired (P4)

- `retryLastMessage`'s fallback branch (no remembered failed send) resends the
  last user message with persistence on, which writes a second user row.
- An empty `if (hasAttachments) { }` block remains in the success path of
  `sendMessage` (inert).
- The frame's phrase sets are English-only and closed by design. A missed
  constraint paraphrase means no flag (pre-lane behaviour); a missed SHOPPING
  paraphrase means a hold with a one-line offer ("say “show me options”"), which
  is recoverable in one turn but is friction. The cue list (explicit verbs,
  prices, "I need a…", recommend/suggest + garment, elliptical item requests,
  memory ops, acceptance) should be widened from real transcripts, not guessed.
