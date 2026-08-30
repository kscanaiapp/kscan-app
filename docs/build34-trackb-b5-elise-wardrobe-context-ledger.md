# Build 34 — Track B — Phase B5: Elise Wardrobe Context

## Current integration

Elise continues to use the existing `stylechat-generate` Edge Function and the
existing bounded advice pipeline. For an eligible actor, it may retrieve
authorized Closet items and request the server-authoritative Signature Style
summary. Neither path accepts client-authored wardrobe facts or profile data.

The Signature Style prompt block is aggregate-only, bounded, clearly delimited,
and escapes all user-derived Closet values before model use. If the trusted
recomputation is unavailable or returns malformed data, Elise continues without
the block.

## Prompt-chain order

The final assembly is additive:

`base → weather → local feedback context → first-use gender context → stylist persona → server-derived Signature Style → grounded wardrobe/advice context → model`.

Source-contract tests prevent temporal-dead-zone reads, rebinding of the
long-standing local context name, a computed-but-unused server block, and loss
of either first-use or stylist context during a merge.

## Boundaries

Closet candidates retain the existing ownership checks and response contract.
Saved scans, inspiration, shared items, and commerce suggestions remain distinct
relationships; only an actor-authorized Closet item may be represented as owned.
No new Edge Function, model provider, retrieval system, response protocol, or
persistent data class was added.
