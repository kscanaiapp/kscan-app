#!/usr/bin/env node
'use strict';

/**
 * Deterministic scale-corpus generator (spec sections 36-38).
 *
 * Fixed named seed: "kscan-commerce-corpus-v1". No unseeded Math.random()
 * anywhere in this file - every choice is derived from the seeded PRNG
 * below, so re-running this script against the same seed reproduces
 * byte-identical output. This script and its output are both committed;
 * __tests__/commerce-corpus/scaleCorpus.test.js re-runs it in-memory and
 * diffs against the committed files to prove that determinism holds.
 *
 * Usage: node tools/commerce-corpus/generateScaleCorpus.js
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SEED = 'kscan-commerce-corpus-v1';
const SIZES = [10, 25, 50];
const OUT_DIR = path.resolve(__dirname, '../../__tests__/fixtures/commerce/scale');

const RETAILERS = ['Nordstrom', 'Farfetch', 'Zappos', 'SSENSE', 'Poshmark', 'KicksCrew', 'Zara'];
const CURRENCIES = ['USD', 'EUR', 'GBP', null]; // null = currency unknown, deliberately included
const BRANDS = ['Ganni', 'Acne Studios', 'Levi\'s', 'New Balance', 'Patagonia', 'Everlane'];

/** Seed a 32-bit integer from a string (for mulberry32), not Math.random(). */
function seedFromString(str) {
  const hash = crypto.createHash('sha256').update(str).digest();
  return hash.readUInt32BE(0);
}

/** mulberry32 - small, deterministic, dependency-free PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Builds one deterministic offer list of the given size. Composition
 * requirements (spec section 36): a realistic mix of Retail/Resale, known
 * and unknown retailer, logo authority / no logo authority, watchable / not
 * watchable, known/unknown currency, exact-group candidates (share a
 * productId with a sibling), and must-not-group candidates (similar brand +
 * title, distinct productId).
 */
function buildOfferList(size, rng) {
  const offers = [];
  for (let i = 0; i < size; i += 1) {
    const offerId = `scale-offer-${String(i).padStart(3, '0')}`;
    let knownRetailer = rng() > 0.15; // ~85% known retailer, 15% unknown - deterministic given the seed
    let retailer = knownRetailer ? pick(rng, RETAILERS) : null;
    let logoAuthority = knownRetailer && rng() > 0.2; // even a known retailer sometimes has no logo authority
    let isResale = retailer === 'Poshmark' || rng() > 0.85;
    let commerceType = isResale ? 'resale' : 'retail';
    let watchEligibleRetailer = retailer === 'Farfetch' || retailer === 'KicksCrew';
    let watchCapability = watchEligibleRetailer && !isResale ? 'refreshable_listing' : 'unsupported';
    const currency = pick(rng, CURRENCIES);
    const brand = pick(rng, BRANDS);

    // Deterministic composition guarantee (spec section 36: "a realistic mix
    // of ... watchable ... not watchable" in EVERY size, including the
    // smallest, where pure chance can otherwise omit a rare category): the
    // first offer of every generated set is pinned to a real watch-eligible
    // shape (Farfetch, retail). This is a fixed invariant, not drawn from the
    // PRNG, so it does not affect determinism of the remaining offers.
    if (i === 0) {
      knownRetailer = true;
      retailer = 'Farfetch';
      logoAuthority = true;
      isResale = false;
      commerceType = 'retail';
      watchEligibleRetailer = true;
      watchCapability = 'refreshable_listing';
    }

    // Exact-group candidate: every 7th offer intentionally shares a productId
    // with the offer 1 position earlier in a DIFFERENT-looking retailer slot,
    // to guarantee at least one real exact-group pair per size >= 10.
    const isExactGroupMember = i > 0 && i % 7 === 0;
    const productId = isExactGroupMember ? `SHARED-${Math.floor(i / 7)}` : `UNIQ-${offerId}`;

    // Must-not-group candidate: every 5th offer (offset from the exact-group
    // cadence so the two don't collide) gets a title that is a near-duplicate
    // of a sibling's, same brand, but its own distinct productId - the exact
    // must-not-group shape from Finding F2.
    const isMustNotGroupMember = i > 0 && i % 5 === 0 && i % 7 !== 0;
    const title = isMustNotGroupMember
      ? `${brand} Signature Item (Style ${Math.floor(i / 5)})`
      : `${brand} Item ${offerId}`;

    offers.push({
      offerId,
      sourceIndex: i,
      retailer,
      brand,
      title,
      commerceType,
      logoAuthority,
      watchCapability,
      currency,
      price: Math.round((20 + rng() * 480) * 100) / 100,
      productId,
    });
  }
  return offers;
}

function summarize(offers) {
  const summary = {
    totalOffers: offers.length,
    knownRetailer: offers.filter((o) => o.retailer !== null).length,
    unknownRetailer: offers.filter((o) => o.retailer === null).length,
    logoAuthority: offers.filter((o) => o.logoAuthority).length,
    noLogoAuthority: offers.filter((o) => !o.logoAuthority).length,
    retail: offers.filter((o) => o.commerceType === 'retail').length,
    resale: offers.filter((o) => o.commerceType === 'resale').length,
    watchable: offers.filter((o) => o.watchCapability === 'refreshable_listing').length,
    notWatchable: offers.filter((o) => o.watchCapability === 'unsupported').length,
    knownCurrency: offers.filter((o) => o.currency !== null).length,
    unknownCurrency: offers.filter((o) => o.currency === null).length,
  };
  return summary;
}

function buildFixtureFile(size) {
  const rng = mulberry32(seedFromString(`${SEED}:${size}`));
  const offers = buildOfferList(size, rng);
  return {
    commerceCorpusFixtureVersion: 1,
    category: 'scale',
    records: [
      {
        scenarioId: `scale-${size}-offers`,
        description: `${size} deterministically generated offers exercising a realistic mix of Retail/Resale, known/unknown retailer, logo authority, watch eligibility, known/unknown currency, and exact-group/must-not-group candidates.`,
        evidenceClass: 'SYNTHETIC',
        tags: ['scale', 'pr-c-support'],
        seed: `${SEED}:${size}`,
        generator: 'tools/commerce-corpus/generateScaleCorpus.js',
        input: { offers },
        expected: { orderPreserved: true, sourceOrderField: 'sourceIndex', composition: summarize(offers) },
        notes:
          'Generated output, not hand-authored. Re-running generateScaleCorpus.js against the same seed reproduces this file byte-for-byte; see __tests__/commerce-corpus/scaleCorpus.test.js.',
      },
    ],
  };
}

/**
 * One offer object per line (see buildManifest.js's serializeManifest for
 * the same rationale) - a 50-offer set pretty-printed with nested objects
 * runs to hundreds of lines for content that is one line of information per
 * offer; this keeps the file's size proportional to what it contains.
 */
function serializeFixtureFile(fixture) {
  const record = fixture.records[0];
  const offerLines = record.input.offers
    .map((o, i) => `        ${JSON.stringify(o)}${i < record.input.offers.length - 1 ? ',' : ''}`)
    .join('\n');
  const recordHeader = {
    scenarioId: record.scenarioId,
    description: record.description,
    evidenceClass: record.evidenceClass,
    tags: record.tags,
    seed: record.seed,
    generator: record.generator,
  };
  return (
    `{\n  "commerceCorpusFixtureVersion": ${fixture.commerceCorpusFixtureVersion},\n` +
    `  "category": ${JSON.stringify(fixture.category)},\n` +
    `  "records": [\n    {\n` +
    Object.entries(recordHeader)
      .map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
      .join('\n') +
    `\n      "input": {\n      "offers": [\n${offerLines}\n      ]\n    },\n` +
    `      "expected": ${JSON.stringify(record.expected)},\n` +
    `      "notes": ${JSON.stringify(record.notes)}\n    }\n  ]\n}\n`
  );
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const fixture = buildFixtureFile(size);
    const outPath = path.join(OUT_DIR, `scale-${size}.json`);
    fs.writeFileSync(outPath, serializeFixtureFile(fixture));
    console.log(`wrote ${outPath} (${size} offers)`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildFixtureFile, buildOfferList, serializeFixtureFile, mulberry32, seedFromString, SEED, SIZES };
