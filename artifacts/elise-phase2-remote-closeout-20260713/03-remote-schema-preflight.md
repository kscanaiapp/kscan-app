# Remote schema preflight

Remote PostgreSQL version: `17.6`.

## Clean/absent effects

- All additive Looks/look-items columns and owned-item RPCs are absent.
- All four outfit-decision tables and their RPCs are absent.
- Both style-outfit usage tables and their RPCs are absent.
- Saved-scan media and inspiration styling columns are absent.
- Media authority constraints and rewrite trigger are absent.
- `public.user_stylist_preferences` is absent.
- No later or newly discovered remote-only migration exists.

## Dirty/conflicting effect

`public.room_shares.max_redemptions` is partially present outside the recorded
migration chain:

- type: integer
- nullable: YES
- default: none
- range constraint: absent
- total rows: 10
- rows with null limit: 3
- non-null observed range: 2–10
- out-of-range non-null rows: 0

No applied ledger statement through `20260709130346` adds this column. The
recorded `20260708140542` migration only replaces
`create_or_get_room_share`; it assumes the column already exists.

Both `20260711195508` and `20260712020000` use:

`ADD COLUMN IF NOT EXISTS max_redemptions integer NOT NULL DEFAULT 10`

PostgreSQL does not alter an existing column's nullability or default when that
clause takes the IF-NOT-EXISTS branch. Normal deployment therefore cannot
produce the migration's declared column contract.

Required result:

`REMOTE_SCHEMA_DIRTY — DEPLOYMENT HALTED`
