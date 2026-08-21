const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('Expo android adaptive icon config points at cream background and new assets', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.equal(appJson.expo.icon, './assets/icon.png');
  assert.equal(appJson.expo.android.icon, './assets/icon.png');
  assert.equal(appJson.expo.android.package, 'com.kscanai.app');
  assert.equal(appJson.expo.android.versionCode, 32);
  const nativeBuildGradle = fs.readFileSync(
    path.join(ROOT, 'android/app/build.gradle'),
    'utf8',
  );
  assert.match(nativeBuildGradle, /versionCode\s+32\b/);
  // The native project is checked in, so these two are synced by hand and can
  // drift independently of the literal above.
  assert.equal(
    Number(nativeBuildGradle.match(/versionCode\s+(\d+)/)[1]),
    appJson.expo.android.versionCode,
    'android/app/build.gradle versionCode must match app.json',
  );
  assert.equal(appJson.expo.android.adaptiveIcon.foregroundImage, './assets/adaptive-icon.png');
  assert.equal(appJson.expo.android.adaptiveIcon.backgroundColor, '#F5E8D5');
  assert.equal(
    appJson.expo.android.adaptiveIcon.monochromeImage,
    './assets/adaptive-icon-monochrome.png',
  );
});

test('source launcher assets exist', () => {
  for (const rel of [
    'assets/icon.png',
    'assets/adaptive-icon.png',
    'assets/adaptive-icon-monochrome.png',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  }
});

test('native adaptive XML uses cream background and mono foreground layers', () => {
  const xml = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'),
    'utf8',
  );
  assert.match(xml, /@color\/iconBackground/);
  assert.match(xml, /@mipmap\/ic_launcher_foreground/);
  assert.match(xml, /@mipmap\/ic_launcher_monochrome/);
  const colors = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/res/values/colors.xml'),
    'utf8',
  );
  assert.match(colors, /iconBackground">#F5E8D5</);
});

test('manifest still references mipmap launcher icons', () => {
  const manifest = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
});

test('density mipmaps include legacy, foreground, and monochrome webp', () => {
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    const dir = path.join(ROOT, `android/app/src/main/res/mipmap-${density}`);
    for (const name of [
      'ic_launcher.webp',
      'ic_launcher_round.webp',
      'ic_launcher_foreground.webp',
      'ic_launcher_monochrome.webp',
    ]) {
      const file = path.join(dir, name);
      assert.ok(fs.existsSync(file), file);
      assert.ok(fs.statSync(file).size > 100, `${file} too small`);
    }
  }
});
