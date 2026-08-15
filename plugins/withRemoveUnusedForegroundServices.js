'use strict';

const { createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const {
  removeUnusedForegroundServices,
  REMOVED_FOREGROUND_SERVICES,
} = require('./androidNativeDeclarationContract');

/**
 * Reproduces, on every Expo prebuild, the foreground-service removals the
 * committed `android/app/src/main/AndroidManifest.xml` already performs.
 *
 * Expo's `android.blockedPermissions` covers the permission half of the
 * contract but has no equivalent for `<service>` merge tombstones, so this is
 * the only piece that still needs a config plugin.
 */
const withRemoveUnusedForegroundServices = (config) =>
  withAndroidManifest(config, (innerConfig) => {
    innerConfig.modResults = removeUnusedForegroundServices(innerConfig.modResults);
    return innerConfig;
  });

module.exports = createRunOncePlugin(
  withRemoveUnusedForegroundServices,
  'with-remove-unused-foreground-services',
  '2.0.0',
);

// Re-exported so the regression suite can assert the contract without Expo.
module.exports.removeUnusedForegroundServices = removeUnusedForegroundServices;
module.exports.UNUSED_FOREGROUND_SERVICES = REMOVED_FOREGROUND_SERVICES;
