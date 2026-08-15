'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));
const RES = 'android/app/src/main/res';

/** Foreground/monochrome layer edge length, in px, for each mipmap bucket (108dp). */
const DENSITIES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const ADAPTIVE_LAYERS = ['ic_launcher_foreground', 'ic_launcher_monochrome'];

/** Minimal PNG/WebP header reader: keeps the size contract enforceable with no image dep. */
function imageSize(relativePath) {
  const buf = fs.readFileSync(path.join(ROOT, relativePath));

  if (buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      hasAlpha: [4, 6].includes(buf.readUInt8(25)),
    };
  }

  assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF', `${relativePath} is not PNG or WebP`);
  assert.equal(buf.subarray(8, 12).toString('ascii'), 'WEBP');
  const format = buf.subarray(12, 16).toString('ascii');

  if (format === 'VP8X') {
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
      hasAlpha: Boolean(buf.readUInt8(20) & 0x10),
    };
  }
  if (format === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
      hasAlpha: Boolean((bits >> 28) & 1),
    };
  }
  assert.equal(format, 'VP8 ', `${relativePath} has unsupported WebP format ${format}`);
  return {
    width: buf.readUInt16LE(26) & 0x3fff,
    height: buf.readUInt16LE(28) & 0x3fff,
    hasAlpha: false,
  };
}

test('app.json declares the full adaptive icon, including the monochrome layer', () => {
  const adaptiveIcon = readJson('app.json').expo.android.adaptiveIcon;

  assert.equal(adaptiveIcon.foregroundImage, './assets/adaptive-icon.png');
  assert.equal(
    adaptiveIcon.monochromeImage,
    './assets/adaptive-icon-monochrome.png',
    'without monochromeImage a prebuild drops themed-icon support on Android 13+',
  );
  assert.match(adaptiveIcon.backgroundColor, /^#[0-9a-fA-F]{6}$/);
});

test('the adaptive background colour matches the committed launcher resource', () => {
  const { backgroundColor } = readJson('app.json').expo.android.adaptiveIcon;
  const colors = read(`${RES}/values/colors.xml`);
  const iconBackground = /<color name="iconBackground">(#[0-9a-fA-F]{6})<\/color>/.exec(colors);

  assert.ok(iconBackground, 'colors.xml must define iconBackground');
  assert.equal(iconBackground[1].toLowerCase(), backgroundColor.toLowerCase());
});

test('the adaptive layer sources are real layers, not a copy of the square app icon', () => {
  for (const source of ['assets/adaptive-icon.png', 'assets/adaptive-icon-monochrome.png']) {
    const { width, height, hasAlpha } = imageSize(source);

    assert.equal(width, height, `${source} must be square`);
    assert.ok(width >= 1024, `${source} must be at least 1024px`);
    assert.ok(
      hasAlpha,
      `${source} has no alpha channel, so it is a full-bleed square rather than an ` +
        'adaptive layer; a launcher mask would crop the artwork',
    );
  }

  const icon = fs.readFileSync(path.join(ROOT, 'assets/icon.png'));
  const foreground = fs.readFileSync(path.join(ROOT, 'assets/adaptive-icon.png'));
  assert.ok(!icon.equals(foreground), 'adaptive-icon.png must not be a copy of icon.png');
});

test('both adaptive icon descriptors declare background, foreground and monochrome', () => {
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    const xml = read(`${RES}/mipmap-anydpi-v26/${name}.xml`);

    assert.match(xml, /<adaptive-icon/);
    assert.match(xml, /<background android:drawable="@color\/iconBackground"\/>/);
    assert.match(xml, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/);
    assert.match(xml, /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"\/>/);
  }
});

test('every density ships both adaptive layers at the 108dp size', () => {
  for (const [density, expected] of Object.entries(DENSITIES)) {
    for (const layer of ADAPTIVE_LAYERS) {
      const file = `${RES}/mipmap-${density}/${layer}.webp`;
      assert.ok(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);

      const { width, height, hasAlpha } = imageSize(file);
      assert.equal(width, expected, `${file} width`);
      assert.equal(height, expected, `${file} height`);
      assert.ok(hasAlpha, `${file} must keep its alpha channel`);
    }
  }
});

test('the manifest points the launcher at the adaptive icon resources', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');

  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
});

test('launcher resources are committed rather than ignored', () => {
  const gitignore = read('.gitignore');

  // EAS Build uses the checked-in android/ tree as-is. Ignoring these paths is what
  // shipped a Build 29 tree with no adaptive icon and no themed icon.
  assert.doesNotMatch(gitignore, /^\s*android\/app\/src\/main\/res\/mipmap-anydpi-v26\/?\s*$/m);
  assert.doesNotMatch(gitignore, /^\s*android\/app\/src\/main\/res\/mipmap-\*\/ic_launcher_\w+\.webp\s*$/m);
});
