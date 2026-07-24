'use strict';

// CommonJS loader for the single authoritative account-deletion resource
// registry (lib/account-deletion/user-data-resources.json). This is the
// synchronous entry point used by scripts/process-deletion-request.js and by
// the Node test suite (both are CJS and need the registry data available the
// instant require() returns).
//
// lib/account-deletion/userDataResources.mjs loads the exact same JSON file
// for ESM/runtime-neutral consumers, so there is exactly one authoritative
// data source on the Node side. The Deno edge-function worker
// (supabase/functions/_shared/deletion/userDataResources.ts) cannot reach
// outside its own function bundle at deploy time, so it keeps a mirrored
// copy; __tests__/deletionRegistryParity.test.js fails CI if that mirror
// drifts from this JSON file.

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, 'user-data-resources.json');

let cachedRaw = null;

function readRawRegistry() {
  if (!cachedRaw) {
    const contents = fs.readFileSync(REGISTRY_PATH, 'utf8');
    cachedRaw = JSON.parse(contents);
  }
  return cachedRaw;
}

function buildStorageResources(raw) {
  return raw.storage.map((resource) => ({
    bucket: resource.bucket,
    prefixesForUser(userId) {
      return resource.prefixTemplates.map((template) => template.replace('{userId}', userId));
    },
  }));
}

function loadRegistry() {
  const raw = readRawRegistry();
  return {
    USER_DATA_RESOURCES: raw.tables,
    STORAGE_RESOURCES: buildStorageResources(raw),
    SHARED_ROOM_TRANSFER_POLICY: raw.sharedRoomTransferPolicy,
    REQUIRED_REGISTRY_TABLES: raw.requiredRegistryTables,
  };
}

module.exports = { loadRegistry, REGISTRY_PATH };
