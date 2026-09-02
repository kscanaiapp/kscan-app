// Deletion registry parity — Node/manual side vs. Deno/Edge Function mirror.
//
// WHY THIS FILE EXISTS. lib/account-deletion/userDataResources.mjs,
// supabase/functions/_shared/deletion/userDataResources.ts, and
// lib/account-deletion/loadRegistry.cjs all carry a comment promising this
// file exists and "fails CI if the two drift apart" — it never did. That gap
// let the two registries silently drift: the Edge Function mirror was
// missing `elise_generation_operations` and `image_scan_verdicts`, both
// already present in the Node/JSON-backed registry, with nothing to catch it.
//
// Edge Function bundling cannot reliably reach outside its own function
// directory at deploy time (documented in both files), so the mirror is a
// deliberate, necessary duplication — not a mistake to "fix" by importing
// across the boundary. This file is the drift guard that duplication needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

let nodeRegistry;
let edgeRegistry;

test.before(async () => {
  nodeRegistry = await import('../lib/account-deletion/userDataResources.mjs');
  edgeRegistry = loadTsModule('supabase/functions/_shared/deletion/userDataResources.ts');
});

// Only the fields the pipeline and worker actually branch on. `notes` is
// documentation and is allowed to read differently (or be absent) on either
// side without being drift.
function toComparableResource(resource) {
  return {
    table: resource.table,
    column: resource.column,
    action: resource.action,
    optional: resource.optional === true,
    count: resource.count === false ? false : true,
  };
}

function sortedComparable(resources) {
  return resources
    .map(toComparableResource)
    // Two rows can share a table (content_reports, dressing_room_user_blocks
    // both have two user-linkage columns), so sort by table+column together.
    .sort((a, b) => `${a.table}:${a.column}`.localeCompare(`${b.table}:${b.column}`));
}

test('PARITY: USER_DATA_RESOURCES — every table/column/action/optional entry matches exactly', () => {
  // JSON-string comparison rather than assert.deepEqual: edgeRegistry's
  // objects were constructed inside a vm sandbox (a different JS realm), and
  // Node's deepEqual can report cross-realm plain objects as unequal even
  // with identical own-enumerable-property structure. JSON.stringify only
  // looks at own enumerable string-keyed values, so it is realm-independent.
  const nodeSide = JSON.stringify(sortedComparable(nodeRegistry.USER_DATA_RESOURCES));
  const edgeSide = JSON.stringify(sortedComparable(edgeRegistry.USER_DATA_RESOURCES));
  assert.equal(
    edgeSide,
    nodeSide,
    'the Edge Function mirror must list exactly the same resources as the Node/JSON-backed registry',
  );
});

test('PARITY: no table is silently missing from either side', () => {
  const nodeTables = new Set(nodeRegistry.USER_DATA_RESOURCES.map((r) => `${r.table}:${r.column}`));
  const edgeTables = new Set(edgeRegistry.USER_DATA_RESOURCES.map((r) => `${r.table}:${r.column}`));

  const missingFromEdge = [...nodeTables].filter((t) => !edgeTables.has(t));
  const missingFromNode = [...edgeTables].filter((t) => !nodeTables.has(t));

  assert.deepEqual(missingFromEdge, [], 'these resources exist in the Node registry but not the Edge mirror');
  assert.deepEqual(missingFromNode, [], 'these resources exist in the Edge mirror but not the Node registry');
});

test('PARITY: SHARED_ROOM_TRANSFER_POLICY matches', () => {
  assert.equal(edgeRegistry.SHARED_ROOM_TRANSFER_POLICY, nodeRegistry.SHARED_ROOM_TRANSFER_POLICY);
});

test('PARITY: REQUIRED_REGISTRY_TABLES matches', () => {
  assert.deepEqual(
    [...edgeRegistry.REQUIRED_REGISTRY_TABLES].sort(),
    [...nodeRegistry.REQUIRED_REGISTRY_TABLES].sort(),
  );
});

test('PARITY: STORAGE_RESOURCES buckets and per-user prefixes match', () => {
  const userId = '12345678-90ab-cdef-1234-567890abcdef';
  const nodePrefixes = nodeRegistry.STORAGE_RESOURCES.map((r) => ({
    bucket: r.bucket,
    prefixes: [...r.prefixesForUser(userId)].sort(),
  })).sort((a, b) => a.bucket.localeCompare(b.bucket));
  const edgePrefixes = edgeRegistry.STORAGE_RESOURCES.map((r) => ({
    bucket: r.bucket,
    prefixes: [...r.prefixesForUser(userId)].sort(),
  })).sort((a, b) => a.bucket.localeCompare(b.bucket));
  // JSON-string comparison — see the note on the USER_DATA_RESOURCES parity
  // test above (cross-realm vm sandbox objects vs. Node's deepEqual).
  assert.equal(JSON.stringify(edgePrefixes), JSON.stringify(nodePrefixes));
});

// ── Newly registered resources (Build 35 Patch 2 / P2-02) are present on BOTH sides ──

const NEWLY_REGISTERED = [
  { table: 'dressing_room_user_blocks', column: 'blocker_user_id' },
  { table: 'dressing_room_user_blocks', column: 'blocked_user_id' },
  { table: 'wardrobe_wear_event_items', column: 'user_id' },
  { table: 'vto_generation_requests', column: 'user_id' },
  { table: 'apple_auth_credentials', column: 'user_id' },
  { table: 'provider_request_reservations', column: 'user_id' },
  { table: 'provider_security_events', column: 'user_id' },
  // Pre-existing in the Node registry, but missing from the Edge mirror
  // before this patch — the parity gap this file exists to catch.
  { table: 'elise_generation_operations', column: 'user_id' },
  { table: 'image_scan_verdicts', column: 'user_id' },
];

for (const { table, column } of NEWLY_REGISTERED) {
  test(`P2-02: ${table}.${column} is registered on both the Node and Edge sides, as auth_delete_cascade`, () => {
    for (const [label, registry] of [
      ['node', nodeRegistry],
      ['edge', edgeRegistry],
    ]) {
      const resource = registry.USER_DATA_RESOURCES.find((r) => r.table === table && r.column === column);
      assert.ok(resource, `${table}.${column} missing from the ${label} registry`);
      assert.equal(resource.action, 'auth_delete_cascade');
      assert.equal(resource.optional, true);
    }
  });
}

// ── Deliberately-excluded audit candidates stay excluded, with a documented reason ──

test('P2-02: wearable_* tables remain deliberately unregistered (differently-governed shared schema)', () => {
  const wearableTables = [
    'wearable_pairings',
    'wearable_sessions',
    'wearable_messages',
    'wearable_results',
    'wearable_actions',
    'wearable_auth_attempts',
  ];
  for (const table of wearableTables) {
    assert.ok(
      !nodeRegistry.USER_DATA_RESOURCES.some((r) => r.table === table),
      `${table} must not be added to the Node registry: it is owned by a different repository ` +
        '(kscan-glasses-webapp), and its auth.users FK cascade already deletes it regardless of this registry',
    );
    assert.ok(
      !edgeRegistry.USER_DATA_RESOURCES.some((r) => r.table === table),
      `${table} must not be added to the Edge registry either`,
    );
  }

  // The ownership disclaimer this exclusion rests on must still be present in
  // the migration itself, so a future change to that file surfaces here too.
  const fs2 = require('node:fs');
  const migration = fs2.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260819125404_wearable_pairings_sessions.sql'),
    'utf8',
  );
  assert.match(migration, /does NOT transfer product[\s\S]{0,20}ownership/);
  assert.match(migration, /logical_owner:\s+kscan-glasses-webapp/);
});

test('P2-02: provider_request_limits stays unregistered (not user-linked)', () => {
  // Config table keyed by function_name, not user_id — correctly out of scope
  // for a per-user deletion registry.
  assert.ok(!nodeRegistry.USER_DATA_RESOURCES.some((r) => r.table === 'provider_request_limits'));
  assert.ok(!edgeRegistry.USER_DATA_RESOURCES.some((r) => r.table === 'provider_request_limits'));
});
