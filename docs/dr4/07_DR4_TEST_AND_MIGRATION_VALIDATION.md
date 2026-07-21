# 07 — DR-4 Test and Migration Validation

## Migrations

| Artifact | Path | Applied to prod? |
| -------- | ---- | ---------------- |
| DR-3 collab | `supabase/migrations/20260721170559_dr3_collaborative_interactions.sql` | **No** |
| DR-4 idempotency room scope | `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql` | **No** |

### DR-4 migration summary

| Change | Detail |
| ------ | ------ |
| Data cleanup | `DELETE` null `room_id` ledger rows |
| Column | `room_id SET NOT NULL` |
| Drop | `dressing_room_collab_idempotency_actor_op_request_key` |
| Add | `unique (room_id, actor_id, operation, request_id)` |
| RPC rebind | Reaction + message create lookups include `room_id` |
| Nature | Forward-only; not applied to `wyyuqfdxucjksghsmhry` |

### Apply order (operators — external)

1. Apply DR-3 then DR-4 on non-prod.
2. Hostile RPC: cross-room same `requestId`, revoke, keyset, flat reply.
3. Next mobile build with selective flags ON.
4. Physical Android + iOS.
5. Production only under normal change control — **not this pass**.

### Rollback sketch

| Layer | Path |
| ----- | ---- |
| Client | Leave collab flags OFF |
| Server | Prefer forward-fix if applied; do not invent destructive rollback here |

## Exact commands

| Command | Class |
| ------- | ----- |
| `git diff --check` | STATIC |
| `npx tsc --noEmit` | TYPE CHECK |
| `deno check supabase/functions/stylechat-generate/index.ts` | TYPE CHECK |
| `deno test --no-check --allow-read supabase/functions/stylechat-generate/*.test.ts` | BEHAVIORAL |
| Node DR-2 bridge (established 10-file set) | BEHAVIORAL |
| `node --test __tests__/dr3Collaboration.test.js __tests__/dr4Hardening.test.js` | FOCUSED |

## Results recorded

| Gate | Result |
| ---- | ------ |
| `git diff --check` | **PASS** |
| `npx tsc --noEmit` | **PASS** |
| `deno check` stylechat-generate | **PASS** (0 errors) |
| Deno bridge | **71 pass** |
| Node DR-2 bridge | **101 pass** |
| Focused DR-3 + DR-4 Node | **24 pass / 0 fail** |
| Production migration apply | **Not performed** |
| Edge deploy | **Not performed** |
| Mobile build | **Not performed** |

## Manual / next-build checklist

| # | Check | Gate |
| - | ----- | ---- |
| 1 | Flags OFF: legacy paths silent | RUNTIME |
| 2 | Staging: cross-room same requestId succeeds | RUNTIME |
| 3 | Staging: revoked actor fails list/send/react | RUNTIME |
| 4 | Catch-up receives messages after newest cursor | RUNTIME |
| 5 | Access error during sync tears down UI | RUNTIME + PHYSICAL |
| 6 | Account switch mid-send does not apply | RUNTIME |
| 7 | Commerce fields survive room save | RUNTIME |
| 8 | Elise attachment: boolean presence only | RUNTIME |
| 9 | Android + iOS next builds | PHYSICAL (~1 week) |

## Validation not performed

- Production SQL apply on `wyyuqfdxucjksghsmhry`
- Live RPC against production
- APK/AAB/IPA/TestFlight/Play
- Physical device revoke mid-session
- Production MCP SQL (ENVIRONMENT GATE / unavailable)
