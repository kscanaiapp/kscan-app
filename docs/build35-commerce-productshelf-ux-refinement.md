# Build 35 — Commerce / ProductShelf shopping UX refinement

Lane record. Presentation-only refinement of the existing shelf. No ranking,
retrieval, provider, schema, migration, Edge Function, staging or production
change.

## Authority

| | |
|---|---|
| `BUILD35_BASE_BRANCH` | `fix/notifications-final-convergence-v1` |
| `BASE_SHA` | `d66f03d6126bdfb65bfa0301bf8474d2e584a544` (#414 merge) |
| `UPSTREAM_SHA` | `d66f03d6` (origin tip at dispatch) |
| Branch | `feature/build35-commerce-productshelf-ux-v1` |
| `WORKTREE_CLEAN` | YES at dispatch |

## Actual journey (source authority)

```
Elise turn ── stylechat-generate emits find_products (model-proposed; flag ELISE_COMMERCE_ACTIVATION_V1)
   └─ reduceShoppingIntent + detectShelfMemoryDirective   supabase/functions/stylechat-generate/eliseCommerceIntent.ts
        └─ response.shoppingIntent ──► hooks/useStyleChat.ts (prose painted FIRST, then Commerce)
             └─ runCommerceActivation                     services/style-chat/commerceActivation.ts  (Commerce V2 memory)
                  └─ scan-identify commerce_only (no model)  services/commerceHydration.ts
                       └─ ranker attaches commerceRationale + commercialUsability per product
             └─ ui_block `commerce_products`  ──► StyleChatBubble ──► CommerceProductsBlock ──► ProductShelf
                                                                     ├─ Shop   → openCommerceOffer (commerceExit)
                                                                     ├─ Save   → AddToRoomModal → addProductToDressingRoom (dedupes)
                                                                     ├─ Watch  → WatchThisModal → createWatch (server idempotent)
                                                                     └─ Try On → TryItOnEntry → useVtoMode → resolveVtoMode (sheet, no navigation)
```

Stale protection: `isSendingRef` serialises turns and `isCurrentSend()` checks
actor/session scope, so a late shelf cannot land over a newer turn. This lane
adds no second concurrency mechanism.

## Parallel lanes

| Lane | State | Overlap |
|---|---|---|
| Commerce V2 (#412) | MERGED on base | Consumed: memory ops, exclusions, `hiddenCount`, notices |
| Haptics / optimistic UI (#427) | OPEN | `ProductShelf` modal lines only; merge simulated **clean** |
| Elise Conversation Quality V2 | local, 3 commits | Owns the shopping-vs-owned activation gate; merge simulated **clean** |
| VTO decision loop | local, 4 commits | Owns the VTO sheet/return; merge simulated **clean** |
| Packing/Concierge quality | local | none |
| Receipt Intelligence | local | analytics registry (reason no telemetry was added here) |

## Before / after

**Budget — "Black loafers under $150."**
Before: an unlabelled lowercase line `black · under 150 USD`, cards with a
title and a price, the image as the only way to open the listing, a 6px gold
dot meaning "has link". After: chips `black` `loafers` `Under 150 USD`; each
card shows the ranker's own reason ("Matches the colour you asked for",
"Within your budget"), price with its code (`$129.00 USD`), and a SHOP button.
Clearer: what was retained and why each card is here. Easier: one obvious
primary action.

**Negative material — "…not leather."**
Before: the exclusion was carried in the block but never rendered. After: a
`No leather` chip; hidden rejects show as `N hidden`.

**Confirmed packing gap.** Card reasons carry `confirmed_gap_match` /
`unconfirmed_gap_context` copy when present (hedged wording for unconfirmed).
**Not yet reachable end to end** — see follow-ups.

**Product without a purchase path.** Before: identical card, image just not
tappable. After: "Purchase link unavailable" and no control; a shelf with no
buyable offer says "I found relevant items, but none currently have a verified
purchase path." — distinct from "nothing matches".

**Comparison.** Select 2–3 (`COMPARE` checkbox on the image) → sheet with
item, price, same-currency difference vs option 1, retailer, brand, category,
listing type, matched attributes, reasons, purchase state; missing facts read
"Not listed"; Shop/Save/Watch route through the shelf's own handlers.

**VTO-eligible product.** Unchanged authority (`TryItOnEntry` →
`resolveVtoMode`), now sitting under the primary SHOP and above a single
Save | Watch row instead of in a four-button stack.

## Follow-ups (not done here, by design)

- `SHARED_SURFACE_FOLLOWUP_REQUIRED` — **Owned-only activation (BLOCK-COM-UX-09)**
  has no deterministic gate on base: the model's `find_products` alone decides.
  The Elise Conversation Quality V2 lane (`decideEliseCommerceActivation`) owns
  that gate; this lane does not add a competing one. Its gate allows
  refinements inside an active shopping task, so the chips here stay
  compatible.
- `SHARED_SURFACE_FOLLOWUP_REQUIRED` — **Packing gap context never reaches
  the shelf**: `app/packing/index.tsx` drops `gapCode`/certainty and
  `useStyleChat` never passes `extraContributions`/`packingGapContribution`.
  Needs `useStyleChat` (Elise-lane file) + `app/packing`.
- `COMMERCE_V2_FOLLOWUP_REQUIRED` — **Go back** restores one referenced
  product ("go back to the first one"), not a whole prior shelf; no chip is
  offered until a shelf-level restore exists.
- `BACKEND_FOLLOWUP_REQUIRED` — the same owned-only rule belongs server-side
  too (drop `find_products`); an Edge change also regenerates the governed
  edge-function manifest, which is outside this lane.
- `VTO_FOLLOWUP_REQUIRED` — Compare omits a VTO row: `useVtoMode` re-reads
  remote config when VTO is disabled, so a per-column resolve would add
  requests. Needs a hoisted decision from the canonical hook.
- `PRODUCT_IDENTITY_FOLLOWUP_REQUIRED` — no client "already watching" read
  exists; `Watching` reflects only creates confirmed in this shelf session.
  Server and client URL canonicalisation also differ.
- Telemetry not added: no commerce surface in the analytics registry, and
  the registry is being edited by the Receipt Intelligence lane.
- Chat has no in-shelf "Finding options…" placeholder between prose and
  shelf (requires `useStyleChat`); `ProductShelf`'s own pending state now
  says "Finding options…".
