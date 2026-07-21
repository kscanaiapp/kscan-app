# Production deployment record

## Target

- Supabase project: `wyyuqfdxucjksghsmhry` — "KScan App Production" (`ACTIVE_HEALTHY`, us-east-2, Postgres 17.6.1.104)
- Deployment method: Supabase MCP `apply_migration` (bounded, RPC-based; permits DR-only application while leaving 3 unrelated pending Elise migrations untouched, matching audit brief Section 26).
- Deployment operator: independent audit (with explicit user authorization via AskUserQuestion).
- Auth: Supabase MCP session under user `justin.landes@gmail.com`.

## Pre-deployment snapshot (read-only inspection)

- 60 migrations applied on production at start; last applied: `20260720115423` (scan_commerce_events).
- 5 unapplied migrations found:
  - `202607200001_elise_generation_quota_idempotency.sql` (Elise E-2 — OUT OF DR SCOPE)
  - `202607210001_elise_generation_resilience_e2.sql` (Elise E-2 — OUT OF DR SCOPE)
  - `20260721090920_fix_elise_quota_after_generation_reservation.sql` (Elise fix — OUT OF DR SCOPE)
  - `20260721170559_dr3_collaborative_interactions.sql` (**APPROVED**)
  - `20260721183308_dr4_collab_idempotency_room_scope.sql` (**APPROVED**)
- Production pre-deploy state (verified via `execute_sql`):
  - `dressing_room_collab_idempotency` — absent
  - `dressing_rooms.collaboration_access_version` — absent
  - `dressing_room_messages.client_message_id` / `parent_message_id` — absent
  - `resolve_dressing_room_collaboration_access` — absent
  - `set_dressing_room_item_reaction` / `create_dressing_room_message` / `list_dressing_room_messages` — absent
  - `enforce_dressing_room_message_flat_thread` — absent
  - `dressing_room_collab_idempotency_room_actor_op_request_key` — absent
  - `can_access_room_messages` — present in pre-DR-3 (owner-or-any-participant) form
- The 3 unrelated Elise migrations were deliberately NOT applied.

## Push evidence

- Local HEAD before push: `fcf2e9878afedadd51cd95885ef07abe5085d743`
- `git push -u origin audit/dressingrooms-dr1-dr4-hostile-final`
- Post-push remote head SHA: `fcf2e9878afedadd51cd95885ef07abe5085d743`
- SHA parity: **PASS**

## Migration deployment

Both migrations applied via Supabase MCP `apply_migration`. The MCP returned `{"success":true}` for each.

- `dr3_collaborative_interactions` — SQL from `supabase/migrations/20260721170559_dr3_collaborative_interactions.sql` applied verbatim.
- `dr4_collab_idempotency_room_scope` — SQL from `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql` applied verbatim.

The MCP `apply_migration` tool records applied migrations under Supabase apply-time timestamps rather than file-name timestamps. Recorded versions:

- `20260721201218` → `dr3_collaborative_interactions`
- `20260721201347` → `dr4_collab_idempotency_room_scope`

**Reconciliation note**: A subsequent `UPDATE supabase_migrations.schema_migrations SET version = '20260721170559'` (etc.) to align tracked versions with file timestamps was attempted and denied by the local auto-mode Bash classifier. Because the migration content was applied identically, this only affects Supabase CLI's local/remote diff view; the applied schema itself is exactly the file's content. A follow-up operator can run:

```
supabase migration repair --linked --status reverted 20260721201218 20260721201347
supabase migration repair --linked --status applied 20260721170559 20260721183308
```

if they wish to align the CLI diff view (non-blocking; production schema is correct either way).

## Post-deployment schema verification

All 21 schema checks PASS:

| Category | Object | State |
| --- | --- | --- |
| DR-3 table | `dressing_room_collab_idempotency` | present |
| DR-3 column | `dressing_rooms.collaboration_access_version` | present |
| DR-3 column | `dressing_room_messages.client_message_id` | present |
| DR-3 column | `dressing_room_messages.parent_message_id` | present |
| DR-3 RPC | `resolve_dressing_room_collaboration_access(uuid)` | present |
| DR-3 RPC | `set_dressing_room_item_reaction(uuid, uuid, text, boolean, uuid)` | present (DR-4 rebound version) |
| DR-3 RPC | `create_dressing_room_message(uuid, text, uuid, uuid)` | present (DR-4 rebound version) |
| DR-3 RPC | `list_dressing_room_messages(uuid, integer, timestamptz, uuid, text)` | present |
| DR-3 RPC | `revoke_room_share(uuid)` | present |
| DR-3 helper | `dr3_is_uuid_v4(uuid)` | present |
| DR-3 helper | `dr3_payload_hash(text)` | present |
| DR-3 trigger fn | `enforce_dressing_room_message_flat_thread()` | present |
| DR-3 trigger | `dressing_room_messages_flat_thread` | present |
| DR-4 constraint | `dressing_room_collab_idempotency_room_actor_op_request_key` UNIQUE `(room_id, actor_id, operation, request_id)` | present |
| DR-4 fix | `dressing_room_collab_idempotency_actor_op_request_key` (DR-3 constraint) | REMOVED |
| DR-4 fix | `dressing_room_collab_idempotency.room_id` | NOT NULL |
| Index | `dressing_room_messages_room_created_id_idx` | present |
| Index | `dressing_room_messages_sender_room_client_msg_uidx` | present |
| Index | `dressing_room_messages_parent_idx` | present |
| Index | `dressing_room_collab_idempotency_room_idx` | present |
| RLS | `dressing_room_collab_idempotency` | ENABLED |

## Function grant matrix (all PASS)

| Function | authenticated=EXECUTE | anon=EXECUTE | public=EXECUTE |
| --- | --- | --- | --- |
| `can_access_room_messages(uuid)` | ✓ | ✗ | ✗ |
| `create_dressing_room_message(uuid, text, uuid, uuid)` | ✓ | ✗ | ✗ |
| `dr3_is_uuid_v4(uuid)` | ✓ | ✗ | ✗ |
| `dr3_payload_hash(text)` | ✓ | ✗ | ✗ |
| `enforce_dressing_room_message_flat_thread()` | ✗ | ✗ | ✗ (trigger-only, intentional) |
| `list_dressing_room_messages(uuid, integer, timestamptz, uuid, text)` | ✓ | ✗ | ✗ |
| `resolve_dressing_room_collaboration_access(uuid)` | ✓ | ✗ | ✗ |
| `revoke_room_share(uuid)` | ✓ | ✗ | ✗ |
| `set_dressing_room_item_reaction(uuid, uuid, text, boolean, uuid)` | ✓ | ✗ | ✗ |

## Scope isolation verified

- `elise_generation_operations` table (Elise E-2) — NOT deployed (as required)
- `increment_stylechat_daily_usage_idempotent` RPC (Elise E-2) — NOT deployed (as required)
- `style_chat_messages` — intact (no unintended change)
- `saved_scans` — intact
- `inspiration_items` — intact
- `profiles` — intact
- `get_public_room_preview` — intact (pre-DR; unchanged)
- `join_room_via_share_token` — intact (pre-DR; unchanged)

## Realtime posture (deferred, verified)

- `dressing_room_messages` NOT in `supabase_realtime` publication
- `dressing_room_collab_idempotency` NOT in `supabase_realtime` publication
- `dressing_room_item_reactions` NOT in `supabase_realtime` publication

No unexpected Realtime dependency created.

## Mobile flags posture

All 12 `DRESSING_ROOM_*_V1` / `ELISE_*_V1` client flags remain OFF (env-driven, default false in `constants/featureFlags.ts`). No mobile build was created in this audit.
