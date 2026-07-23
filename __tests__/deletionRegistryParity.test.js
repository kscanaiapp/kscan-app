const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadRegistry } = require('../lib/account-deletion/loadRegistry.cjs');

// Guards against the CLI and the Deno edge-function worker drifting apart on
// which tables/columns/actions make up the user-data registry. The single
// authoritative source is lib/account-deletion/user-data-resources.json
// (loaded here via loadRegistry.cjs). The worker keeps its own mirrored copy
// at supabase/functions/_shared/deletion/userDataResources.ts because
// Supabase Edge Function bundling cannot reach outside its own function
// directory at deploy time. If this test fails, update the worker file to
// match the JSON registry (or vice versa, if the worker was updated first).

const WORKER_REGISTRY_PATH = path.join(
  __dirname,
  '..',
  'supabase',
  'functions',
  '_shared',
  'deletion',
  'userDataResources.ts',
);

function extractArrayLiteral(source, exportName) {
  const marker = `export const ${exportName}`;
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) {
    throw new Error(`Could not find "${marker}" in ${WORKER_REGISTRY_PATH}`);
  }
  // Skip past any TS type annotation (e.g. ": UserDataResource[]") between
  // the export name and the "=" sign by searching for "[" only after "=".
  const eqIdx = source.indexOf('=', startIdx);
  if (eqIdx === -1) {
    throw new Error(`Could not find "=" for ${exportName}`);
  }
  const openBracket = source.indexOf('[', eqIdx);
  if (openBracket === -1) {
    throw new Error(`Could not find opening bracket for ${exportName}`);
  }

  let depth = 0;
  let endIdx = -1;
  for (let i = openBracket; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    throw new Error(`Could not find closing bracket for ${exportName}`);
  }

  const literal = source.slice(openBracket, endIdx + 1);
  // The array literal itself is plain JS object-literal syntax (no TS type
  // annotations inside it), so it is safe to evaluate directly.
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; return (${literal});`)();
}

function normalizeResources(list) {
  return list
    .map((entry) => ({
      table: entry.table,
      column: entry.column ?? null,
      action: entry.action,
      optional: Boolean(entry.optional),
      count: entry.count === false ? false : true,
    }))
    .sort((a, b) => `${a.table}:${a.column}`.localeCompare(`${b.table}:${b.column}`));
}

test('worker (Deno edge function) user-data registry matches the CLI/lib JSON registry', () => {
  const { USER_DATA_RESOURCES } = loadRegistry();
  const workerSource = fs.readFileSync(WORKER_REGISTRY_PATH, 'utf8');
  const workerResources = extractArrayLiteral(workerSource, 'USER_DATA_RESOURCES');

  assert.deepEqual(
    normalizeResources(workerResources),
    normalizeResources(USER_DATA_RESOURCES),
    'supabase/functions/_shared/deletion/userDataResources.ts must list exactly the same tables/columns/actions as lib/account-deletion/user-data-resources.json',
  );
});

test('worker required-table list matches the CLI/lib JSON registry', () => {
  const { REQUIRED_REGISTRY_TABLES } = loadRegistry();
  const workerSource = fs.readFileSync(WORKER_REGISTRY_PATH, 'utf8');
  const workerRequired = extractArrayLiteral(workerSource, 'REQUIRED_REGISTRY_TABLES');

  assert.deepEqual([...workerRequired].sort(), [...REQUIRED_REGISTRY_TABLES].sort());
});

test('worker storage resource templates match the CLI/lib JSON registry', () => {
  const { loadRegistry: reload } = require('../lib/account-deletion/loadRegistry.cjs');
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'account-deletion', 'user-data-resources.json'), 'utf8'),
  );
  const workerSource = fs.readFileSync(WORKER_REGISTRY_PATH, 'utf8');
  const workerStorage = extractArrayLiteral(workerSource, 'STORAGE_RESOURCE_TEMPLATES');

  assert.deepEqual(workerStorage, raw.storage);
  assert.ok(reload().STORAGE_RESOURCES.length === raw.storage.length);
});

test('ESM userDataResources.mjs also matches the JSON registry (Node-side parity)', async () => {
  const esm = await import('../lib/account-deletion/userDataResources.mjs');
  const { USER_DATA_RESOURCES, REQUIRED_REGISTRY_TABLES, SHARED_ROOM_TRANSFER_POLICY } = loadRegistry();

  assert.deepEqual(normalizeResources(esm.USER_DATA_RESOURCES), normalizeResources(USER_DATA_RESOURCES));
  assert.deepEqual([...esm.REQUIRED_REGISTRY_TABLES].sort(), [...REQUIRED_REGISTRY_TABLES].sort());
  assert.equal(esm.SHARED_ROOM_TRANSFER_POLICY, SHARED_ROOM_TRANSFER_POLICY);
});
