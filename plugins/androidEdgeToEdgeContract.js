'use strict';

/**
 * Build 29 audit finding B29-EDGE-001 removed every K Scan-owned Android system-bar
 * declaration so that `react-native-edge-to-edge` owns the bars outright. Expo's own
 * prebuild puts two of them straight back:
 *
 *   1. `withAndroidSplashScreen` copies `splash.backgroundColor` into
 *      `androidStatusBar.backgroundColor` whenever the app config leaves that key
 *      unset, which makes `withStatusBar` emit `android:statusBarColor` into AppTheme
 *      and rewrite `@color/colorPrimaryDark`. There is no app-config value that
 *      suppresses this: the splash plugin fills the key in before the status-bar
 *      plugin can read it.
 *   2. `withEdgeToEdgeEnabledGradleProperties` writes the deprecated
 *      `expo.edgeToEdgeEnabled` property alongside the supported `edgeToEdgeEnabled`.
 *      React Native's Gradle plugin reads only `edgeToEdgeEnabled` /
 *      `react.edgeToEdgeEnabled` (see PropertyUtils.kt), so the prefixed copy is dead
 *      weight that Expo SDK 55 removes anyway.
 *
 * Neither is expressible as app-config input, so K Scan owns the end state instead.
 * Dependency-free so the regression suite can assert it without a native toolchain.
 */

/** Owned system-bar attributes that must not appear in the Android theme. */
const FORBIDDEN_THEME_ITEMS = ['android:statusBarColor', 'android:navigationBarColor'];

/** The Gradle property React Native actually reads for edge-to-edge. */
const SUPPORTED_EDGE_TO_EDGE_PROPERTY = 'edgeToEdgeEnabled';

/** Expo's deprecated compat copy, removed in SDK 55. */
const DEPRECATED_EDGE_TO_EDGE_PROPERTY = 'expo.edgeToEdgeEnabled';

/**
 * Strips owned system-bar colours from every style group in a parsed styles.xml.
 * Idempotent: running it twice is the same as running it once.
 */
function removeOwnedSystemBarColors(styles) {
  const groups = (styles && styles.resources && styles.resources.style) || [];

  for (const group of groups) {
    if (!Array.isArray(group.item)) continue;
    group.item = group.item.filter(
      (item) => !(item && item.$ && FORBIDDEN_THEME_ITEMS.includes(item.$.name)),
    );
  }

  return styles;
}

/**
 * Drops the deprecated `expo.edgeToEdgeEnabled` property, and the comment Expo writes
 * immediately above it, from parsed gradle.properties. Leaves the supported property
 * untouched. Idempotent.
 */
function removeDeprecatedEdgeToEdgeProperty(properties) {
  const index = properties.findIndex(
    (item) => item.type === 'property' && item.key === DEPRECATED_EDGE_TO_EDGE_PROPERTY,
  );
  if (index === -1) return properties;

  const previous = properties[index - 1];
  const start = previous && previous.type === 'comment' && /deprecated/i.test(previous.value)
    ? index - 1
    : index;

  return [...properties.slice(0, start), ...properties.slice(index + 1)];
}

/** True when edge-to-edge is on via the property React Native reads. */
function isEdgeToEdgeEnabled(properties) {
  const property = properties.find(
    (item) => item.type === 'property' && item.key === SUPPORTED_EDGE_TO_EDGE_PROPERTY,
  );
  return Boolean(property) && String(property.value).trim() === 'true';
}

module.exports = {
  FORBIDDEN_THEME_ITEMS,
  SUPPORTED_EDGE_TO_EDGE_PROPERTY,
  DEPRECATED_EDGE_TO_EDGE_PROPERTY,
  removeOwnedSystemBarColors,
  removeDeprecatedEdgeToEdgeProperty,
  isEdgeToEdgeEnabled,
};
