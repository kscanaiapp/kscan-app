/**
 * Which Scanner views actually show the live camera.
 *
 * Camera permission gates the screen (app.js). It must gate only the views that
 * render the camera: the Scan landing (Upload Image, Describe an Item), photo
 * review, analysis and result views never touch it. Gating all of them left a
 * user who declined the camera on a dead-end screen with no route to the upload
 * path, and a photo picked from the gallery could not be shown once chosen.
 *
 * Pure, and kept in step with `renderContent` in app.js by
 * __tests__/scannerCameraRequirement.test.js.
 */

export type ScannerStatus =
  | 'idle'
  | 'capturing'
  | 'preview'
  | 'processing'
  | 'result'
  | 'non-fashion'
  | 'error';

export type ScannerCameraRequirementInput = {
  /** SCAN_ROOM_V2_UI_ENABLED: the landing + LiveScanCamera flow. */
  roomV2Ui: boolean;
  status: string;
  /** The user opened the live camera from the landing. */
  v2CameraVisible: boolean;
  /** A captured or uploaded image is in hand. */
  hasPhoto: boolean;
};

export function isScannerCameraRequired(input: ScannerCameraRequirementInput): boolean {
  // The legacy (flag-off) screens are unchanged: every one of them is the camera
  // screen or a preview reached through it, so the gate keeps applying.
  if (!input.roomV2Ui) return true;

  switch (input.status) {
    // Landing until the user taps Open Camera.
    case 'idle':
      return input.v2CameraVisible;
    case 'capturing':
      return true;
    // Review of a picked/captured image, or back to the landing/camera when
    // there is no image to show.
    case 'preview':
    case 'non-fashion':
    case 'error':
      return !input.hasPhoto && input.v2CameraVisible;
    case 'processing':
    case 'result':
      return false;
    // An unknown status renders the camera screen (renderContent's default).
    default:
      return true;
  }
}
