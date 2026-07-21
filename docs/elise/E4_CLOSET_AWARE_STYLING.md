# Elise E-4 — Closet-Aware Styling Intelligence

## Summary

E-4 adds flag-gated closet-aware advice to `stylechat-generate`:

1. Deterministic advice-intent classification
2. Focused item resolution from E-1 envelope
3. Actor-authorized wardrobe retrieval (saved scans, inspiration, owned rooms, shared rooms)
4. Deterministic compatibility scoring
5. Wardrobe-gap + purchase-advice + multi-look reasoning
6. Bounded prompt grounding (no full Closet dump)
7. Optional structured `adviceMetadata` for newer clients

## Limits

| Stage | Limit |
| ----- | ----- |
| Initial candidates per source | 40 |
| Ranked merge | 24 |
| Grounded shortlist | 10 |
| Multi-look count | 3 |

## Feature flags (default OFF)

- `ELISE_ADVICE_INTENTS_V1_ENABLED`
- `ELISE_CLOSET_RETRIEVAL_V1_ENABLED`
- `ELISE_COMPATIBILITY_SCORING_V1_ENABLED`
- `ELISE_WARDROBE_GAP_V1_ENABLED`
- `ELISE_PURCHASE_ADVICE_V1_ENABLED`
- `ELISE_MULTI_LOOK_V1_ENABLED`

## Runtime classification

| Change | Class |
| ------ | ----- |
| Backend advice pipeline + flags | BACKEND-ONLY |
| Optional `adviceMetadata` response | SHARED CONTRACT |
| Client passthrough of advice metadata | NEXT-BUILD CLIENT WIRING |

## Rollback

Disable E-4 flags independently. Legacy Elise text path remains unchanged when `ELISE_ADVICE_INTENTS_V1_ENABLED=false`.

## Not in this task

- No production deploy
- No production migration
- No mobile build
- No checkout / cart mutation
