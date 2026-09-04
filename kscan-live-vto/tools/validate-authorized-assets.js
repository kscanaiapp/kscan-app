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
 * It answers three separate questions and never conflates them:
 *
 *   1. Is this asset AUTHORIZED?    — is its exact filename in
 *      fixtures/real-products/authorized-assets.json's asset list
 *   2. Is this asset PRESENT?       — do the bytes actually exist on disk
 *   3. Is this asset the RIGHT FORMAT? — does its extension match
 *      FORMAT_POLICY.acceptedExtensions (currently PNG only)
 *
 * An authorized-but-absent asset is not an error; it is the normal state
 * between an authorization being issued and the files being delivered.
 * A present-but-unauthorized asset IS an error. An authorized-and-present
 * asset in the wrong format is ALSO not ready — see FORMAT_POLICY below —
 * and is reported as its own category rather than folded into "ready".
 *
 * FILENAME EXTENSIONS ARE NEVER TRANSLATED. If the authorization names
 * "tee-flatlay-001.jpg", that authorizes exactly that filename — not
 * "tee-flatlay-001.png". A same-stem, different-extension file is reported
 * as a likely-related NEAR MISS purely to help a human notice it, and it
 * still fails the gate: only the owner supplying the exact new filename (and
 * that filename being added to authorized-assets.json in the same change)
 * turns it into an authorized asset. This tool does not perform that
 * inference itself.
 *
 * Usage:
 *   node tools/validate-authorized-assets.js            # report status
 *   node tools/validate-authorized-assets.js --strict   # exit 1 unless all
 *                                                       # authorized assets
 *                                                       # are present AND
 *                                                       # in the accepted
 *                                                       # format
 */

const fs = require('node:fs');
const path = require('node:path');

const REAL_PRODUCTS_DIR = path.resolve(__dirname, '..', 'fixtures', 'real-products');
const MANIFEST_PATH = path.join(REAL_PRODUCTS_DIR, 'authorized-assets.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

/**
 * Phase 1 format policy. PNG only — the pure-Node codec in
 * packages/static-renderer already decodes it, so accepting PNG adds zero
 * new capability and zero new dependency. Anything else, this gate refuses
 * to call "ready" even if it happens to be authorized-and-present, because
 * nothing downstream can decode it and nothing here is permitted to try:
 * no JPEG decoder, no TIFF support, no image-decoding dependency, no
 * automatic format conversion. A future change to accepted formats is a
 * separate, deliberate architecture decision — not a side effect of a
 * fixture delivery.
 */
const FORMAT_POLICY = Object.freeze({
  acceptedExtensions: ['.png'],
  forbidden: Object.freeze([
    'implementing a JPEG (or any other) decoder in this workspace',
    'adding an image-decoding dependency',
    'weakening the zero-external-dependency boundary (tests/privacy/dependencyBoundary.test.js)',
    'adding TIFF support',
    'automatically converting files from an external source',
  ]),
});

const IMAGE_EXTENSION_PATTERN = /\.(jpe?g|png|tiff?|webp)$/i;

function extOf(filename) {
  return path.extname(filename).toLowerCase();
}

function stemOf(filename) {
  return filename.slice(0, filename.length - extOf(filename).length);
}

function isAcceptedFormat(filename) {
  return FORMAT_POLICY.acceptedExtensions.includes(extOf(filename));
}

/** Exact-filename match. Deliberately not a prefix, glob, or extension-
 *  insensitive match: the authorization is per-file, so the check must be
 *  per-file too. */
function isAuthorized(filename) {
  return manifest.assets.some((a) => a.file === filename);
}

/** Image files actually sitting in fixtures/real-products/, manifest excluded. */
function presentImageFiles() {
  if (!fs.existsSync(REAL_PRODUCTS_DIR)) return [];
  return fs
    .readdirSync(REAL_PRODUCTS_DIR)
    .filter((f) => IMAGE_EXTENSION_PATTERN.test(f))
    .sort();
}

function classify() {
  const present = presentImageFiles();
  const authorizedFiles = manifest.assets.map((a) => a.file);

  const authorizedAndPresent = authorizedFiles.filter((f) => present.includes(f));
  const authorizedAndAbsent = authorizedFiles.filter((f) => !present.includes(f));
  const presentButUnauthorized = present.filter((f) => !isAuthorized(f));

  // Of the authorized-and-present files, split by whether the format policy
  // actually allows processing them.
  const readyForPipeline = authorizedAndPresent.filter((f) => isAcceptedFormat(f));
  const authorizedPresentWrongFormat = authorizedAndPresent.filter((f) => !isAcceptedFormat(f));

  // Helper diagnostics only — never authorization decisions. A present,
  // unauthorized file whose stem matches an authorized asset's stem is
  // flagged as a likely delivery-under-the-wrong-name, purely so a human
  // notices and asks the owner for the exact filename. It still counts as
  // presentButUnauthorized above and still fails the gate.
  const authorizedStems = new Set(authorizedFiles.map(stemOf));
  const likelyNearMisses = presentButUnauthorized.filter((f) => authorizedStems.has(stemOf(f)));

  return {
    authorizedAndPresent,
    authorizedAndAbsent,
    presentButUnauthorized,
    readyForPipeline,
    authorizedPresentWrongFormat,
    likelyNearMisses,
  };
}

function main() {
  const strict = process.argv.includes('--strict');
  const {
    authorizedAndAbsent,
    presentButUnauthorized,
    readyForPipeline,
    authorizedPresentWrongFormat,
    likelyNearMisses,
  } = classify();

  console.log(`[authorized-assets] authorization: ${manifest.authorization.authorizedBy}, ${manifest.authorization.date}`);
  console.log(`[authorized-assets] format policy: ${FORMAT_POLICY.acceptedExtensions.join(', ')} only`);
  console.log(`[authorized-assets] authorized files: ${manifest.assets.length}`);
  console.log(`[authorized-assets] ready for pipeline (authorized + present + accepted format): ${readyForPipeline.length}/${manifest.assets.length}`);

  if (authorizedAndAbsent.length > 0) {
    console.log('\n[authorized-assets] authorized but NOT YET DELIVERED:');
    for (const f of authorizedAndAbsent) console.log(`  - ${f}`);
  }

  if (authorizedPresentWrongFormat.length > 0) {
    console.log('\n[authorized-assets] authorized and present, but WRONG FORMAT (not processed):');
    for (const f of authorizedPresentWrongFormat) {
      console.log(`  - ${f}  (accepted: ${FORMAT_POLICY.acceptedExtensions.join(', ')})`);
    }
    console.log(
      '  This tool will not convert these and nothing downstream will decode them.\n' +
      '  The owner must supply the exact authorized filename in an accepted format\n' +
      '  (added to authorized-assets.json in the same change) — the existing .jpg\n' +
      '  name is not treated as authorizing a same-named .png, or vice versa.',
    );
  }

  if (presentButUnauthorized.length > 0) {
    console.error('\n[authorized-assets] FAIL — files present that the authorization does not cover:\n');
    for (const f of presentButUnauthorized) {
      const nearMiss = likelyNearMisses.includes(f);
      console.error(`  - ${f}` + (nearMiss ? '  (same stem as an authorized asset — NOT the same authorization; see note below)' : ''));
    }
    console.error(
      '\nThe owner authorization states: "' + manifest.authorization.scopeClause + '"\n' +
      'Remove these files, or obtain an explicit owner authorization naming them and add\n' +
      'them to fixtures/real-products/authorized-assets.json in that same change.',
    );
    if (likelyNearMisses.length > 0) {
      console.error(
        '\nNote on the near-miss(es) above: a matching filename stem is NOT authorization\n' +
        'for a different extension. Extensions are never translated by this tool.',
      );
    }
    process.exit(1);
  }

  if (strict && (authorizedAndAbsent.length > 0 || authorizedPresentWrongFormat.length > 0)) {
    console.error('\n[authorized-assets] --strict: not every authorized asset is present in an accepted format.');
    process.exit(1);
  }

  console.log('\n[authorized-assets] PASS — nothing present outside the authorization.');
}

if (require.main === module) {
  main();
}

module.exports = {
  isAuthorized,
  isAcceptedFormat,
  classify,
  presentImageFiles,
  manifest,
  FORMAT_POLICY,
  REAL_PRODUCTS_DIR,
};
