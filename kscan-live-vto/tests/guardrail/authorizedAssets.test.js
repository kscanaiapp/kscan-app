'use strict';

/**
 * Real product fixture authorization gate — regression test.
 *
 * The owner's 2026-09-04 authorization is per-file and says so:
 * "Authorization applies only to the exact files listed in this document",
 * with "adding unrelated retailer/catalog images not listed above"
 * explicitly not permitted. These tests pin that the gate enforces it by
 * exact filename, and that the authorization record itself cannot drift
 * away from what was actually authorized without the drift being visible.
 *
 * Every filename below is synthetic input to the classifier. No image is
 * read, decoded, or processed here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  isAuthorized,
  isAcceptedFormat,
  manifest,
  FORMAT_POLICY,
  REAL_PRODUCTS_DIR,
} = require(path.resolve(__dirname, '..', '..', 'tools', 'validate-authorized-assets.js'));

/** Verbatim from the owner authorization dated 2026-09-04. */
const OWNER_AUTHORIZED_FILES = [
  'tee-flatlay-001.jpg',
  'tee-flatlay-002.jpg',
  'tee-logo-001.jpg',
  'tee-studio-001.jpg',
  'sweater-studio-001.jpg',
  'top-ghost-001.jpg',
  'top-ghost-002.jpg',
];

test('the manifest lists exactly the seven files the owner authorized — no more, no fewer', () => {
  const manifestFiles = manifest.assets.map((a) => a.file).sort();
  assert.deepEqual(manifestFiles, [...OWNER_AUTHORIZED_FILES].sort());
});

test('every authorized file is accepted by the gate', () => {
  for (const file of OWNER_AUTHORIZED_FILES) {
    assert.equal(isAuthorized(file), true, `${file} is named in the authorization and must be accepted`);
  }
});

test('an image not named in the authorization is refused, however plausible its name', () => {
  const notAuthorized = [
    // Plausible near-misses on the authorized names — the exact-match rule
    // has to reject these, or "only the exact files listed" means nothing.
    'tee-flatlay-003.jpg',
    'tee-flatlay-001.png',
    'sweater-studio-002.jpg',
    'top-ghost-003.jpg',
    // The repository's pre-existing QA fixtures. These were NOT included in
    // the authorization's file list, and the authorization names adding
    // unlisted catalog images as not permitted.
    'top.jpg',
    'outerwear.jpg',
    'bottom_skirt.jpg',
    // Arbitrary additions.
    'some-retailer-scrape.jpg',
  ];

  for (const file of notAuthorized) {
    assert.equal(isAuthorized(file), false, `${file} is not in the authorization and must be refused`);
  }
});

test('the gate matches by exact filename, not by prefix or extension-insensitively', () => {
  assert.equal(isAuthorized('tee-flatlay-001'), false, 'bare stem must not match');
  assert.equal(isAuthorized('tee-flatlay-001.jpg.bak'), false, 'suffixed name must not match');
  assert.equal(isAuthorized('archive/tee-flatlay-001.jpg'), false, 'pathed name must not match a bare filename entry');
});

test('the authorization record preserves the owner\'s permitted and not-permitted use lists', () => {
  const { permittedUses, notPermitted, scopeClause, authorizedBy, date } = manifest.authorization;

  assert.equal(authorizedBy, 'Justin Smith');
  assert.equal(date, '2026-09-04');
  assert.match(scopeClause, /only to the exact files listed/i);

  // The four prohibitions that constrain what may be done with these assets
  // downstream. Losing one of these from the record would quietly widen the
  // authorization.
  for (const prohibition of [/unrelated ML training/i, /public redistribution/i, /external publication/i, /customer-facing use/i]) {
    assert.ok(
      notPermitted.some((entry) => prohibition.test(entry)),
      `authorization record lost a prohibition matching ${prohibition}`,
    );
  }

  assert.ok(permittedUses.some((u) => /ksgarment/i.test(u)));
  assert.ok(permittedUses.length >= 6);
});

test('the canonical fixture directory is fixtures/real-products, not fixtures/products', () => {
  assert.ok(REAL_PRODUCTS_DIR.endsWith(path.join('fixtures', 'real-products')));
  assert.ok(!REAL_PRODUCTS_DIR.endsWith(path.join('fixtures', 'products')));
});

test('format policy accepts PNG only for this corpus', () => {
  assert.deepEqual(FORMAT_POLICY.acceptedExtensions, ['.png']);
  assert.equal(isAcceptedFormat('tee-flatlay-001.png'), true);
  assert.equal(isAcceptedFormat('tee-flatlay-001.jpg'), false);
  assert.equal(isAcceptedFormat('tee-flatlay-001.jpeg'), false);
  assert.equal(isAcceptedFormat('tee-flatlay-001.tiff'), false);
  assert.equal(isAcceptedFormat('tee-flatlay-001.webp'), false);
});

test('a same-stem .png is NOT authorized merely because the .jpg with that stem is', () => {
  // This is the specific inference the authorization forbids: "Do not infer
  // that tee-flatlay-001.jpg authorizes tee-flatlay-001.png."
  for (const jpgName of OWNER_AUTHORIZED_FILES) {
    const pngName = jpgName.replace(/\.jpg$/, '.png');
    assert.equal(
      isAuthorized(pngName),
      false,
      `${pngName} must not be authorized by ${jpgName}'s authorization — extensions are never translated`,
    );
  }
});

test('the authorized filenames themselves are still exactly what the owner wrote (still .jpg)', () => {
  // This pins that no automated process has speculatively renamed the
  // authorization to .png ahead of the owner supplying exact PNG filenames.
  for (const file of manifest.assets.map((a) => a.file)) {
    assert.match(file, /\.jpg$/, `${file}: authorized-assets.json must record exactly what the owner authorized, unmodified`);
  }
});

test('top.jpg (assets/qa_fixtures) remains excluded regardless of ownership statements made elsewhere', () => {
  assert.equal(isAuthorized('top.jpg'), false);
});

test('shot-class coverage is recorded, so the corpus composition can be judged before ingestion', () => {
  const byShotClass = {};
  for (const a of manifest.assets) {
    byShotClass[a.shotClass] = (byShotClass[a.shotClass] || 0) + 1;
  }

  // Priority order for asset work is flat lay > ghost mannequin > clean
  // studio > model-worn. The authorized set covers the top three; nothing
  // in it is model-worn.
  assert.ok(byShotClass['flat-lay'] >= 2, 'expected at least two flat-lay assets');
  assert.ok(byShotClass['ghost-mannequin'] >= 2, 'expected at least two ghost-mannequin assets');
  assert.ok(byShotClass['clean-studio'] >= 2, 'expected at least two clean-studio assets');

  // At least one directional-pattern canary, for the mirroring/orientation/
  // stretch checks that a plain garment cannot reveal.
  assert.ok(
    manifest.assets.some((a) => a.directionalCanary === true),
    'expected at least one directional/logo canary asset',
  );
});
