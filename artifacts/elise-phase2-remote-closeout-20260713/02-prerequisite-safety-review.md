# Stage 2 — Seven-prerequisite safety review

## 20260711000001

- FILENAME: `20260711000001_ai_stylist_looks_extension.sql`
- PURPOSE: Extend Looks and Look items for owned-closet and AI-generated outfits.
- TABLES_CHANGED: `looks`, `look_items`
- FUNCTIONS_CHANGED: `build_owned_item_snapshot`, `create_look_from_owned_items`, `update_look_owned_items`
- POLICIES_CHANGED: none
- GRANTS_CHANGED: authenticated EXECUTE on the two actor-checking public RPCs; helper remains internal
- TRIGGERS_CHANGED: none
- DATA_MUTATION: none; nullable columns and indexes only
- DESTRUCTIVE_OPERATION: none; replacement drops only the migration-owned check constraint
- DEPENDENCIES: existing Looks, saved scans, inspiration items, Auth, and owner RLS
- EXPECTED_APPLICATION_CONSUMER: Looks creation UI, style object service, StyleChat attachment resolution
- EXPECTED_REMOTE_RESULT: additive columns, source FKs/indexes, bounded snapshot and owner-authorized RPCs
- SAFE_TO_DEPLOY: `YES_IN_ISOLATION`

## 20260711000002

- FILENAME: `20260711000002_outfit_decision_rooms.sql`
- PURPOSE: Add immutable Dressing Room outfit decisions, options, snapshots, and votes.
- TABLES_CHANGED: four new `outfit_decision_*` tables
- FUNCTIONS_CHANGED: share, vote, counts, state, and public decision-preview RPCs
- POLICIES_CHANGED: room-member reads; own-vote read
- GRANTS_CHANGED: authenticated SELECT; authenticated RPC execution; bounded token-preview access for anon/authenticated
- TRIGGERS_CHANGED: updated-at triggers on groups and votes
- DATA_MUTATION: none
- DESTRUCTIVE_OPERATION: none; migration-owned trigger/policy replacement only
- DEPENDENCIES: `20260711000001`, dressing rooms, room shares, `can_access_room_messages`, updated-at helper
- EXPECTED_APPLICATION_CONSUMER: outfit decision service, Ask My Room modal, public room screen
- EXPECTED_REMOTE_RESULT: RLS-protected immutable snapshots and server-authorized decision mutations
- SAFE_TO_DEPLOY: `YES_IN_ISOLATION`

## 20260711000003

- FILENAME: `20260711000003_style_outfit_usage.sql`
- PURPOSE: Add daily and burst quota state for `style-outfit-generate`.
- TABLES_CHANGED: `style_outfit_daily_usage`, `style_outfit_burst_usage`
- FUNCTIONS_CHANGED: daily reservation and burst-check RPCs
- POLICIES_CHANGED: authenticated owner SELECT on daily usage
- GRANTS_CHANGED: daily SELECT and authenticated RPC execution; no direct burst-table client access
- TRIGGERS_CHANGED: none
- DATA_MUTATION: none during migration
- DESTRUCTIVE_OPERATION: none
- DEPENDENCIES: Auth users and current Postgres conflict constraints
- EXPECTED_APPLICATION_CONSUMER: `style-outfit-generate`
- EXPECTED_REMOTE_RESULT: atomic JWT-derived quota enforcement
- SAFE_TO_DEPLOY: `YES_IN_ISOLATION`

## 20260711195508

- FILENAME: `20260711195508_restore_service_role_app_table_grants.sql`
- PURPOSE: Restore service-role CRUD, expose owner-RLS Looks, establish room-share redemption contract, and correct decision sharing.
- TABLES_CHANGED: all current public tables, `room_shares`, `looks`, `look_items`
- FUNCTIONS_CHANGED: corrected `share_looks_to_outfit_decision`
- POLICIES_CHANGED: none
- GRANTS_CHANGED: service-role schema/CRUD/default grants; authenticated Looks CRUD
- TRIGGERS_CHANGED: none
- DATA_MUTATION: none in SQL
- DESTRUCTIVE_OPERATION: none
- DEPENDENCIES: the three earlier prerequisites and existing room shares
- EXPECTED_APPLICATION_CONSUMER: Edge Functions, deletion tooling, Looks clients, outfit decisions
- EXPECTED_REMOTE_RESULT: `max_redemptions integer NOT NULL DEFAULT 10` with a 1–100 check, plus required Data API grants
- SAFE_TO_DEPLOY: `NO_AGAINST_CURRENT_REMOTE`

The remote column already exists as nullable with no default or constraint.
`ADD COLUMN IF NOT EXISTS` will not correct those attributes.

## 20260712000001

- FILENAME: `20260712000001_saved_scan_media_backing.sql`
- PURPOSE: Add private remote media metadata for saved scans and optional styling metadata for inspiration items.
- TABLES_CHANGED: `saved_scans`, `inspiration_items`
- FUNCTIONS_CHANGED: none
- POLICIES_CHANGED: none; existing owner RLS remains authoritative
- GRANTS_CHANGED: none
- TRIGGERS_CHANGED: none
- DATA_MUTATION: none; no backfill or upload
- DESTRUCTIVE_OPERATION: none; replacement of a migration-owned check only
- DEPENDENCIES: existing private style-library bucket and owner-scoped storage/table policies
- EXPECTED_APPLICATION_CONSUMER: saved-scan media service, StyleChat and outfit generation
- EXPECTED_REMOTE_RESULT: nullable media/styling columns, ready-path check, partial index
- SAFE_TO_DEPLOY: `YES_IN_ISOLATION`

## 20260712010000

- FILENAME: `20260712010000_audit_hardening_ai_stylist_stylechat.sql`
- PURPOSE: Enforce private-media path authority, immutable inspiration media, decision race safety, and bounded public previews.
- TABLES_CHANGED: saved scans and inspiration items via NOT VALID checks
- FUNCTIONS_CHANGED: inspiration rewrite trigger function, vote RPC, two public preview RPCs
- POLICIES_CHANGED: none
- GRANTS_CHANGED: trigger function execution revoked; bounded previews remain token-callable
- TRIGGERS_CHANGED: inspiration media rewrite prevention
- DATA_MUTATION: none
- DESTRUCTIVE_OPERATION: none; function/trigger/check replacement only
- DEPENDENCIES: the first five prerequisites and existing public preview contracts
- EXPECTED_APPLICATION_CONSUMER: StyleChat media resolution, outfit voting, public room previews
- EXPECTED_REMOTE_RESULT: new writes constrained without rewriting legacy rows; bounded sanitized previews
- SAFE_TO_DEPLOY: `YES_IN_ISOLATION`

## 20260712020000

- FILENAME: `20260712020000_harden_app_role_privileges.sql`
- PURPOSE: Remove structural app-role privileges and add account-lifecycle and share-redemption enforcement.
- TABLES_CHANGED: public-table/default ACLs and `room_shares`
- FUNCTIONS_CHANGED: StyleChat quota RPCs, outfit quota RPCs, room-share join RPC
- POLICIES_CHANGED: none
- GRANTS_CHANGED: revoke TRUNCATE/REFERENCES/TRIGGER/MAINTAIN and sequence access; retain service-role CRUD and authenticated RPC execution
- TRIGGERS_CHANGED: none
- DATA_MUTATION: none during migration; runtime quota cleanup remains bounded to stale burst rows
- DESTRUCTIVE_OPERATION: no schema/data drop
- DEPENDENCIES: all earlier prerequisites, profile lifecycle state, room participants
- EXPECTED_APPLICATION_CONSUMER: StyleChat, outfit generation, room deep links
- EXPECTED_REMOTE_RESULT: least-privilege ACLs and share joins capped by non-null redemption limits
- SAFE_TO_DEPLOY: `NO_AGAINST_CURRENT_REMOTE`

Three existing room-share rows have a null redemption limit. The replacement
join RPC uses `coalesce(target_max_redemptions, 0) <= 0`, so these active
shares would become unavailable rather than inherit the migration's intended
default.

## Chain decision

`PREREQUISITE_MIGRATION_SAFETY_UNRESOLVED — DEPLOYMENT HALTED`

The chain was not partially deployed.
