export const APP_BUILD_LABEL = 'v1.0.1';
export const DEV_FALLBACK_STATUS = 'false';
export const QA_TOOLS_ENABLED =
  typeof __DEV__ !== 'undefined' && __DEV__ === true;

// Enables the single safe scan-failure diagnostic line (logScanFailure) in
// non-dev builds when EXPO_PUBLIC_SCAN_DIAG=1 (Expo inlines EXPO_PUBLIC_* at
// build time). Always on in dev. Does NOT enable any broad/prod logging.
export const SCAN_DIAGNOSTICS_ENABLED =
  (typeof __DEV__ !== 'undefined' && __DEV__ === true) ||
  process.env.EXPO_PUBLIC_SCAN_DIAG === '1';

// Gated diagnostic logging for the scan title builder.
//
// REQUIRES DEVELOPMENT MODE. This previously keyed off the environment alone,
// so an EXPO_PUBLIC_* variable — which Expo inlines at build time and which is
// set from eas.json, CI, or a shell — could switch diagnostic logging on in a
// STORE BUILD. A debug escape whose only gate is a string in the build
// environment is one configuration mistake away from shipping.
//
// `__DEV__ && explicit flag`: the flag alone can no longer do it, and a
// production bundle has no path to enable it at all. Note the other constants
// here already follow this shape (QA_TOOLS_ENABLED), so this brings the odd one
// out into line rather than inventing a rule.
//
// Does not log image bytes or secrets.
export const SCAN_IDENTITY_DEBUG =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ === true &&
  (process.env.EXPO_PUBLIC_SCAN_IDENTITY_DEBUG === 'true' ||
    process.env.SCAN_IDENTITY_DEBUG === 'true');
