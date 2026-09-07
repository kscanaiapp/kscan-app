#!/usr/bin/env node
'use strict';

/**
 * One-time inventory of existing committed image assets under
 * fixture/golden/mock/sample/testdata-named paths (spec section 16A).
 *
 * This ONLY inventories file existence/size/extension - it never opens a
 * network connection, and it does NOT execute any script that would (e.g.
 * scripts/qa-fixtures.js, which performs a live call and is explicitly out
 * of scope: $0 spend, no staging/production traffic). It also does not
 * grant these assets ground-truth status - see the `verdict` field below.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const NAME_HINT = /(fixture|golden|mock|sample|testdata)/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'tools']); // tools/ excludes this lab's own synthetic corpus

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (IMAGE_EXT.test(entry.name) && NAME_HINT.test(full)) {
      const stat = fs.statSync(full);
      out.push({
        path: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
        sizeBytes: stat.size,
      });
    }
  }
}

function buildInventory() {
  const found = [];
  walk(REPO_ROOT, found);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    scannedAt: new Date().toISOString().slice(0, 10),
    method: 'filesystem walk for *.{jpg,jpeg,png,webp} under a path/name containing fixture|golden|mock|sample|testdata; tools/ (this lab) excluded',
    totalFound: found.length,
    assets: found,
    verdict:
      'INVENTORY ONLY - not incorporated as APPROVED_REAL corpus ground truth. ' +
      'assets/qa_fixtures/*.jpg are category-labeled by filename only (accessory, bottom_jeans, ' +
      'bottom_skirt, dress, footwear, non_fashion, outerwear, top) with no SKU/brand/retailer-PDP ' +
      'provenance, and are consumed by scripts/qa-fixtures.js which performs a LIVE call - this lab ' +
      'does not execute that script (spend envelope is $0). fixtures/vto-phase4/generated/**, ' +
      'scripts/vto-e2e/fixtures/**, and vto-phase4-pipeline/fixtures-input/** are synthetic VTO ' +
      'garment-texture assets for virtual try-on rendering, not product-identification ground truth, ' +
      'and are unrelated to Scanner match quality. None of these assets satisfy spec section 15 ' +
      'ground-truth integrity for a headline accuracy metric as-is; they would need owner annotation ' +
      '(brand/SKU/category/silhouette/material ground truth) before promotion to corpus/real/.',
  };
}

if (require.main === module) {
  const inventory = buildInventory();
  const outFile = path.join(__dirname, 'repositoryAssetInventory.json');
  fs.writeFileSync(outFile, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  console.log(`Found ${inventory.totalFound} candidate assets. Wrote ${outFile}`);
}

module.exports = { buildInventory };
