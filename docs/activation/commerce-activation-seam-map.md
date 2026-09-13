# Commerce Activation — Seam Map

Activation of the contextual Commerce capability merged in PR #409
(`28e1203aebe4864e4bed689ccb14d16ec857aaf7`), so it is reachable through real
customer journeys.

Every seam below was **executed or type-probed before any product edit**.
Source inspection alone never produced a `READY` verdict. Re-run the probes:

```bash
node tools/activation/seamProbes.js        # all seams, with observed values
node tools/activation/phase0Baseline.js    # zero-context + customer-quality baselines
node tools/activation/journeyHarness.js    # Journey A end to end
node tools/activation/fmqActivationGate.js # FMQ context-off vs context-on
node tools/activation/activationPerf.js    # local assembly cost
```

## Turn architecture (the constraint everything else follows from)

```
ELISE_TURN_STRUCTURE = SINGLE_PASS
```

`stylechat-generate` sends **one** Gemini request per turn. There is no
`tools`, `functionDeclarations` or `toolConfig` key anywhere in the request
body (`index.ts:buildGeminiBody`), so there is no native tool-calling and no
model→tool→model loop. The only second call is a *completeness* retry
(`index.ts:buildRetryTurns`), never a tool continuation.

Consequence: Commerce runs **after** the model turn, deterministically, from
the `<actions>` block that single pass already emitted. The model never sees
the products, which is also why no second model pass is needed to explain them
— rationale renders from #409's structured facts.

```
MODEL_TURNS_PER_NORMAL_ELISE_TURN   = 1  (2 only on an incomplete-response retry)
MODEL_TURNS_PER_COMMERCE_ELISE_TURN = 1
TOOL_TURNS_ADDED                    = 0
COMMERCE_SIDE_LLM_CALLS_ADDED       = 0
```

## Persistence

```
PERSISTENCE_PATH = existing structured message/ui-block metadata (preference #1)
INTENT_LIFETIME  = per shopping thread; 16 refinement turns, then stale
RESET_MECHANISM  = a clearly new garment category resets it (§15); a stale turn count drops it
```

The shopping intent rides the **existing `ui_blocks` jsonb column** as a
`commerce_shopping_intent` block — the pattern `concierge_outfit_state`
already established. No new table, no new column, no migration. The client
persists it (`styleChatRepository.ts:271`); the server reads it back from
ASSISTANT rows only, on the same RLS-bound history read the turn already does.

Intent updates are **copy-on-write**: `reduceShoppingIntent` always returns a
new object with rebuilt arrays, so turn N's persisted snapshot is untouched by
turn N+1.

**Product result persistence.** Product cards are persisted in the same
`ui_blocks` the rest of the turn uses, and re-verified at render time. No
durability semantics were invented for price/stock/availability: the block
stores what Commerce returned for that turn, and a card renders only if it
still carries Commerce provenance.

---

## SEAM A — ELISE → COMMERCE INTENT

| | |
|---|---|
| **A side** | `supabase/functions/stylechat-generate/actions.ts` — `extractActionsBlock`, `validateStyleChatActions`, `ALLOWED_STYLECHAT_ACTIONS` |
| **B side** | `supabase/functions/stylechat-generate/eliseCommerceIntent.ts` — `reduceShoppingIntent` → `contributionsFromState` |
| **INPUT** | model text containing `<actions>[{"type":"find_products","shopping":{…}}]</actions>` |
| **OUTPUT** | `EliseShoppingIntentState` (typed, validated, persisted) |
| **TYPE_COMPAT** | `ADAPTER_REQUIRED` — the action payload is a navigation shape; the reducer speaks typed shopping fields |
| **SEMANTIC_COMPAT** | `PASS` |
| **INVARIANTS** | deterministic code owns the persisted intent; the model only proposes. Fields are allowlisted against fixed vocabularies; a budget without an ISO currency is dropped; a later explicit instruction supersedes an earlier one; copy-on-write |
| **ERROR STATE** | malformed/unknown action → dropped by the allowlist; unparsable `<actions>` → no action, prose preserved |
| **EMPTY STATE** | a bare `find_products` with every field rejected still carries the previous intent forward |
| **AUTH BOUNDARY** | `stylechat-generate` `resolveAuthContext`; actions validated against the authenticated resolved attachment set |
| **ACTOR BOUNDARY** | prior intent restored from `.eq('user_id', userId)` RLS-bound rows, ASSISTANT rows only |
| **RUNTIME** | deno/edge |
| **PERSISTENCE** | `ui_blocks` → `commerce_shopping_intent` |
| **ADAPTER LOCATION** | `eliseCommerceIntent.ts` (Elise activation boundary) — Elise-specific translation belongs on the Elise side |
| **CLASSIFICATION** | `NEEDS_ADAPT` → built |
| **PROBE** | `node tools/activation/seamProbes.js` → `A_ELISE_TO_COMMERCE_INTENT` |
| **TEST** | `commerceActivationJourneys.test.js :: JOURNEY A/B/C/D`, `commerceActivationBlocking.test.js :: BLOCK-07 (hostile action payload)` |
| **EXPECTED** | `"different shoes under $120"` → `{category:'footwear', budget:{120,USD}}`; `"unobtanium"`/`"chartreuse"` dropped |

## SEAM B — COMMERCE RESULT → ELISE STRUCTURED BLOCK

| | |
|---|---|
| **A side** | `qualityTuneCommerce.ts:filterAndDedupeProducts` → per-product `commerceRationale` |
| **B side** | `services/style-chat/types.ts:StyleChatUiBlock` → `components/style-chat/StyleChatBubble.tsx` → `CommerceProductsBlock` → `ProductShelf` |
| **INPUT** | `CommerceHydrationResult` |
| **OUTPUT** | `commerce_products` ui_block `{status, products[], intentSummary}` |
| **TYPE_COMPAT** | `ADAPTER_REQUIRED` |
| **SEMANTIC_COMPAT** | **`LOSSY` as found** — see finding below |
| **INVARIANTS** | every card resolves to a real Commerce candidate; `error` ≠ `no_matches`; Shop/Save/Watch gating delegated to `ProductShelf`, never re-implemented |
| **ERROR STATE** | `status:'error'` → "I couldn't check live options right now." → zero cards |
| **EMPTY STATE** | `status:'no_matches'` → "I couldn't find a current option that fits those constraints." → zero cards |
| **AUTH BOUNDARY** | `scan-identify` `commerce_only`, authenticated |
| **ACTOR BOUNDARY** | `requestActorId` is the authenticated id, server-side |
| **RUNTIME** | deno/edge → react-native |
| **PERSISTENCE** | `ui_blocks` → `commerce_products` |
| **ADAPTER LOCATION** | producer side owns publication (`qualityTuneCommerce.ts`); consumer shaping in `services/style-chat/commerceActivation.ts` |
| **CLASSIFICATION** | `EXISTS_BUT_WRONG_SHAPE` → repaired additively |
| **PROBE** | `node tools/activation/seamProbes.js` → `B_COMMERCE_RESULT_TO_BLOCK` |
| **TEST** | `commerceActivationBlocking.test.js :: BLOCK-01`, `BLOCK-13` |

> **Finding — #409 shipped this seam as dead output.** `filterAndDedupeProducts`
> computed `stats.rationale` and **nothing read it**: not `scanCommerceRouter`,
> not `index.ts`, not any response. The facts a card needs could not reach a
> customer. Repaired additively by attaching `commerceRationale` to each
> product where product and facts are provably the same index, so the facts
> travel through the router, the cache, the response envelope and the client's
> pass-through `normalizeProducts` without any of them needing to know. Zero-context
> products are unchanged — the field is absent entirely.

## SEAM C — PACKING GAP → COMMERCE INTENT

| | |
|---|---|
| **A side** | `packingGaps.ts:derivePackingCoverageGaps` → `PackingGapV2 {code,label,certainty,source,slotIds}` |
| **B side** | `commercePackingBridge.ts:contributionFromPackingGap` |
| **TYPE_COMPAT** | `PASS_WITHOUT_CAST` |
| **SEMANTIC_COMPAT** | `PASS` |
| **INVARIANTS** | CONFIRMED stays CONFIRMED; UNCONFIRMED stays UNCONFIRMED and contributes **zero** ranking-bearing fields; no return path exists |
| **ERROR/EMPTY** | null gap or unrecognised certainty → `null` |
| **ACTOR BOUNDARY** | plan is actor-scoped upstream; the bridge is pure |
| **RUNTIME** | deno/edge |
| **PERSISTENCE** | none (request-scoped) |
| **CLASSIFICATION** | `READY` — already correct in #409, no adapter needed |
| **PROBE** | `seamProbes.js` → `C_PACKING_GAP_TO_INTENT` (derives a REAL gap from the real deriver) |
| **TEST** | `commerceActivationPacking.test.js :: JOURNEY F/G`, `commerceActivationBlocking.test.js :: BLOCK-04` |

## SEAM D — CLOSET → COMMERCE CONTEXT

| | |
|---|---|
| **A side** | `services/ownedClosetItems.ts:listOwnedClosetItems` (RLS-bound) |
| **B side** | `services/commerce/shoppingContext.ts:closetContribution` |
| **TYPE_COMPAT** | `ADAPTER_REQUIRED` |
| **SEMANTIC_COMPAT** | **`LOSSY` as first wired** — see finding below |
| **INVARIANTS** | deterministic selection only, no model call; `MAX_CLOSET_CONTEXT_ITEMS = 6`; same-category only; descriptor + colour/material/category only; **no item ids leave the device** |
| **ERROR/EMPTY** | empty or failed Closet read → `null` contribution, request proceeds with less context |
| **ACTOR BOUNDARY** | stamped with the authenticated actor; `#409` drops any contribution tagged for another actor, anonymous requests included |
| **ADAPTER LOCATION** | `services/style-chat/commerceActivation.ts:selectClosetContext` — the activation boundary owns the taxonomy translation; Commerce should not learn Closet words and the Closet should not learn shopping categories |
| **CLASSIFICATION** | `NEEDS_ADAPT` → built, then repaired |
| **PROBE** | `seamProbes.js` → `D_CLOSET_TO_CONTEXT` |
| **TEST** | `commerceActivationJourneys.test.js :: JOURNEY H`, `commerceActivationBlocking.test.js :: BLOCK-03/BLOCK-12` |

> **Finding — WIRE_LOSSY, caught by Journey H, not by the seam probe.** The two
> systems use different category vocabularies: a shopping intent says
> `footwear`, a Closet item says `boot`. The substring filter matched neither
> direction, so the Closet contribution was silently dropped and duplication
> detection never ran. Diagnosed per §31: the intent reaching #409 was captured,
> #409 was invoked directly with the same universe, and #409 was correct — so
> the defect was the wire, not the ranker. The seam probe had used Closet
> vocabulary and therefore passed; the journey is what exposed it.

## SEAM E — SIGNATURE STYLE → COMMERCE CONTEXT

| | |
|---|---|
| **A side** | `services/style-dna/localStyleDnaProfile.ts:getStyleDnaProfileSummary` |
| **B side** | `services/commerce/shoppingContext.ts:signatureStyleContribution` |
| **TYPE_COMPAT** | `ADAPTER_REQUIRED` · **SEMANTIC_COMPAT** `PASS` |
| **INVARIANTS** | soft preference only — the weakest weight in #409's model; never overrides an explicit request, budget, exclusion, Packing requirement or commercial truth |
| **ERROR/EMPTY** | no tokens → `null` |
| **ACTOR BOUNDARY** | actor-stamped; server re-checks |
| **ADAPTER LOCATION** | `commerceActivation.ts:selectSignatureStyleContext` |
| **CLASSIFICATION** | `NEEDS_ADAPT` → built |
| **TEST** | `commerceActivationJourneys.test.js :: JOURNEY I/J` |

No fourth precedence implementation was added: precedence lives in #409's
`buildShoppingIntent` provenance ranking and is consumed, not re-stated.

## SEAM F/G/H — RESULT → SAVE / WATCH / SHOP

| | |
|---|---|
| **A side** | `services/commerceHydration.ts:normalizeProducts` (passes items through whole, so server-authored gating fields survive) |
| **B side** | `components/ProductShelf.tsx` — `canAddProductToDressingRoom`, `canWatchProduct`, `canShopProduct` |
| **TYPE_COMPAT** | `PASS_WITHOUT_CAST` · **SEMANTIC_COMPAT** `PASS` |
| **INVARIANTS** | Shop derives from #409 commercial usability, never rank or label; Watch requires the server-authored `watchCapability`; Save reuses the existing dressing-room path |
| **CLASSIFICATION** | `READY` — chat reuses `ProductShelf` rather than adding a second card system |
| **TEST** | `commerceActivationBlocking.test.js :: BLOCK-06` |

```
WATCHLIST_ATTACHED = YES (inherited, unchanged)
```
Watch renders in chat exactly where `ProductShelf` already renders it, gated by
the same server-authored `watchCapability === 'refreshable_listing'`. Watchlist
itself was not touched, redesigned, or re-gated.

## SEAM I — STRUCTURED BLOCK → SPEECH

| | |
|---|---|
| **A side** | `commerce_products` ui_block (carries retailer text) |
| **B side** | `supabase/functions/stylist-speech/handler.ts:166` → `speechText.ts:buildSpeechText` |
| **TYPE_COMPAT** | `PASS_WITHOUT_CAST` · **SEMANTIC_COMPAT** `PASS` |
| **CLASSIFICATION** | `READY` — **no change required** |
| **TEST** | `commerceActivationBlocking.test.js :: BLOCK-07 (speech)` |

Speech reads `message.content` — the prose string — and **never** `ui_blocks`.
Structured Commerce blocks are therefore excluded from TTS by construction, not
by a filter that could be forgotten. A regression test pins the call site so a
future change that starts feeding blocks to speech fails loudly.

---

## Precondition finding — commerce cache was intent-blind

Not a seam, but it would have broken the first refinement turn.

`buildCommerceCacheKey` keyed on garment and market fields only, and a cache
**hit returns the stored shelf without re-running `filterAndDedupeProducts`**
(`scanCommerceRouter.ts`, cache-hit branch). Before activation that was
harmless: the Scanner's intent was a function of the garment. Activation breaks
that assumption — "different shoes" and "different shoes under $120" are the
same garment and the same query with different correct answers, so an
over-budget candidate cached under an unconstrained turn would have been served
to a constrained one.

Repaired additively: an optional `shoppingIntentFingerprint` discriminates the
key. **Omitted → byte-identical key**, which is what keeps every zero-context
caller unchanged.

- Probe: `node tools/activation/seamProbes.js` → `preconditions`
- Test: `commerceActivationBlocking.test.js :: BLOCK-08` (both cache assertions)

## Deferred

- `PRECEDENCE_CONSOLIDATION_FOLLOWUP` — precedence rules are stated in #409's
  provenance ranking and echoed in prose in the Elise prompt and the Packing
  gap copy. They agree today; no refactor was attempted in an activation lane.
- `RANKING_FOLLOWUP_REQUIRED` — "only black" is an explicit *attribute* in #409
  (+22 match / −18 miss), not a Stage A exclusion, so a non-black option is
  ranked down rather than removed. Diagnosed per §31 as correct #409 behaviour,
  documented rather than retuned; changing it is a ranking-weight decision.
