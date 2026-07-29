#!/usr/bin/env node
'use strict';

/**
 * Export-level QA fixture containment detector.
 *
 * Answers one question with evidence rather than inference: are any QA fixture
 * images present in a production export?
 *
 * Expo names exported assets by the md5 of their content, so presence is
 * directly testable — no reasoning about Metro internals required.
 *
 * WHY A SOURCE-LEVEL CHECK IS NOT ENOUGH: a `__DEV__ ? [require(...)] : []`
 * guard leaves the runtime path dead but still ships the images, because Metro
 * collects asset dependencies while building the module graph and only
 * eliminates the dead branch later, at minification. A test that evaluates the
 * module with `__DEV__ = false` therefore passes while the assets are still in
 * the bundle. Only the export can settle it.
 *
 *   node scripts/check-export-fixture-containment.js <exportDir>
 *
 * Exit 0 when zero fixture assets are present, 1 otherwise.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'assets', 'qa_fixtures');

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function check(exportDir) {
  if (!fs.existsSync(exportDir)) {
    return { ok: false, error: `export directory not found: ${exportDir}` };
  }
  const assetsDir = path.join(exportDir, 'assets');
  const exported = new Set(fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []);

  if (!fs.existsSync(FIXTURE_DIR)) {
    return { ok: true, note: 'no fixture directory in this worktree', fixtureAssetsPresent: 0, fixtures: [] };
  }

  const fixtures = fs
    .readdirSync(FIXTURE_DIR)
    .filter((name) => /\.(jpg|jpeg|png|webp|heic)$/i.test(name))
    .sort()
    .map((name) => {
      const hash = md5(fs.readFileSync(path.join(FIXTURE_DIR, name)));
      return { name, md5: hash, presentInExport: exported.has(hash) };
    });

  const fixtureAssetsPresent = fixtures.filter((f) => f.presentInExport).length;

  return {
    ok: fixtureAssetsPresent === 0,
    exportDir,
    exportedAssetCount: exported.size,
    fixtureCount: fixtures.length,
    fixtureAssetsPresent,
    fixtures,
    passCondition: 'fixtureAssetsPresent = 0',
  };
}

function main(argv = process.argv.slice(2)) {
  const exportDir = argv[0];
  if (!exportDir) {
    console.error('Usage: node scripts/check-export-fixture-containment.js <exportDir>');
    process.exitCode = 1;
    return { ok: false };
  }
  const result = check(path.resolve(exportDir));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (require.main === module) main();

module.exports = { check, main };
