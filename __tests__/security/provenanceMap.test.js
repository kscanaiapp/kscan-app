#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const report = require('../../security/release/master-staging-provenance-map.json');

test('provenance map accounts for every divergent commit in the audited snapshot', () => {
  assert.equal(report.counts.total, 543);
  assert.deepEqual(report.counts.by_origin, { master: 41, staging: 502 });
  assert.equal(report.commits.length, report.counts.total);
  assert.equal(new Set(report.commits.map((entry) => entry.commit_sha)).size, report.counts.total);
});

test('Build 2.5 and quarantine surfaces are explicitly excluded', () => {
  const byShort = new Map(report.commits.map((entry) => [entry.commit_sha.slice(0, 7), entry]));
  for (const sha of ['08015e7', '1f9b452', '19688e1', '39946ea']) {
    assert.equal(byShort.get(sha).recommended_disposition, 'BUILD25_EXCLUDE', sha);
  }
  assert.ok(report.commits.some((entry) => entry.recommended_disposition === 'QUARANTINE_EXCLUDE'));
  assert.deepEqual(report.explicit_excluded_remote_lines.product_match, [
    'origin/product-match/foundation-v1', 'origin/product-match/foundation-v1-ios',
  ]);
});

test('generator batches Git history and tree reads', () => {
  const source = fs.readFileSync(path.join(root, 'security', 'scripts', 'build-master-staging-provenance-map.js'), 'utf8');
  assert.match(source, /execFileSync\('git', \[\s*'log'/);
  assert.match(source, /ls-tree', '-r'/);
  assert.doesNotMatch(source, /function commitFiles/);
});
