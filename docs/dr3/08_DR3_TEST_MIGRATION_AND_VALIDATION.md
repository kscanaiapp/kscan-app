# DR-3 Test, Migration, and Validation

## Migration artifact

| Field | Value |
| ----- | ----- |
| Path | `supabase/migrations/20260721170559_dr3_collaborative_interactions.sql` |
| Nature | Additive; replaces access/revoke functions; adds columns/indexes/trigger/table/RPCs |
| Applied to production `wyyuqfdxucjksghsmhry` | **No** (READ ONLY this pass) |
| MCP live schema verify | **Timed out** → validate against migration/source contract only |

### Apply order (non-prod first)

1. Review SQL in staging/project clone.
2. Apply migration via approved Supabase CLI/workflow (not done here).
3. Smoke RPCs with owner + shared recipient + revoked recipient.
4. Only then enable client flags on a next build.

### Rollback sketch

- Client: leave all DR-3 flags OFF (legacy paths).
- Server: reverse requires careful drop of RPCs/trigger/columns/ledger; do **not** invent a rollback migration in this pass. Prefer forward-fix if applied.

## Automated tests

| Suite | Location | What it proves |
| ----- | -------- | -------------- |
| DR-3 Node contract | `__tests__/dr3Collaboration.test.js` | Flags OFF naming; migration contract strings (access harden, no OFFSET, keyset, idempotency, flat thread); UUIDv4; merge dedupe; actor generation; access parser fail-closed; RPC wiring presence; shared RN parity; legacy paths intact |
| Generation safety typing | `supabase/functions/stylechat-generate/generationSafetyTyping.test.ts` | `GenerationRpcClient` PromiseLike + attempt label typing |
| Bridge baseline at first commit | Deno 71 + Node 101 | Clean type baseline post-`bb13c2d` |

DR-3 Node suite is primarily source-contract + pure behavioral (no live Postgres).

## Static / compile gates recorded

| Gate | Result |
| ---- | ------ |
| `deno check` stylechat-generate (post `bb13c2d`) | **0 errors** |
| Production MCP schema | Unavailable (timeout) |
| Device builds | None |

## Manual / next-build validation checklist

| # | Check | Gate |
| - | ----- | ---- |
| 1 | Flags OFF: legacy list/send/react unchanged | RUNTIME |
| 2 | Migration applied staging: revoked participant fails list/send/react | RUNTIME |
| 3 | Owner still sees history after revoke | RUNTIME |
| 4 | Duplicate reaction `requestId` returns same result | RUNTIME |
| 5 | Duplicate `client_message_id` same body idempotent; different body rejected | RUNTIME |
| 6 | Keyset older pages; no OFFSET | RUNTIME |
| 7 | Reply-to-reply rejected by trigger | RUNTIME |
| 8 | Bounded refresh tears down on revoke | RUNTIME + PHYSICAL |
| 9 | Account switch mid-flight does not apply stale messages | RUNTIME |
| 10 | Android + iOS next builds with flags ON | PHYSICAL |

## Validation not performed

- Production migration apply
- Live RPC exercise against `wyyuqfdxucjksghsmhry`
- Emulator/simulator/physical builds
- Load/perf under large message histories
