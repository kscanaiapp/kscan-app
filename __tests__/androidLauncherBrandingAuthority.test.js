/**
 * Build 34 Android — Patch 2. Launcher branding authority.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * This repository commits its `android/` native project, so an Expo prebuild is
 * NOT part of the release path. `AndroidManifest.xml` resolves the launcher
 * through `@mipmap/ic_launcher` / `@mipmap/ic_launcher_round`, which means the
 * committed `android/app/src/main/res/mipmap-<density>/ic_launcher*.webp` bitmaps ARE
 * the launcher the user sees on a device. There is no `mipmap-anydpi-v26`
 * adaptive-icon XML in this project, so nothing else overrides them.
 *
 * That is how Build 34 shipped the wrong icon. `assets/icon.png` and
 * `assets/adaptive-icon.png` were restored to the approved K Scan AI branding
 * in 67b273e (2026-08-21), but the ten native mipmaps were left at the
 * "Android Beta v1.3" artwork they were generated from in 4f09e8c. The Expo
 * layer said one thing, the native layer shipped another, and nothing in the
 * suite noticed.
 *
 * TWO AUTHORITIES, ONE SOURCE
 * ---------------------------
 *   Expo-level branding source : assets/icon.png, assets/adaptive-icon.png
 *   Native release authority   : android/.../mipmap-<density>/ic_launcher*.webp
 *
 * The native mipmaps are derived from `assets/icon.png` (1024x1024, opaque,
 * byte-identical to the owner's approved master). Both are pinned below by
 * SHA-256, so the two authorities cannot drift apart again without this test
 * failing. A future agent must NOT assume a prebuild will regenerate them.
 *
 * MAINTENANCE
 * -----------
 * If the owner approves NEW branding, regenerate the mipmaps from the new
 * `assets/icon.png` and update BOTH the source hash and the five launcher
 * hashes in the same commit. Updating one without the other is the exact
 * drift this test exists to catch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

const abs = (...segments) => path.join(ROOT, ...segments);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/* ------------------------------------------------------------------ *
 * Governed constants
 * ------------------------------------------------------------------ */

/** The approved Expo-level branding source, and the derived-from file. */
const APPROVED_ICON_SOURCE = {
  file: 'assets/icon.png',
  sha256: '2609eb6eedd69bef794ca24db60f7132832b5e3ada915f33853e060f47dea59c',
  width: 1024,
  height: 1024,
};

/** The approved Android adaptive-icon foreground layer. */
const APPROVED_ADAPTIVE_FOREGROUND = {
  file: 'assets/adaptive-icon.png',
  sha256: '5b67f61c0c831528820a03f64df36d447f8fb6db7bc4af6d28e9fc3d126fb105',
  width: 1024,
  height: 1024,
};

/**
 * iOS negative control. Patch 2 is an Android repair; it must not modify or
 * repoint the iOS icon. This hash is the approved iOS asset as restored in
 * 67b273e.
 */
const IOS_ICON = {
  file: 'assets/images/kscan-ios-icon.png',
  sha256: '2f2053fdc8a60cf7a1478983081bb63389c4f25ab5f9825284aacc7d0605ff65',
  configuredPath: './assets/images/kscan-ios-icon.png',
};

/**
 * The governed native launcher set, derived from APPROVED_ICON_SOURCE.
 *
 * `ic_launcher_round` is INTENTIONALLY byte-identical to `ic_launcher` at each
 * density. That is what Expo's own generator produces for this project, and it
 * keeps the Expo and native authorities in agreement. Circular masking is a
 * branding decision, not a density-variant conversion, so Patch 2 does not
 * invent one -- it would crop the approved "SCAN" wordmark.
 */
const LAUNCHER_DENSITIES = [
  { density: 'mdpi', px: 48, sha256: '9c86771071ca4fc2eebbcb24420bbc170ae8aa87eb36538d5f9406b08421e12f' },
  { density: 'hdpi', px: 72, sha256: 'eceea820d5043a9d0fe0b8a5a18d2349fd7c697c68055b1e3013b35334ffb15b' },
  { density: 'xhdpi', px: 96, sha256: 'c878e55bd4680a2e9412c67913b650f504e8a5d52a6d019a7f676715ea045399' },
  { density: 'xxhdpi', px: 144, sha256: '9faf5387ef21c96fc19c9f3013544cda3ce549a3c323ce98a4dd3932b8f40cc8' },
  { density: 'xxxhdpi', px: 192, sha256: 'cd9ce274f31429375e1111a593a75301ef2af83191b5edfcee312ed59db0e920' },
];

/**
 * The retired "Android Beta v1.3" launcher bitmaps (dark purple / gold K).
 * These are the assets that actually installed on device before Patch 2. They
 * are named here so that a regression produces a diagnosis, not just a hash
 * mismatch.
 */
const RETIRED_LEGACY_HASHES = new Map([
  ['968738532297f515be983821989c94504a962bc0c3631a74a15d463ebb30c48c', 'mdpi 48x48'],
  ['bcc1a9d048e4c8aea46626e529a352c14f7d69d686a65307b73d068311127ae4', 'hdpi 72x72'],
  ['60eca926d3237968961e5616cba33c30a90a83d63280ee570a820f7acce47fc4', 'xhdpi 96x96'],
  ['ce15095d7c7614cac7196f5844c2d08adaf65508420b2379e348e07d2fffe608', 'xxhdpi 144x144'],
  ['cbb44ab805d49051bd2277ab961a39cf8fa2f06dfd8780d020269375f4882dae', 'xxxhdpi 192x192'],
]);

const launcherFiles = () => {
  const out = [];
  for (const entry of LAUNCHER_DENSITIES) {
    for (const base of ['ic_launcher', 'ic_launcher_round']) {
      out.push({
        ...entry,
        base,
        rel: `android/app/src/main/res/mipmap-${entry.density}/${base}.webp`,
      });
    }
  }
  return out;
};

/* ------------------------------------------------------------------ *
 * Minimal image header readers (no runtime dependency)
 * ------------------------------------------------------------------ */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(PNG_MAGIC), 'not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function webpSize(buffer) {
  assert.equal(buffer.subarray(0, 4).toString('latin1'), 'RIFF', 'not a RIFF container');
  assert.equal(buffer.subarray(8, 12).toString('latin1'), 'WEBP', 'not a WEBP');
  const chunk = buffer.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const read24 = (offset) =>
      buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
    return { width: read24(24) + 1, height: read24(27) + 1 };
  }
  throw new assert.AssertionError({ message: `unsupported WEBP chunk ${chunk}` });
}

/* ------------------------------------------------------------------ *
 * 1. Native manifest wiring
 * ------------------------------------------------------------------ */

test('launcher: AndroidManifest still resolves the governed mipmaps', () => {
  const manifest = fs.readFileSync(abs('android/app/src/main/AndroidManifest.xml'), 'utf8');

  assert.match(
    manifest,
    /android:icon="@mipmap\/ic_launcher"/,
    'android:icon must stay @mipmap/ic_launcher -- repointing it bypasses the governed launcher set',
  );
  assert.match(
    manifest,
    /android:roundIcon="@mipmap\/ic_launcher_round"/,
    'android:roundIcon must stay @mipmap/ic_launcher_round',
  );
});

test('launcher: no adaptive-icon XML silently overrides the governed bitmaps', () => {
  // A mipmap-anydpi-v26/ic_launcher.xml would take precedence over the bitmaps
  // on API 26+, moving the launcher authority somewhere this test does not
  // govern. If one is ever added, this test must be extended to cover it.
  const resDir = abs('android/app/src/main/res');
  const anydpi = fs
    .readdirSync(resDir)
    .filter((name) => name.startsWith('mipmap-') && name.includes('anydpi'));

  assert.deepEqual(
    anydpi,
    [],
    'an anydpi mipmap directory appeared -- the launcher authority moved and this gate no longer covers it',
  );
});

/* ------------------------------------------------------------------ *
 * 2. Expo wiring
 * ------------------------------------------------------------------ */

test('launcher: app.json points at the governed Expo branding sources', () => {
  const { expo } = JSON.parse(fs.readFileSync(abs('app.json'), 'utf8'));

  assert.equal(expo.icon, './assets/icon.png');
  assert.equal(expo.android.adaptiveIcon.foregroundImage, './assets/adaptive-icon.png');
});

test('launcher: app.json still points the iOS icon at its own approved asset', () => {
  const { expo } = JSON.parse(fs.readFileSync(abs('app.json'), 'utf8'));

  assert.equal(
    expo.ios.icon,
    IOS_ICON.configuredPath,
    'the Android launcher repair must not repoint the iOS icon',
  );
});

/* ------------------------------------------------------------------ *
 * 3. Approved source identity
 * ------------------------------------------------------------------ */

for (const source of [APPROVED_ICON_SOURCE, APPROVED_ADAPTIVE_FOREGROUND]) {
  test(`launcher: ${source.file} is the approved artwork`, () => {
    const file = abs(source.file);
    assert.ok(fs.existsSync(file), `${source.file} is missing`);
    assert.equal(
      sha256(file),
      source.sha256,
      `${source.file} changed. If the owner approved new branding, regenerate the ` +
        'five native mipmaps from it and update every hash in this file in the same commit.',
    );
    assert.deepEqual(pngSize(fs.readFileSync(file)), {
      width: source.width,
      height: source.height,
    });
  });
}

test('launcher: iOS icon is untouched by the Android repair (negative control)', () => {
  const file = abs(IOS_ICON.file);
  assert.ok(fs.existsSync(file), `${IOS_ICON.file} is missing`);
  assert.equal(sha256(file), IOS_ICON.sha256, 'the iOS icon must not change in an Android patch');
});

/* ------------------------------------------------------------------ *
 * 4. Native launcher set: completeness, identity, density integrity
 * ------------------------------------------------------------------ */

test('launcher: all ten governed native assets exist', () => {
  const missing = launcherFiles()
    .filter((entry) => !fs.existsSync(abs(entry.rel)))
    .map((entry) => entry.rel);

  assert.deepEqual(missing, [], `missing governed launcher assets: ${missing.join(', ')}`);
});

for (const entry of launcherFiles()) {
  test(`launcher: ${entry.rel} is the approved asset`, () => {
    const file = abs(entry.rel);
    assert.ok(fs.existsSync(file), `${entry.rel} is missing`);

    const actual = sha256(file);

    const legacy = RETIRED_LEGACY_HASHES.get(actual);
    assert.equal(
      legacy,
      undefined,
      `${entry.rel} is the RETIRED "Android Beta v1.3" launcher bitmap (${legacy}). ` +
        'The stale purple/gold icon came back -- regenerate from assets/icon.png.',
    );

    assert.equal(
      actual,
      entry.sha256,
      `${entry.rel} is not the approved launcher asset. Regenerate it from ` +
        'assets/icon.png rather than editing this hash.',
    );
  });

  test(`launcher: ${entry.rel} has correct ${entry.density} dimensions`, () => {
    const size = webpSize(fs.readFileSync(abs(entry.rel)));
    assert.deepEqual(
      size,
      { width: entry.px, height: entry.px },
      `${entry.density} launcher must be ${entry.px}x${entry.px}`,
    );
  });
}

test('launcher: round and standard variants are intentionally identical', () => {
  // Documented decision, not an accident: see LAUNCHER_DENSITIES above. If a
  // genuinely circular round icon is ever approved, this assertion is the one
  // to change -- deliberately, with the new artwork.
  for (const { density } of LAUNCHER_DENSITIES) {
    const standard = sha256(abs(`android/app/src/main/res/mipmap-${density}/ic_launcher.webp`));
    const round = sha256(abs(`android/app/src/main/res/mipmap-${density}/ic_launcher_round.webp`));

    assert.equal(round, standard, `mipmap-${density} round/standard pair drifted apart`);
  }
});

test('launcher: every density is a distinct rendition, not one bitmap copied', () => {
  const hashes = LAUNCHER_DENSITIES.map((entry) =>
    sha256(abs(`android/app/src/main/res/mipmap-${entry.density}/ic_launcher.webp`)),
  );

  assert.equal(
    new Set(hashes).size,
    LAUNCHER_DENSITIES.length,
    'two densities share a bitmap -- the set was not generated per density',
  );
});
