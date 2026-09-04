#!/usr/bin/env node
'use strict';

/**
 * Real product fixture authorization gate.
 *
 * The owner's authorization carries its own scope clause — "Authorization
 * applies only to the exact files listed in this document" — and lists
 * "adding unrelated retailer/catalog images not listed above" as explicitly
 * NOT permitted. This tool turns that clause into a mechanical check so the
 * limit holds without depending on anyone remembering it.
 *
 * It answers two separate questions and never conflates them:
 *
 *   1. Is this asset AUTHORIZED?  — is its exact filename in
 *      fixtures/products/authorized-assets.json
 *   2. Is this asset PRESENT?     — do the bytes actually exist on disk
 *
 * An authorized-but-absent asset is not an error; it is the normal state
 * between an authorization being issued and the files being delivered.
 * A present-but-unauthorized asset IS an error, and is the case this gate
 * exists to catch.
 *
 * Usage:
 *   node tools/validate-authorized-assets.js            # report status
 *   node tools/validate-authorized-assets.js --strict   # exit 1 unless all
 *                                                       # authorized assets
 *                                                       # are present
 */

const fs = require('node:fs');
const path = require('node:path');

const PRODUCTS_DIR = path.resolve(__dirname, '..', 'fixtures', 'products');
const MANIFEST_PATH = path.join(PRODUCTS_DIR, 'authorized-assets.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

/** Exact-filename match. Deliberately not a prefix or glob: the authorization
 *  is per-file, so the check must be per-file too. */
function isAuthorized(filename) {
  return manifest.assets.some((a) => a.file === filename);
}

/** Image files actually sitting in fixtures/products/, manifest excluded. */
function presentImageFiles() {
  if (!fs.existsSync(PRODUCTS_DIR)) return [];
  return fs
    .readdirSync(PRODUCTS_DIR)
    .filter((f) => /\.(jpe?g|png|tiff?|webp)$/i.test(f))
    .sort();
}

function classify() {
  const present = presentImageFiles();
  const authorizedFiles = manifest.assets.map((a) => a.file);

  return {
    authorizedAndPresent: authorizedFiles.filter((f) => present.includes(f)),
    authorizedAndAbsent: authorizedFiles.filter((f) => !present.includes(f)),
    presentButUnauthorized: present.filter((f) => !isAuthorized(f)),
  };
}

function main() {
  const strict = process.argv.includes('--strict');
  const { authorizedAndPresent, authorizedAndAbsent, presentButUnauthorized } = classify();

  console.log(`[authorized-assets] authorization: ${manifest.authorization.authorizedBy}, ${manifest.authorization.date}`);
  console.log(`[authorized-assets] authorized files: ${manifest.assets.length}`);
  console.log(`[authorized-assets] present: ${authorizedAndPresent.length}/${manifest.assets.length}`);

  if (authorizedAndAbsent.length > 0) {
    console.log('\n[authorized-assets] authorized but NOT YET DELIVERED:');
    for (const f of authorizedAndAbsent) console.log(`  - ${f}`);
  }

  if (presentButUnauthorized.length > 0) {
    console.error('\n[authorized-assets] FAIL — files present that the authorization does not cover:\n');
    for (const f of presentButUnauthorized) console.error(`  - ${f}`);
    console.error(
      '\nThe owner authorization states: "' + manifest.authorization.scopeClause + '"\n' +
      'Remove these files, or obtain an explicit owner authorization naming them and add\n' +
      'them to fixtures/products/authorized-assets.json in that same change.',
    );
    process.exit(1);
  }

  if (strict && authorizedAndAbsent.length > 0) {
    console.error('\n[authorized-assets] --strict: not every authorized asset is present.');
    process.exit(1);
  }

  console.log('\n[authorized-assets] PASS — nothing present outside the authorization.');
}

if (require.main === module) {
  main();
}

module.exports = { isAuthorized, classify, presentImageFiles, manifest };
