import { useEffect } from 'react';

import { acquireCameraLease } from '../../services/cameraOwnership';

/**
 * Renders nothing. Mounted next to the Scanner's expo-camera view so the
 * app-wide camera ownership record knows the Scanner holds the camera for
 * exactly as long as that view is mounted. See services/cameraOwnership.ts.
 */
export function ScannerCameraLease() {
  useEffect(() => {
    const lease = acquireCameraLease('scanner');
    return () => lease?.release();
  }, []);
  return null;
}
