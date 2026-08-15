'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const deepLinks = require('../services/roomDeepLinks');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';

/** Parses MainActivity's intent-filters into a comparable shape. */
function intentFilters() {
  const manifest = read(MANIFEST);
  const activity = /<activity android:name="\.MainActivity"[\s\S]*?<\/activity>/.exec(manifest);
  assert.ok(activity, 'MainActivity not found in the manifest');

  return [...activity[0].matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g)].map(
    ([, attributes, body]) => ({
      autoVerify: /android:autoVerify="true"/.test(attributes),
      generated: /data-generated="true"/.test(attributes),
      actions: [...body.matchAll(/<action android:name="android\.intent\.action\.(\w+)"\/>/g)].map(
        (m) => m[1],
      ),
      categories: [
        ...body.matchAll(/<category android:name="android\.intent\.category\.(\w+)"\/>/g),
      ].map((m) => m[1]),
      data: [...body.matchAll(/<data([^>]*)\/>/g)].map(([, attrs]) =>
        Object.fromEntries(
          [...attrs.matchAll(/android:(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
        ),
      ),
    }),
  );
}

test('exactly one verified App Link owns https://kscan.app/rooms', () => {
  const roomFilters = intentFilters().filter((filter) =>
    filter.data.some((d) => d.pathPrefix === '/rooms'),
  );

  // Duplication is the failure mode this guards: Expo only replaces filters tagged
  // data-generated, so an untagged committed copy leaves /rooms declared twice.
  assert.equal(roomFilters.length, 1, 'https://kscan.app/rooms must be declared exactly once');

  const [rooms] = roomFilters;
  assert.equal(rooms.autoVerify, true);
  assert.deepEqual(rooms.actions, ['VIEW']);
  assert.deepEqual(rooms.data, [{ scheme: 'https', host: 'kscan.app', pathPrefix: '/rooms' }]);
  assert.deepEqual([...rooms.categories].sort(), ['BROWSABLE', 'DEFAULT']);
});

test('app.json is the single authority for every deep-link filter', () => {
  const declared = JSON.parse(read('app.json')).expo.android.intentFilters;
  const generated = intentFilters().filter((filter) => filter.generated);
  const launcher = intentFilters().filter((filter) => filter.actions.includes('MAIN'));

  assert.equal(generated.length, declared.length);
  assert.equal(launcher.length, 1);
  assert.equal(launcher[0].generated, false, 'the launcher filter is not app.json-owned');

  for (const filter of declared) {
    const match = generated.filter(
      (candidate) =>
        candidate.actions.includes(filter.action) &&
        JSON.stringify(candidate.data) === JSON.stringify(filter.data),
    );
    assert.equal(match.length, 1, `app.json filter for ${JSON.stringify(filter.data)} is not 1:1`);
    assert.equal(match[0].autoVerify, filter.autoVerify === true);
  }
});

test('the custom scheme is a fallback, never an autoVerify App Link', () => {
  const scheme = intentFilters().filter((filter) => filter.data.some((d) => d.scheme === 'kscan'));

  assert.equal(scheme.length, 1);
  assert.equal(scheme[0].autoVerify, false, 'a custom scheme cannot be domain-verified');
});

test('sharing stays on HTTPS so a device without the app falls back to the browser', () => {
  const token = 'share_token-123';

  assert.equal(deepLinks.buildRoomWebUrl(token), `https://kscan.app/rooms/${token}`);
  assert.equal(deepLinks.buildRoomAppUrl(token), `kscan://rooms/${token}`);

  // The HTTPS form is what the manifest verifies, so the same URL either resolves
  // into the app or renders the web room page.
  const parsed = deepLinks.parseRoomDeepLink(deepLinks.buildRoomWebUrl(token));
  assert.equal(parsed.shareToken, token);
});

test('the browsable https query is declared so link handoff can be resolved', () => {
  const manifest = read(MANIFEST);
  const queries = /<queries>[\s\S]*?<\/queries>/.exec(manifest);

  assert.ok(queries, 'package visibility <queries> block is missing');
  assert.match(queries[0], /android:scheme="https"/);
  assert.match(queries[0], /android\.intent\.category\.BROWSABLE/);
});

test('the verified host matches the domain that serves the asset links file', () => {
  const hosts = new Set(
    intentFilters()
      .filter((f) => f.autoVerify)
      .flatMap((f) => f.data.map((d) => d.host)),
  );

  // assetlinks.json is served from the apex domain, so every autoVerify filter has to
  // name that exact host: Android verifies per-host and does not follow www redirects.
  assert.deepEqual([...hosts], ['kscan.app']);
});
