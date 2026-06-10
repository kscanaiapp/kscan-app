/**
 * Bridge debug gate (Phase 16 alpha).
 *
 * The bridge debug screen must never be reachable in production builds.
 * It is enabled only when:
 *   - the bundle is a development bundle (__DEV__ === true), or
 *   - the dedicated env flag EXPO_PUBLIC_ENABLE_BRIDGE_DEBUG === 'true'
 *     is deliberately set for an internal/debug build.
 *
 * TestFlight / App Store review builds are release bundles without the
 * flag, so the gate stays closed there by default.
 */

type GateOverrides = {
  isDev?: boolean;
  envFlag?: string | undefined;
};

function readDevFlag(): boolean {
  // __DEV__ is injected by Metro in React Native bundles; it does not
  // exist under the Node test runner, where it safely reads undefined.
  const dev = (globalThis as { __DEV__?: boolean }).__DEV__;
  return dev === true;
}

function readEnvFlag(): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  return process.env.EXPO_PUBLIC_ENABLE_BRIDGE_DEBUG;
}

export function isBridgeDebugEnabled(overrides: GateOverrides = {}): boolean {
  const isDev = overrides.isDev ?? readDevFlag();
  const envFlag = 'envFlag' in overrides ? overrides.envFlag : readEnvFlag();
  return isDev || envFlag === 'true';
}
