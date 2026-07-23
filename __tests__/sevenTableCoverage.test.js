const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRegistry } = require('../lib/account-deletion/loadRegistry.cjs');

// The seven production-confirmed, cascade-safe-but-previously-unmonitored
// tables that must be present in the account-deletion registry (see the
// audit gap report). Each is optional (skipped cleanly if the migration is
// not deployed to a given project) and cascades on auth delete.
const EXPECTED_TABLES = {
  user_stylist_preferences: 'user_id',
  dressing_room_collab_idempotency: 'actor_id',
  shared_room_memberships: 'recipient_user_id',
  outfit_decision_votes: 'user_id',
  stylechat_quota_events: 'user_id',
  style_outfit_burst_usage: 'user_id',
  style_outfit_daily_usage: 'user_id',
};

test('REQUIRED_REGISTRY_TABLES lists exactly the seven gap tables', () => {
  const { REQUIRED_REGISTRY_TABLES } = loadRegistry();
  assert.deepEqual([...REQUIRED_REGISTRY_TABLES].sort(), Object.keys(EXPECTED_TABLES).sort());
});

test('USER_DATA_RESOURCES includes all seven production-confirmed gap tables', () => {
  const { USER_DATA_RESOURCES } = loadRegistry();

  for (const [table, column] of Object.entries(EXPECTED_TABLES)) {
    const resource = USER_DATA_RESOURCES.find((entry) => entry.table === table);
    assert.ok(resource, `${table} is missing from USER_DATA_RESOURCES`);
    assert.equal(resource.column, column, `${table} should be keyed on ${column}`);
    assert.equal(resource.action, 'auth_delete_cascade', `${table} should cascade on auth delete`);
    assert.equal(resource.optional, true, `${table} should be marked optional`);
  }
});

test('deletion_requests survives the auth cascade instead of being deleted with it', () => {
  const { USER_DATA_RESOURCES } = loadRegistry();
  const resource = USER_DATA_RESOURCES.find((entry) => entry.table === 'deletion_requests');
  assert.ok(resource, 'deletion_requests must remain in the registry');
  assert.equal(resource.column, 'user_id');
  assert.equal(
    resource.action,
    'survive_auth_delete',
    'deletion_requests FK is ON DELETE SET NULL, not CASCADE, so it must not be marked auth_delete_cascade',
  );
});

test('lib/account-deletion ESM modules expose the same seven tables (Node-side parity)', async () => {
  const esm = await import('../lib/account-deletion/userDataResources.mjs');
  assert.deepEqual([...esm.REQUIRED_REGISTRY_TABLES].sort(), Object.keys(EXPECTED_TABLES).sort());
  for (const table of Object.keys(EXPECTED_TABLES)) {
    assert.ok(esm.USER_DATA_RESOURCES.some((entry) => entry.table === table));
  }
});
