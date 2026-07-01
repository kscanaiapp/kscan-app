export const APP_BUILD_LABEL = 'Android Beta v1.5.2';
export const DEV_FALLBACK_STATUS = 'false';
export const QA_TOOLS_ENABLED =
  typeof __DEV__ !== 'undefined' && __DEV__ === true;

// Enables the single safe scan-failure diagnostic line (logScanFailure) in
// non-dev builds when EXPO_PUBLIC_SCAN_DIAG=1 (Expo inlines EXPO_PUBLIC_* at
// build time). Always on in dev. Does NOT enable any broad/prod logging.
export const SCAN_DIAGNOSTICS_ENABLED =
  (typeof __DEV__ !== 'undefined' && __DEV__ === true) ||
  process.env.EXPO_PUBLIC_SCAN_DIAG === '1';
