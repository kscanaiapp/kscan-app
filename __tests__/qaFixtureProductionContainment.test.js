'use strict';

/**
 * QA fixture production containment.
 *
 * These are source- and config-level checks. The AUTHORITATIVE proof is the
 * export-level detector, `scripts/check-export-fixture-containment.js`, because
 * a source-level test cannot see Metro's module graph.
 *
 * That distinction is the whole reason this branch exists: the previously
 * attempted `__DEV__ ? [require(...)] : []` guard passes a runtime test — no
 * require executes when `__DEV__` is false — while the images still ship. Metro
 * collects asset dependencies while building the graph and only eliminates the
 * dead branch later, at minification. A production export of the guarded source
 * contained all eight fixture hashes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Strip comments before asserting on source.
 *
 * These files necessarily *describe* the hazard in prose — the words
 * `require(` and `assets/qa_fixtures/` appear in the explanatory comments. Only
 * executable code puts an asset into Metro's graph, so only executable code is
 * asserted on.
 */
function code(relative) {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the production fixture module contains no asset require', () => {
  const source = code('constants/qaFixtures.js');
  assert.equal(
    /require\(/.test(source),
    false,
    'constants/qaFixtures.js must not require any asset — a require here enters the production graph regardless of any guard'
  );
  assert.match(source, /export const QA_FIXTURES = \[\]/);
});

test('the development fixture module still registers every fixture', () => {
  const source = code('constants/qaFixtures.dev.js');
  const requires = source.match(/require\('\.\.\/assets\/qa_fixtures\/[^']+'\)/g) || [];
  assert.equal(requires.length, 8, 'the dev registry must still carry all eight fixtures');
  assert.match(source, /export const QA_FIXTURES/);
});

test('metro registers the dev.js source extension only outside production', () => {
  const configPath = require.resolve(path.join(ROOT, 'metro.config.js'));

  const load = (nodeEnv) => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = nodeEnv;
    delete require.cache[configPath];
    try {
      return require(configPath);
    } finally {
      process.env.NODE_ENV = previous;
      delete require.cache[configPath];
    }
  };

  const dev = load('development');
  assert.ok(dev.resolver.sourceExts.includes('dev.js'), 'development must resolve .dev.js');
  assert.equal(dev.resolver.sourceExts[0], 'dev.js', 'dev.js must take precedence over the default extensions');

  const prod = load('production');
  assert.equal(
    prod.resolver.sourceExts.includes('dev.js'),
    false,
    'production must NOT resolve .dev.js, so the dev registry and its assets stay out of the graph'
  );
});

test('the only production consumer imports the extensionless specifier', () => {
  // app.js must import './constants/qaFixtures', not the .dev module directly —
  // otherwise production would pull the dev registry in explicitly.
  const app = code('app.js');
  assert.match(app, /from '\.\/constants\/qaFixtures'/);
  assert.equal(/qaFixtures\.dev/.test(app), false, 'production source must never name the dev registry');
});

test('no production source outside the dev registry references the fixture assets', () => {
  const offenders = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'android', 'ios', '__tests__', 'scripts', 'docs']);

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      const relative = path.relative(ROOT, full).split(path.sep).join('/');
      if (relative === 'constants/qaFixtures.dev.js') continue;
      if (code(relative).includes('assets/qa_fixtures/')) offenders.push(relative);
    }
  };

  walk(ROOT);
  assert.deepEqual(offenders, [], 'only constants/qaFixtures.dev.js may reference the fixture assets');
});

test('the export detector reports containment for a fixture-free export', () => {
  const { check } = require('../scripts/check-export-fixture-containment.js');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qa-containment-'));
  fs.mkdirSync(path.join(tmp, 'assets'));
  const result = check(tmp);
  assert.equal(result.ok, true);
  assert.equal(result.fixtureAssetsPresent, 0);
  assert.equal(result.fixtureCount, 8, 'the detector must still know about all eight fixtures');
});

test('the export detector fails when a fixture is present', () => {
  const crypto = require('node:crypto');
  const { check } = require('../scripts/check-export-fixture-containment.js');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qa-containment-fail-'));
  fs.mkdirSync(path.join(tmp, 'assets'));

  // Reproduce Expo's naming: the asset file is named by the md5 of its content.
  const fixture = path.join(ROOT, 'assets/qa_fixtures/footwear.jpg');
  const md5 = crypto.createHash('md5').update(fs.readFileSync(fixture)).digest('hex');
  fs.writeFileSync(path.join(tmp, 'assets', md5), fs.readFileSync(fixture));

  const result = check(tmp);
  assert.equal(result.ok, false, 'a planted fixture must be detected');
  assert.equal(result.fixtureAssetsPresent, 1);
});
