/**
 * B33-CON-001 — see supabase/migrations/20260916235651_dressing_room_items_dedupe_key_idempotency.sql
 * for the full analysis. Summary: the governed dedupe mechanism
 * (services/dressingRoomDedupe.ts, DRESSING_ROOM_DEDUPE_V1) is check-before-
 * insert from the client, which is not atomic — two identical requests can
 * both pass the check before either insert lands, producing two rows. A
 * partial unique index on the governed dedupe key closes that race. It is
 * partial specifically so it is inert for the currently shipped client
 * (flag off, no row ever carries a dedupeKey) and only becomes load-bearing
 * once a future build enables the flag.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const MIGRATION = 'supabase/migrations/20260916235651_dressing_room_items_dedupe_key_idempotency.sql';

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('B33-CON-001: the index targets the governed dedupe key path, not a competing identity notion', () => {
  const migration = read(MIGRATION);
  assert.match(
    migration,
    /on public\.dressing_room_items \(\(\(snapshot_payload -> 'canonical'\) ->> 'dedupeKey'\)\)/,
    'must index the same path services/dressingRoomDedupe.ts writes to (canonical.dedupeKey)',
  );
});

test('B33-CON-001: the index is partial (NULL-excluded), so it cannot fire for the current shipped client', () => {
  const migration = read(MIGRATION);
  assert.match(
    migration,
    /where \(snapshot_payload -> 'canonical'\) ->> 'dedupeKey' is not null;/,
    'a bare (non-partial) unique index would apply to every row and risk surfacing 23505 for traffic that predates this fix',
  );
});

test('B33-CON-001: the dedupe key this index enforces is the one the governed compute function writes', () => {
  const dedupe = read('services/dressingRoomDedupe.ts');
  const contract = read('services/dressingRoomItemContract.ts');
  assert.match(dedupe, /export function computeDressingRoomDedupeKey/);
  assert.match(contract, /extension\.dedupeKey = dedupe\.key;/);
  assert.match(
    contract,
    /if \(input\.includeDedupe\) \{/,
    'dedupeKey must remain conditional on the flag, not written unconditionally',
  );
});

test('B33-CON-001: the feature flag itself is untouched by this backend change', () => {
  const flags = read('constants/featureFlags.ts');
  assert.match(
    flags,
    /export const DRESSING_ROOM_DEDUPE_V1 =\s*\n\s*process\.env\.EXPO_PUBLIC_DRESSING_ROOM_DEDUPE_V1 === 'true';/,
    'flipping the flag is a client release decision, not this migration\'s to make',
  );
});
