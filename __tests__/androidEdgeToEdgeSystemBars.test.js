'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contract = require('../plugins/androidEdgeToEdgeContract');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the edge-to-edge system-bar plugin is registered', () => {
  const plugins = JSON.parse(read('app.json')).expo.plugins;

  // Expo's splash plugin copies splash.backgroundColor into androidStatusBar and the
  // status-bar plugin then writes android:statusBarColor. No app-config value prevents
  // it, so the B29-EDGE-001 end state has to be re-asserted by a plugin of our own.
  assert.ok(plugins.includes('./plugins/withAndroidEdgeToEdgeSystemBars'));
});

test('K Scan declares no system-bar colour of its own', () => {
  const styles = read('android/app/src/main/res/values/styles.xml');

  for (const item of contract.FORBIDDEN_THEME_ITEMS) {
    assert.doesNotMatch(styles, new RegExp(`name="${item}"`), `${item} is owned by the theme`);
  }
});

test('the supported edge-to-edge property is on and the deprecated copy is absent', () => {
  const properties = read('android/gradle.properties');

  // React Native's Gradle plugin reads `edgeToEdgeEnabled` / `react.edgeToEdgeEnabled`
  // (PropertyUtils.kt). `expo.edgeToEdgeEnabled` is a compat copy Expo drops in SDK 55.
  assert.match(properties, /^edgeToEdgeEnabled=true$/m);
  assert.doesNotMatch(properties, /^expo\.edgeToEdgeEnabled=/m);
  assert.equal(JSON.parse(read('app.json')).expo.android.edgeToEdgeEnabled, true);
});

test('removeOwnedSystemBarColors strips only the owned bar colours, idempotently', () => {
  const styles = () => ({
    resources: {
      style: [
        {
          $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
          item: [
            { $: { name: 'colorPrimary' }, _: '@color/colorPrimary' },
            { $: { name: 'android:statusBarColor' }, _: '#09090b' },
            { $: { name: 'android:navigationBarColor' }, _: '#09090b' },
            { $: { name: 'android:editTextBackground' }, _: '@drawable/rn_edit_text_material' },
          ],
        },
      ],
    },
  });

  const once = contract.removeOwnedSystemBarColors(styles());
  const twice = contract.removeOwnedSystemBarColors(contract.removeOwnedSystemBarColors(styles()));

  assert.deepEqual(
    once.resources.style[0].item.map((i) => i.$.name),
    ['colorPrimary', 'android:editTextBackground'],
  );
  assert.deepEqual(twice, once);
});

test('removeDeprecatedEdgeToEdgeProperty drops the compat property and its comment', () => {
  const properties = [
    { type: 'property', key: 'hermesEnabled', value: 'true' },
    { type: 'comment', value: 'Specifies edge-to-edge\n# WARNING: This property has been deprecated' },
    { type: 'property', key: 'expo.edgeToEdgeEnabled', value: 'true' },
    { type: 'comment', value: 'Whether the project uses edge-to-edge' },
    { type: 'property', key: 'edgeToEdgeEnabled', value: 'true' },
  ];

  const result = contract.removeDeprecatedEdgeToEdgeProperty(properties);

  assert.deepEqual(
    result.filter((i) => i.type === 'property').map((i) => i.key),
    ['hermesEnabled', 'edgeToEdgeEnabled'],
  );
  assert.equal(result.filter((i) => i.type === 'comment').length, 1);
  assert.ok(contract.isEdgeToEdgeEnabled(result));
  assert.deepEqual(contract.removeDeprecatedEdgeToEdgeProperty(result), result);
});

test('an unrelated comment above the compat property is preserved', () => {
  const properties = [
    { type: 'comment', value: 'Enable the new architecture' },
    { type: 'property', key: 'expo.edgeToEdgeEnabled', value: 'true' },
    { type: 'property', key: 'edgeToEdgeEnabled', value: 'true' },
  ];

  const result = contract.removeDeprecatedEdgeToEdgeProperty(properties);

  assert.deepEqual(result, [
    { type: 'comment', value: 'Enable the new architecture' },
    { type: 'property', key: 'edgeToEdgeEnabled', value: 'true' },
  ]);
});

test('edge-to-edge being off is reported rather than silently accepted', () => {
  assert.equal(contract.isEdgeToEdgeEnabled([]), false);
  assert.equal(
    contract.isEdgeToEdgeEnabled([{ type: 'property', key: 'edgeToEdgeEnabled', value: 'false' }]),
    false,
  );
  assert.equal(
    contract.isEdgeToEdgeEnabled([{ type: 'property', key: 'edgeToEdgeEnabled', value: 'true\n' }]),
    true,
  );
});
