'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contract = require('../plugins/androidNativeDeclarationContract');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

const MAIN_MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const RELEASE_MANIFEST = 'android/app/src/release/AndroidManifest.xml';

/** Permissions declared for real (no manifest-merger removal tombstone). */
function grantedPermissions(manifest) {
  return [...manifest.matchAll(/<uses-permission\s+android:name="([\w.]+)"\s*\/>/g)].map((m) => m[1]);
}

/** Permissions carrying a `tools:node="remove"` merge tombstone. */
function blockedPermissions(manifest) {
  return [
    ...manifest.matchAll(/<uses-permission\s+android:name="([\w.]+)"\s+tools:node="remove"\s*\/>/g),
  ].map((m) => m[1]);
}

test('app.json is the authority for the Android permission set', () => {
  const android = readJson('app.json').expo.android;

  assert.deepEqual(android.permissions, contract.GRANTED_PERMISSIONS);
  assert.deepEqual(android.blockedPermissions, contract.BLOCKED_PERMISSIONS);
});

test('a prebuild re-applies the foreground-service removals', () => {
  const plugins = readJson('app.json').expo.plugins;

  assert.ok(
    plugins.includes('./plugins/withRemoveUnusedForegroundServices'),
    'app.json must register the foreground-service removal plugin so `expo prebuild` ' +
      'reproduces the committed manifest instead of restoring dependency services',
  );
});

test('the committed main manifest declares exactly the granted permissions', () => {
  const manifest = read(MAIN_MANIFEST);

  assert.deepEqual(grantedPermissions(manifest), contract.GRANTED_PERMISSIONS);
});

test('the committed main manifest tombstones every blocked permission', () => {
  const manifest = read(MAIN_MANIFEST);

  assert.deepEqual(blockedPermissions(manifest), contract.BLOCKED_PERMISSIONS);
});

test('no foreground-service permission or service reaches the app manifest', () => {
  const manifest = read(MAIN_MANIFEST);
  const granted = new Set(grantedPermissions(manifest));

  for (const permission of granted) {
    assert.doesNotMatch(
      permission,
      /FOREGROUND_SERVICE/,
      `${permission} is granted; K Scan Build 29 starts no foreground service`,
    );
  }

  // Every <service> in the app manifest must be a removal tombstone: K Scan owns
  // no service of its own, so anything else is a dependency service leaking in.
  const services = [...manifest.matchAll(/<service\s+([^>]*?)\/>/g)].map((m) => m[1]);
  assert.equal(services.length, contract.REMOVED_FOREGROUND_SERVICES.length);
  for (const attributes of services) {
    assert.match(attributes, /tools:node="remove"/);
  }

  const declared = services.map((a) => /android:name="([\w.]+)"/.exec(a)[1]);
  assert.deepEqual(declared, contract.REMOVED_FOREGROUND_SERVICES);
  assert.doesNotMatch(manifest, /foregroundServiceType/);
});

test('the release variant re-blocks the forbidden permissions as defence in depth', () => {
  const blocked = new Set(blockedPermissions(read(RELEASE_MANIFEST)));

  for (const permission of [
    ...contract.RELEASE_ONLY_BLOCKED_PERMISSIONS,
    ...contract.BLOCKED_PERMISSIONS,
  ]) {
    assert.ok(blocked.has(permission), `release manifest does not block ${permission}`);
  }
  assert.equal(grantedPermissions(read(RELEASE_MANIFEST)).length, 0);
});

test('the foreground-service transform is idempotent and namespace-safe', () => {
  const manifest = () => ({
    manifest: { $: {}, application: [{ $: { 'android:name': '.MainApplication' } }] },
  });

  const once = contract.removeUnusedForegroundServices(manifest());
  const twice = contract.removeUnusedForegroundServices(
    contract.removeUnusedForegroundServices(manifest()),
  );

  assert.equal(once.manifest.$['xmlns:tools'], contract.TOOLS_NAMESPACE);
  assert.deepEqual(twice, once);
  assert.deepEqual(
    once.manifest.application[0].service.map((s) => s.$['android:name']),
    contract.REMOVED_FOREGROUND_SERVICES,
  );
  for (const service of once.manifest.application[0].service) {
    assert.equal(service.$['tools:node'], 'remove');
  }
});

test('an existing dependency service declaration is converted into a removal', () => {
  const androidManifest = {
    manifest: {
      $: {},
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          service: [
            {
              $: {
                'android:name': 'expo.modules.audio.service.AudioControlsService',
                'android:foregroundServiceType': 'mediaPlayback',
              },
            },
          ],
        },
      ],
    },
  };

  const result = contract.removeUnusedForegroundServices(androidManifest);
  const services = result.manifest.application[0].service;

  assert.equal(services.length, contract.REMOVED_FOREGROUND_SERVICES.length);
  const audioControls = services.find(
    (s) => s.$['android:name'] === 'expo.modules.audio.service.AudioControlsService',
  );
  assert.equal(audioControls.$['tools:node'], 'remove');
});
