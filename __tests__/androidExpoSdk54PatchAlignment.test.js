'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

// B34-DEF-003: Android carried an outdated Expo SDK 54 patch trio while iOS
// was already aligned. This is a narrow drift guard, not a general version
// pin — it only asserts the three packages the finding named.
const REQUIRED_VERSIONS = {
  expo: '~54.0.37',
  'expo-constants': '~18.0.14',
  'expo-file-system': '~19.0.24',
};

test('B34-DEF-003: Android package.json declares the aligned Expo SDK 54 patch versions', () => {
  const pkg = require(path.join('..', 'package.json'));
  for (const [name, expected] of Object.entries(REQUIRED_VERSIONS)) {
    assert.equal(
      pkg.dependencies[name],
      expected,
      `${name} should be pinned to ${expected} (SDK 54 alignment) but package.json declares ${pkg.dependencies[name]}`,
    );
  }
});
