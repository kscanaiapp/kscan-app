#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Live staging inventory builder — fail closed (DEF-REL-018/K).
 *
 * The workflow previously did:
 *
 *     supabase migration list ... || echo '[]'
 *
 * which converts a CLI failure, an auth failure, a network failure or an output
 * format regression into "zero migrations". That is not truthful evidence: the
 * bootstrap planner would then compare the candidate against an empty live
 * state and could reach a conclusion nobody measured.
 *
 * Every failure mode here is an explicit ACTIVATION_INVENTORY_OPERATIONAL_FAILURE.
 * An empty list is only accepted where it is semantically possible — never for
 * functions, since a bootstrap with no live functions cannot be a bootstrap.
 *
 * Node built-ins only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class InventoryError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'InventoryError';
    this.code = 'ACTIVATION_INVENTORY_OPERATIONAL_FAILURE';
    if (detail !== undefined) this.detail = detail;
  }
}

function parseJsonFile(file, label) {
  if (!fs.existsSync(file)) {
    throw new InventoryError(`${label} output file is missing: ${file}`);
  }
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw.length === 0) {
    throw new InventoryError(`${label} output is empty; the CLI produced nothing`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new InventoryError(`${label} output is not valid JSON: ${error.message}`);
  }
}

/**
 * Extracts function slugs. Tolerates the pinned CLI's shapes (`slug` or
 * `name`) but refuses anything it does not recognize rather than silently
 * yielding an empty list.
 */
export function extractFunctions(parsed) {
  if (!Array.isArray(parsed)) {
    throw new InventoryError(`function inventory must be a JSON array, got ${typeof parsed}`);
  }
  const names = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new InventoryError(`function inventory entry ${index} is not an object`);
    }
    const name = entry.slug || entry.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new InventoryError(`function inventory entry ${index} has no slug/name`);
    }
    return name;
  });
  if (names.length === 0) {
    throw new InventoryError('live function inventory is empty; a bootstrap requires already-live functions');
  }
  return [...new Set(names)].sort();
}

/**
 * Extracts applied migration names. An empty list is structurally valid here
 * (a project can genuinely have none), so it is accepted — but a shape the
 * parser does not recognize is not.
 *
 * DEF-REL-019: the pinned CLI's real `migration list --linked --output-format
 * json` shape is `{ migrations: [{ local, remote, time }, ...], message }` —
 * not a bare array of `{ name }` objects, which was never verified against
 * the actual CLI. `remote` is the version applied to the live database (what
 * "live staging inventory" means here); `local` is only what the checked-out
 * candidate's migration files contain, which is not this function's concern.
 * A migration present locally but not yet applied (`remote === ''`) is
 * correctly absent from the live inventory, not an error.
 */
export function extractMigrations(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InventoryError(`migration inventory must be a JSON object with a migrations array, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }
  if (!Array.isArray(parsed.migrations)) {
    throw new InventoryError('migration inventory is missing a migrations array');
  }
  return parsed.migrations
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object' || typeof entry.remote !== 'string') {
        throw new InventoryError(`migration inventory entry ${index} has no remote field`);
      }
      return entry.remote;
    })
    .filter((remote) => remote.length > 0);
}

/** Builds the inventory, optionally comparing against an earlier snapshot. */
export function buildInventory({ functionsJson, migrationsJson, previous = null }) {
  const inventory = {
    functions: extractFunctions(functionsJson),
    migrations: extractMigrations(migrationsJson),
    collectedAt: new Date().toISOString(),
  };

  if (previous) {
    const prevFns = [...(previous.functions || [])].sort();
    const addedFns = inventory.functions.filter((f) => !prevFns.includes(f));
    const removedFns = prevFns.filter((f) => !inventory.functions.includes(f));
    const prevMigs = new Set(previous.migrations || []);
    const addedMigs = inventory.migrations.filter((m) => !prevMigs.has(m));
    const removedMigs = [...prevMigs].filter((m) => !inventory.migrations.includes(m));

    inventory.comparison = { addedFns, removedFns, addedMigs, removedMigs };
    inventory.changed = addedFns.length + removedFns.length + addedMigs.length + removedMigs.length > 0;
  }

  return inventory;
}

export default { InventoryError, extractFunctions, extractMigrations, buildInventory };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv;
  const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const functionsPath = arg('--functions');
  const migrationsPath = arg('--migrations');
  const outPath = arg('--out');
  const comparePath = arg('--compare');

  try {
    if (!functionsPath || !migrationsPath || !outPath) {
      throw new InventoryError('--functions, --migrations and --out are required');
    }
    const inventory = buildInventory({
      functionsJson: parseJsonFile(functionsPath, 'supabase functions list'),
      migrationsJson: parseJsonFile(migrationsPath, 'supabase migration list'),
      previous: comparePath && fs.existsSync(comparePath) ? JSON.parse(fs.readFileSync(comparePath, 'utf8')) : null,
    });

    fs.writeFileSync(outPath, `${JSON.stringify(inventory, null, 2)}\n`);
    console.log(`live functions: ${inventory.functions.length}, live migrations: ${inventory.migrations.length}`);

    if (inventory.changed) {
      // The plan was computed against different live state. Re-planning happens
      // downstream; surfacing it here stops a silent drift.
      console.error('LIVE_INVENTORY_CHANGED since preflight:');
      console.error(JSON.stringify(inventory.comparison, null, 2));
      console.error('Refusing to proceed on stale planning evidence.');
      process.exit(1);
    }
    process.exit(0);
  } catch (error) {
    console.error(`${error.code || 'ACTIVATION_INVENTORY_OPERATIONAL_FAILURE'}: ${error.message}`);
    process.exit(2);
  }
}
