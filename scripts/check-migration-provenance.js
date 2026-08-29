#!/usr/bin/env node
/**
 * Migration provenance gate (B34-DEF-009).
 *
 * Android and iOS carried the same SQL under two different filenames --
 * '20260716035943_add_purchase_options_to_saved_scans.sql' (Android) and
 * '20260717201524_20260716035943_add_purchase_options_to_saved_scans.sql'
 * (iOS) -- and nothing in the repository recorded that this was the same
 * logical migration, applied once, under one of the two names. This gate:
 *
 *   1. Computes a normalization-tolerant SHA-256 for every committed
 *      migration file (see config/migration-provenance-manifest.json for the
 *      exact normalization rule).
 *   2. Groups files by that hash. A group with more than one filename is a
 *      "duplicate logical migration" and MUST be declared in the manifest as
 *      aliases of the same logicalId, or the gate fails.
 *   3. Every declared logicalId's canonical hash must match what the alias
 *      files actually hash to right now -- if it doesn't, the manifest is
 *      stale/wrong and the gate fails.
 *
 * This NEVER renames, deletes, or reorders a migration file. It only
 * verifies that duplication is explicit and approved.
 *
 * Usage:   node scripts/check-migration-provenance.js
 * Exit 0:  no undeclared duplicate logical migrations, manifest is accurate
 * Exit 1:  undeclared duplicate, or manifest hash mismatch
 * Exit 2:  usage / operational error
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const MANIFEST_PATH = path.join(REPO_ROOT, 'config', 'migration-provenance-manifest.json');

function normalize(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '' && line.trim() !== ';')
    .join('\n');
}

function normalizedHashOf(absolutePath) {
  const content = fs.readFileSync(absolutePath, 'utf8');
  return crypto.createHash('sha256').update(normalize(content)).digest('hex');
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`FAIL  ${path.relative(REPO_ROOT, MANIFEST_PATH)} is missing.`);
    process.exit(2);
  }
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`FAIL  ${path.relative(REPO_ROOT, MIGRATIONS_DIR)} does not exist.`);
    process.exit(2);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const declaredByFilename = new Map();
  const declaredCanonicalByLogicalId = new Map();
  for (const migration of manifest.logicalMigrations) {
    declaredCanonicalByLogicalId.set(migration.logicalId, migration.canonicalNormalizedHash);
    for (const alias of migration.aliases) {
      declaredByFilename.set(alias.filename, migration.logicalId);
    }
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  const byHash = new Map(); // normalizedHash -> [filenames]
  for (const filename of files) {
    const hash = normalizedHashOf(path.join(MIGRATIONS_DIR, filename));
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(filename);
  }

  const failures = [];

  // 1. Any hash shared by more than one file must be a fully declared alias
  //    group pointing at the same logicalId.
  for (const [hash, filenames] of byHash) {
    if (filenames.length < 2) continue;
    const logicalIds = new Set(filenames.map((name) => declaredByFilename.get(name)));
    if (logicalIds.size !== 1 || logicalIds.has(undefined)) {
      const undeclared = filenames.filter((name) => !declaredByFilename.has(name));
      failures.push(
        `Undeclared duplicate logical migration: ${filenames.join(', ')} share normalized hash ` +
          `${hash.slice(0, 16)}… but ${undeclared.length > 0 ? undeclared.join(', ') : 'not all filenames'} ` +
          'are not declared as aliases of the same logicalId in config/migration-provenance-manifest.json.',
      );
      continue;
    }
    const logicalId = [...logicalIds][0];
    const declaredHash = declaredCanonicalByLogicalId.get(logicalId);
    if (declaredHash !== hash) {
      failures.push(
        `Manifest hash mismatch for logicalId "${logicalId}": manifest declares ` +
          `${declaredHash?.slice(0, 16)}…, tree computes ${hash.slice(0, 16)}… for ${filenames.join(', ')}.`,
      );
    }
  }

  // 2. Any declared alias filename PRESENT IN THIS CHECKOUT must still hash to
  //    the declared canonical value (catches a stale/wrong manifest). Aliases
  //    are cross-branch by design -- a single branch is expected to carry only
  //    one of the two filenames, so an absent alias is not itself a failure.
  for (const migration of manifest.logicalMigrations) {
    let presentCount = 0;
    for (const alias of migration.aliases) {
      const absolutePath = path.join(MIGRATIONS_DIR, alias.filename);
      if (!fs.existsSync(absolutePath)) continue;
      presentCount += 1;
      const hash = normalizedHashOf(absolutePath);
      if (hash !== migration.canonicalNormalizedHash) {
        failures.push(
          `Declared alias "${alias.filename}" for logicalId "${migration.logicalId}" now hashes to ` +
            `${hash.slice(0, 16)}… but the manifest declares ${migration.canonicalNormalizedHash.slice(0, 16)}….`,
        );
      }
    }
    if (presentCount === 0) {
      failures.push(
        `No declared alias for logicalId "${migration.logicalId}" exists in this checkout at all ` +
          `(expected at least one of: ${migration.aliases.map((a) => a.filename).join(', ')}).`,
      );
    }
  }

  console.log('MIGRATION PROVENANCE GATE');
  console.log(`  migration files scanned : ${files.length}`);
  console.log(`  logical migrations declared : ${manifest.logicalMigrations.length}`);
  for (const migration of manifest.logicalMigrations) {
    console.log(`    ${migration.logicalId} — ${migration.aliases.length} alias(es)`);
  }

  if (failures.length > 0) {
    console.error('');
    console.error('FAIL  Migration provenance problems:');
    for (const failure of failures) console.error(`    ${failure}`);
    console.error('');
    console.error(`  ${failures.length} problem(s) found. Do NOT rename or delete an applied migration to silence this.`);
    process.exit(1);
  }

  console.log('');
  console.log('PASS  No undeclared duplicate logical migrations. Manifest matches the tree.');
}

main();
