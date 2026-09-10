#!/usr/bin/env node
// Seeded evaluation Closet (program section 23).
//
// Writes a deterministic 48-item Closet manifest in the exact on-disk shape
// services/closetLibrary.js persists, so the owner run packet exercises a real
// populated wardrobe surface rather than an empty one.
//
// CONTENT PROVENANCE (section 23). Every value here is SYNTHETIC. The brand
// names are invented placeholders (Northwind, Contoso, Fabrikam, Adventure
// Works, Litware — Microsoft's long-standing fictitious-company set, used
// precisely because they are not real apparel brands). No retailer imagery is
// bundled, and no image file is written at all: items carry null media so the
// grid exercises its placeholder path. Nothing in this fixture is derived from
// a real product listing.
//
// STAGING / LOCAL ONLY. This writes a local JSON file. It performs no network
// call, touches no Supabase project, and cannot reach production.
//
// Usage:
//   node tools/closet-eval/seedClosetFixture.mjs [--out <path>] [--owner <id>]

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const OUT = arg('--out', path.join(process.cwd(), 'tools/closet-eval/closet-fixture.json'));
// null = the iOS device-local (signed-out) partition, which is a real actor
// state. Pass --owner <uuid> to build a signed-in actor's Closet instead.
const RAW_OWNER = arg('--owner', '');
const OWNER = RAW_OWNER ? RAW_OWNER : null;

const CATEGORIES = [
  { category: 'Tops', clothingType: 'Shirt', subtypes: ['Oxford', 'Tee', 'Henley'] },
  { category: 'Bottoms', clothingType: 'Trousers', subtypes: ['Chino', 'Jean', 'Tailored'] },
  { category: 'Outerwear', clothingType: 'Jacket', subtypes: ['Bomber', 'Trench', 'Puffer'] },
  { category: 'Shoes', clothingType: 'Footwear', subtypes: ['Sneaker', 'Loafer', 'Boot'] },
  { category: 'Knitwear', clothingType: 'Sweater', subtypes: ['Crew', 'Cardigan'] },
  { category: 'Accessories', clothingType: 'Scarf', subtypes: ['Wool scarf'] },
];
const BRANDS = ['Northwind', 'Contoso', 'Fabrikam', 'Adventure Works', 'Litware'];
const COLORS = ['navy', 'charcoal', 'ivory', 'olive', 'burgundy', 'camel'];
const MATERIALS = [['wool'], ['cotton'], ['linen'], ['wool', 'cashmere'], []];
const SIZES = ['S', 'M', 'L', '32', '10'];

/**
 * The mix section 23 asks for, produced by INDEX rather than randomness so two
 * runs give a byte-identical fixture:
 *
 *   every 11th -> unclassified (no category at all)
 *   every 5th  -> placeholder title, so the review queue has real work
 *   every 4th  -> no brand
 *   every 7th  -> no image (grid placeholder path)
 *   every 9th  -> legacy v1 record shape (no taxonomy fields on disk at all)
 *   2 pairs    -> exact-identity re-add cases (same lineage, distinct records)
 */
function build() {
  const items = [];
  const base = Date.UTC(2026, 0, 1);

  for (let i = 0; i < 48; i += 1) {
    const spec = CATEGORIES[i % CATEGORIES.length];
    // 11, not 6: CATEGORIES has 6 entries, so an `i % 6` rule would make every
    // unclassified item land on the SAME category and that category would never
    // appear in the fixture at all. A modulus coprime with 6 spreads them.
    const unclassified = i % 11 === 0;
    const placeholderTitle = i % 5 === 0;
    const noBrand = i % 4 === 0;
    const noImage = i % 7 === 0;
    const legacy = i % 9 === 0 && !unclassified;

    const id = `closet_eval_${String(i).padStart(3, '0')}`;
    // Spread over ~48 days so "recently added" (30 days) covers part of it.
    const createdAt = new Date(base + i * 24 * 60 * 60 * 1000).toISOString();
    const brand = noBrand ? null : BRANDS[i % BRANDS.length];
    const subtype = spec.subtypes[i % spec.subtypes.length];

    if (legacy) {
      // A pre-taxonomy record, exactly as one written by an older build looks:
      // no v2 fields on disk at all. The read path must migrate it lazily.
      items.push({
        schemaVersion: 1,
        id,
        ownerId: OWNER,
        imageUri: noImage ? null : `file:///eval/img_${i}.jpg`,
        thumbnailUri: noImage ? null : `file:///eval/thumb_${i}.jpg`,
        title: placeholderTitle ? 'Closet item' : `Legacy ${spec.category}`,
        category: spec.category,
        notes: null,
        origin: 'recent_scan',
        createdAt,
        updatedAt: createdAt,
      });
      continue;
    }

    items.push({
      schemaVersion: 2,
      id,
      ownerId: OWNER,
      sourceCandidateId: null,
      imageUri: noImage ? null : `file:///eval/img_${i}.jpg`,
      thumbnailUri: noImage ? null : `file:///eval/thumb_${i}.jpg`,
      title: placeholderTitle
        ? 'Closet item'
        : `${brand ? `${brand} ` : ''}${subtype}`.trim(),
      category: unclassified ? null : spec.category,
      clothingType: unclassified ? null : spec.clothingType,
      subtype: unclassified ? null : subtype,
      brand: unclassified ? null : brand,
      primaryColor: unclassified ? null : COLORS[i % COLORS.length],
      secondaryColors: i % 3 === 0 ? [COLORS[(i + 2) % COLORS.length]] : [],
      material: unclassified ? [] : MATERIALS[i % MATERIALS.length],
      size: unclassified ? null : SIZES[i % SIZES.length],
      notes: null,
      // Two thirds arrive by scan promotion, matching the real product mix.
      origin: i % 3 === 0 ? 'direct_intake' : 'recent_scan',
      sourceLocalScanId: null,
      sourceSavedScanId: null,
      // EXACT-IDENTITY RE-ADD CASES. Items 10/11 and 30/31 are two genuinely
      // separate records for what looks like the same garment. They exist to
      // prove the product does NOT invent a duplicate warning: a Closet record
      // carries no product identity, so Intelligence reports none.
      sourceLineageId: i === 11 ? 'lineage_eval_010' : i === 31 ? 'lineage_eval_030' : `lineage_eval_${String(i).padStart(3, '0')}`,
      clientRequestId: null,
      createdAt,
      updatedAt: createdAt,
    });
  }
  return items;
}

const items = build();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(items, null, 2), 'utf8');

const withCategory = items.filter((i) => i.category).length;
const withBrand = items.filter((i) => i.brand).length;
const placeholder = items.filter((i) => i.title === 'Closet item').length;
const legacyCount = items.filter((i) => i.schemaVersion === 1).length;
const noImage = items.filter((i) => !i.imageUri).length;

console.log(`Wrote ${items.length} items to ${OUT}`);
console.log(`  owner:            ${OWNER ?? 'device-local (signed out)'}`);
console.log(`  with category:    ${withCategory}/${items.length}`);
console.log(`  with brand:       ${withBrand}/${items.length}`);
console.log(`  placeholder name: ${placeholder}`);
console.log(`  legacy v1 shape:  ${legacyCount}`);
console.log(`  no image:         ${noImage}`);
console.log('');
console.log('Install on a simulator/emulator by writing this file to the app sandbox at');
console.log('  <documentDirectory>/kscan_closet/kscan_closet.json');
console.log('This script performs NO network call and cannot reach any Supabase project.');
