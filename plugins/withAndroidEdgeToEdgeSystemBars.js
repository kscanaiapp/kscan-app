'use strict';

const {
  createRunOncePlugin,
  withAndroidStyles,
  withGradleProperties,
} = require('expo/config-plugins');

const {
  removeOwnedSystemBarColors,
  removeDeprecatedEdgeToEdgeProperty,
  isEdgeToEdgeEnabled,
  SUPPORTED_EDGE_TO_EDGE_PROPERTY,
} = require('./androidEdgeToEdgeContract');

/**
 * Runs after Expo's own splash/status-bar and edge-to-edge plugins and restores the
 * B29-EDGE-001 end state: `react-native-edge-to-edge` owns the system bars, and K Scan
 * declares no colour of its own.
 */
const withAndroidEdgeToEdgeSystemBars = (config) => {
  config = withAndroidStyles(config, (innerConfig) => {
    innerConfig.modResults = removeOwnedSystemBarColors(innerConfig.modResults);
    return innerConfig;
  });

  return withGradleProperties(config, (innerConfig) => {
    innerConfig.modResults = removeDeprecatedEdgeToEdgeProperty(innerConfig.modResults);

    if (!isEdgeToEdgeEnabled(innerConfig.modResults)) {
      throw new Error(
        `${SUPPORTED_EDGE_TO_EDGE_PROPERTY} is not true in gradle.properties; refusing to ` +
          'drop the deprecated compat property while edge-to-edge is off',
      );
    }

    return innerConfig;
  });
};

module.exports = createRunOncePlugin(
  withAndroidEdgeToEdgeSystemBars,
  'with-android-edge-to-edge-system-bars',
  '1.0.0',
);
