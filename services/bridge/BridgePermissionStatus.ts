/**
 * Bridge permission status checks (Phase 16 alpha).
 *
 * Query-only: this module NEVER requests permissions and never triggers
 * permission prompts. The debug screen's "Refresh Permissions" button only
 * reads the current status reported here.
 *
 * Conservative reporting for this phase:
 * - DAT permission is `not-configured` — the official Meta DAT SDK (and
 *   therefore its permission model) is not available.
 * - Bluetooth permission is `not-configured` — the app declares no
 *   Bluetooth permissions and no Bluetooth transport is implemented.
 * - Local network permission is `unknown` on iOS (no safe query API
 *   without a native module) and `not-required` on Android for the dev
 *   WebSocket transport (INTERNET permission is already declared).
 * - Microphone is `not-required` — the bridge does not use audio.
 *
 * No new native permissions are added in this phase. The Wi-Fi dev
 * transport does not require Bluetooth permissions.
 *
 * This module deliberately has no react-native import so it can run under
 * the Node test runner; callers (the debug screen) pass Platform.OS in.
 */

export type PermissionState =
  | 'unknown'
  | 'unavailable'
  | 'granted'
  | 'denied'
  | 'not-configured'
  | 'not-required';

export type BridgePermissionStatus = {
  datPermission: 'unknown' | 'unavailable' | 'granted' | 'denied' | 'not-configured';
  bluetoothPermission: 'unknown' | 'unavailable' | 'granted' | 'denied' | 'not-configured';
  localNetworkPermission: 'unknown' | 'unavailable' | 'granted' | 'denied' | 'not-required';
  microphonePermission: 'unknown' | 'unavailable' | 'granted' | 'denied' | 'not-required';
  checkedAt: string;
};

/**
 * Returns the current bridge-relevant permission status without prompting.
 * `platformOS` should be react-native's Platform.OS ('ios' | 'android' |
 * 'web'); when omitted, conservative `unknown` values are used.
 */
export async function getBridgePermissionStatus(
  platformOS?: string
): Promise<BridgePermissionStatus> {
  let localNetworkPermission: BridgePermissionStatus['localNetworkPermission'];
  if (platformOS === 'android') {
    // Dev WebSocket needs only the already-declared INTERNET permission.
    localNetworkPermission = 'not-required';
  } else {
    // iOS local-network permission has no safe query API without a native
    // module; unknown platforms stay conservative.
    localNetworkPermission = 'unknown';
  }

  return {
    // Official Meta DAT SDK is unavailable; its permission model is unknown.
    datPermission: 'not-configured',
    // No Bluetooth permissions are declared and no Bluetooth transport exists.
    bluetoothPermission: 'not-configured',
    localNetworkPermission,
    // The bridge does not record or transmit audio.
    microphonePermission: 'not-required',
    checkedAt: new Date().toISOString(),
  };
}
