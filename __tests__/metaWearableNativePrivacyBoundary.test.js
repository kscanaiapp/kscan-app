'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Meta privacy uses the local native masker rather than a JavaScript ML Kit wrapper', () => {
  const privacy = read('services/metaWearablePrivacy.ts');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(privacy.includes("require('../modules/kscan-pii-native')"));
  assert.ok(privacy.includes('detectAndMaskFaces({ imageUri: normalized.uri })'));
  assert.ok(!privacy.includes('@react-native-ml-kit/face-detection'));
  assert.equal('@react-native-ml-kit/face-detection' in (pkg.dependencies ?? {}), false);
});

test('Meta privacy fails closed when the native masker is missing, fails, or returns an invalid artifact', () => {
  const privacy = read('services/metaWearablePrivacy.ts');
  assert.match(privacy, /if \(!native\?\.detectAndMaskFaces\) throw new MetaWearablePrivacyError\('PRIVACY_DETECTOR_FAILED'\)/);
  assert.match(privacy, /masked\.status === 'failed' \|\| masked\.status === 'unsupported'/);
  assert.match(privacy, /isLocalUri\(masked\.sanitizedUri\)/);
  assert.match(privacy, /masked\.outputWidth === normalized\.width/);
  assert.match(privacy, /Number\(masked\.facesMasked\) > 0/);
});
