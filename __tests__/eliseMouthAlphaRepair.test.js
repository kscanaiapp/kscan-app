/**
 * Elise visible-mouth regression. RGB-only registration tests missed the
 * original fully transparent alpha crop. Exercise the EXACT build repair on
 * both approved shipped PNGs, in memory; no asset files are mutated by tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodePng, encodePng, repair, rgbDigest, alphaCoverage, bounds, MOUTH } =
  require('../scripts/repair-elise-mouth-alpha.cjs');

const FILES = ['avatar_stylist_01_mouth_closed.png', 'avatar_stylist_01_mouth_open.png'];
const ASSETS = path.join(__dirname, '..', 'assets', 'stylist-avatars', 'portraits', 'animated');

function fixture() {
  const width = 200, height = 200, pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = x % 256; pixels[i+1] = y % 256; pixels[i+2] = (x+y) % 256;
    pixels[i+3] = x >= 78 && x < 132 && y >= 112 && y < 130 ? 255 : 0;
  }
  return encodePng({ width, height, pixels });
}

test('a transparent mouth regains alpha without changing a single RGB pixel', () => {
  const input = fixture(), before = decodePng(input);
  assert.equal(alphaCoverage(before, bounds(MOUTH, 200, 200)), 0);
  const result = repair(input);
  assert.equal(result.modified, true);
  const after = decodePng(result.output);
  assert.equal(rgbDigest(before), rgbDigest(after));
  assert.ok(alphaCoverage(after, bounds(MOUTH, 200, 200)) > 0.90);
  for (let y=0; y<200; y++) for (let x=0; x<200; x++) {
    const inside = x>=78 && x<132 && y>=140 && y<158;
    if (!inside) assert.equal(after.pixels[(y*200+x)*4+3],
      before.pixels[(y*200+x)*4+3], 'alpha outside mouth must be preserved');
  }
  const again = repair(result.output);
  assert.equal(again.modified, false, 'repair must be idempotent');
  assert.deepEqual(again.output, result.output);
});

test('unusable alpha mask fails closed instead of building a static Elise', () => {
  const broken = decodePng(fixture());
  broken.pixels.fill(0);
  assert.throws(() => repair(encodePng(broken)), /missing approved old alpha mask/);
});

for (const name of FILES) {
  test('approved ' + name + ' has visible mouth alpha after deterministic build repair', () => {
    const original = fs.readFileSync(path.join(ASSETS, name));
    const before = decodePng(original);
    const fixed = repair(original);
    const after = decodePng(fixed.output);
    assert.equal(rgbDigest(before), rgbDigest(after), 'source artwork RGB must be preserved');
    assert.ok(alphaCoverage(after, bounds(MOUTH, after.width, after.height)) >= 0.08,
      'renderer crop must cover non-transparent mouth pixels');
    assert.equal(repair(fixed.output).modified, false);
  });
}
