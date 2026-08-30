/**
 * Build 33 — ITMS-90118 recurrence guard.
 *
 * Apple rejected Build 32 (1.0.1) with:
 *
 *   ITMS-90118: Invalid routing app setting: To upload a routing app coverage
 *   file on App Store Connect, you must define the app binary as a routing app.
 *
 * Root cause was an App Store Connect setting, not the binary: a Routing App
 * Coverage File had been attached to the app record. The repository made that
 * mistake easy to repeat — it shipped `assets/routing-app-coverage.geojson`
 * plus a document instructing the release owner to upload it as a "proactive
 * compliance measure."
 *
 * K Scan is a fashion discovery app. It provides no turn-by-turn navigation, so
 * there are only two ways to clear ITMS-90118 and exactly one is correct:
 * remove the coverage file from App Store Connect. Declaring the binary as a
 * routing app to satisfy the file would misrepresent the product to App Review.
 *
 * These are source-contract tests (no renderer), consistent with the rest of
 * the suite. They cannot see App Store Connect — the coverage-file removal
 * stays an owner action — but they do stop the source tree from re-acquiring
 * the artifacts and declarations that produced the rejection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const ios = appJson.expo.ios;
const infoPlist = ios.infoPlist || {};

test('the binary declares no routing-app capability', () => {
  // MKDirectionsApplicationSupportedModes is the key that would make Apple treat
  // K Scan as a routing app. Adding it to silence ITMS-90118 is the wrong fix.
  assert.equal(
    infoPlist.MKDirectionsApplicationSupportedModes,
    undefined,
    'K Scan must not declare itself a routing app',
  );

  const serialized = JSON.stringify(appJson);
  assert.doesNotMatch(serialized, /MKDirections/);
  assert.doesNotMatch(serialized, /com\.apple\.developer\.maps/);
});

test('no routing app coverage asset is tracked in the repository', () => {
  // The asset was referenced by no code, no config and no build step. Its only
  // purpose was the App Store Connect upload that triggered the rejection.
  assert.equal(
    fs.existsSync(path.join(ROOT, 'assets', 'routing-app-coverage.geojson')),
    false,
    'the routing coverage GeoJSON must not be reintroduced',
  );
});

test('no .geojson coverage file is reachable from the assets tree', () => {
  const assetsDir = path.join(ROOT, 'assets');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.geojson')) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  if (fs.existsSync(assetsDir)) walk(assetsDir);
  assert.deepEqual(offenders, [], `unexpected GeoJSON assets: ${offenders.join(', ')}`);
});

test('the routing document instructs removal, never upload', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'routing-app-coverage.md'), 'utf8');
  // The superseded revision said: "Upload assets/routing-app-coverage.geojson".
  assert.doesNotMatch(
    doc,
    /^\s*\d+\.\s*Upload\s+`?assets\/routing-app-coverage\.geojson/im,
    'the document must not instruct uploading a routing coverage file',
  );
  assert.match(doc, /ITMS-90118/);
  assert.match(doc, /DO NOT UPLOAD/i);
});
