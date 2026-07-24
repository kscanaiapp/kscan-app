// Runtime-neutral ESM registry module. Exports the same authoritative
// account-deletion resource registry as lib/account-deletion/loadRegistry.cjs
// (both read lib/account-deletion/user-data-resources.json, so there is no
// drift possible between the CJS and ESM Node-side consumers).
//
// The Deno edge-function worker keeps its own mirrored copy at
// supabase/functions/_shared/deletion/userDataResources.ts because Supabase
// Edge Function bundling cannot reliably reach outside the function's own
// directory at deploy time. __tests__/deletionRegistryParity.test.js compares
// that mirror against this JSON-backed registry so CI fails on drift.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REGISTRY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'user-data-resources.json');

const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));

export const USER_DATA_RESOURCES = raw.tables;

export const SHARED_ROOM_TRANSFER_POLICY = raw.sharedRoomTransferPolicy;

export const REQUIRED_REGISTRY_TABLES = raw.requiredRegistryTables;

export const STORAGE_RESOURCES = raw.storage.map((resource) => ({
  bucket: resource.bucket,
  prefixesForUser(userId) {
    return resource.prefixTemplates.map((template) => template.replace('{userId}', userId));
  },
}));
