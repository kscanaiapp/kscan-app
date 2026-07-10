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

// Gated diagnostic logging for the scan title builder. Off in production unless
// explicitly enabled via env. Does not log image bytes or secrets.
export const SCAN_IDENTITY_DEBUG =
  process.env.EXPO_PUBLIC_SCAN_IDENTITY_DEBUG === 'true' ||
  process.env.SCAN_IDENTITY_DEBUG === 'true';
