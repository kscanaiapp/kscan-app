const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const deepLinks = require('../services/roomDeepLinks');

test('room deep links parse canonical HTTPS and custom-scheme room URLs', () => {
  const https = deepLinks.parseRoomDeepLink(
    'https://kscan.app/rooms/5c5c1aa5-8b69-4a26-a11a-6454e0b4d0d4?utm_source=sms&user_id=private',
  );
  assert.equal(https.shareToken, '5c5c1aa5-8b69-4a26-a11a-6454e0b4d0d4');
  assert.deepEqual(https.attribution, { utm_source: 'sms' });

  const app = deepLinks.parseRoomDeepLink('kscan://rooms/share_token-123?invite_id=invite-1');
  assert.equal(app.shareToken, 'share_token-123');
  assert.deepEqual(app.attribution, { invite_id: 'invite-1' });
});

test('room fallback Open in App URL uses the custom scheme, not the HTTPS room URL', () => {
  const appUrl = deepLinks.buildRoomAppUrl('share_token-123', { utm_source: 'sms' });
  assert.equal(appUrl, 'kscan://rooms/share_token-123?utm_source=sms');
  assert.doesNotMatch(appUrl, /^https:\/\/kscan\.app\/rooms\//);

  const webUrl = deepLinks.buildRoomWebUrl('share_token-123');
  assert.equal(webUrl, 'https://kscan.app/rooms/share_token-123');
});

test('Expo config declares Android App Links and iOS associated domains for shared rooms', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const androidFilters = appJson.expo.android.intentFilters;

  assert.equal(appJson.expo.scheme, 'kscan');
  assert.equal(appJson.expo.android.package, 'com.kscanai.app');
  assert.ok(
    androidFilters.some((filter) =>
      filter.autoVerify === true &&
      filter.data?.some((entry) =>
        entry.scheme === 'https' &&
        entry.host === 'kscan.app' &&
        entry.pathPrefix === '/rooms',
      ),
    ),
  );
  assert.deepEqual(appJson.expo.ios.associatedDomains, ['applinks:kscan.app']);
});

test('checked-in Android manifest mirrors the verified room link intent filter', () => {
  const manifest = fs.readFileSync(
    path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8',
  );

  assert.match(manifest, /<intent-filter android:autoVerify="true">/);
  assert.match(manifest, /android:scheme="https"/);
  assert.match(manifest, /android:host="kscan\.app"/);
  assert.match(manifest, /android:pathPrefix="\/rooms"/);
});
