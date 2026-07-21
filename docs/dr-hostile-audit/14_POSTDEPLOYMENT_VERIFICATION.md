# Post-deployment verification

Executed via Supabase MCP `execute_sql` against production project `wyyuqfdxucjksghsmhry`.

## Objects verification

All 21 schema-object checks PASS. See [`13_PRODUCTION_DEPLOYMENT_RECORD.md`](13_PRODUCTION_DEPLOYMENT_RECORD.md) table.

## Function grants (RLS + privilege matrix)

Every DR-3/DR-4 function is `EXECUTE` granted to `authenticated` and denied to `anon` + `public`. `enforce_dressing_room_message_flat_thread` is a trigger-only function correctly denied to all callers (used only by the trigger runtime).

## Anonymous-invocation smoke

Executed `DO $$ ... PERFORM set_config('request.jwt.claim.sub', '', true); ... $$`, then invoked `resolve_dressing_room_collaboration_access(<uuid>)`. Result via NOTICE: the RPC returned `{"ok": false, "reason": "unauthenticated"}`, matching the design (anonymous callers cannot elevate to authenticated).

## Non-DR schema intact

- `public.style_chat_messages` — intact
- `public.saved_scans` — intact
- `public.inspiration_items` — intact
- `public.profiles` — intact
- `public.get_public_room_preview` — intact
- `public.join_room_via_share_token` — intact

## Scope isolation

- `public.elise_generation_operations` — NOT deployed (as required by audit scope)
- `public.increment_stylechat_daily_usage_idempotent` RPC — NOT deployed

## Realtime deferred

Not present in `supabase_realtime` publication:
- `public.dressing_room_messages`
- `public.dressing_room_collab_idempotency`
- `public.dressing_room_item_reactions`

## Data lifecycle

Ledger row count at end of deployment: **0**. No historical or test data was written to production by this audit.

## Rollback state / forward-remediation readiness

- All DR-3/DR-4 functions use `CREATE OR REPLACE FUNCTION`, so forward replacement is safe.
- DR-3 additions are additive columns/tables/triggers/RPCs. DR-4 swap replaced a single unique constraint on an empty ledger (0 rows), so no data loss risk.
- Should a hotfix be required, a new migration (higher timestamp) can be applied via the same MCP path.

## Post-deployment behavioral coverage (bounded)

Because this audit did not seed live production test rows (per operator judgment: no synthetic customer data in production), behavioral coverage of message-send / reaction-set / revoke was executed against the local disposable replay DB (see [`10_TEST_AND_VALIDATION_EVIDENCE.md`](10_TEST_AND_VALIDATION_EVIDENCE.md), 22 hostile scenarios PASS). Production behavioral coverage is deferred to the next mobile build with the collaboration client flags enabled, which is an explicit next-build gate per the audit brief.

## Existing-installed-client compatibility

DR-3/DR-4 change the `can_access_room_messages(uuid)` definition from owner-or-any-participant to owner-or-active-share. Older installed clients writing directly to `dressing_room_messages` continue to work as long as they are authorized. Revoked/expired participants who could previously read/write via direct table access now fail closed — this is the intended security tightening.

- Backward-compatible for: room owner path, active-recipient path, participant creation via `join_room_via_share_token`, public preview.
- Intended security tightening for: revoked/expired recipients (now fail closed).

## Post-deployment verdict

**POST-DEPLOYMENT VERIFICATION: PASS**
