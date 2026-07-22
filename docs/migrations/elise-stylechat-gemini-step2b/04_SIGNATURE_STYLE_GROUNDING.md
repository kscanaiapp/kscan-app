# 04 — Signature Style grounding

## Storage source (verified)

| Item | Value |
| --- | --- |
| Primary tables | `dressing_room_items`, `dressing_room_item_reactions` |
| Ownership | Authenticated `userClient` + RLS (same as client `styleMemoryRepository`) |
| Signals | brands, categories, scan colors, budget range from owned items + positive reactions |
| `style_memory_events` | Exists for debug/event writes; not used as active preference authority (matches client `buildStyleMemorySummary`) |

## Prompt wiring

- New `buildSignatureStyleContextBlock` → `signature_style_context` envelope section
- Size: max 5 signals/group, max 500 chars, deterministic truncation
- StyleDNA moved to separate `style_dna_context` section (no longer mislabeled as Signature Style)
- Same Signature Style block is used for primary and Lite calls (shared `geminiBody` / system assembly)
- No independent Signature Style LLM call
