import { SCAN_CONTRACT_VERSION } from './version';

/**
 * Supported scan input sources. Includes a wearable mock source so the
 * contract can be exercised without real glasses hardware.
 */
export type ScanSource =
  | 'mobile_camera'
  | 'mobile_upload'
  | 'text_scan'
  | 'wearable_mock';

export type PrivacySanitizerMode =
  | 'passthrough'
  | 'masked'
  | 'metadata_only';

export type DeviceClass =
  | 'mobile'
  | 'meta_glasses'
  | 'android_xr'
  | 'wearable_mock';

export interface ScanImageInput {
  base64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  width?: number;
  height?: number;
}

export interface ScanPrivacyContext {
  sanitizerVersion: string;
  mode: PrivacySanitizerMode;
  faceDetectionPerformed: boolean;
  faceMaskApplied: boolean;
  plateDetectionPerformed?: boolean;
  plateMaskApplied?: boolean;
}

export interface ScanDeviceContext {
  deviceClass: DeviceClass;
  platform?: string;
  appVersion?: string;
}

export interface ScanRequest {
  contractVersion: string;
  requestId: string;
  source: ScanSource;
  image?: ScanImageInput;
  textQuery?: string;
  privacy: ScanPrivacyContext;
  device?: ScanDeviceContext;
}

/**
 * Generate a non-identifying request id. Does not contain PII.
 */
export function createScanRequestId(): string {
  const ts = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `scan-${ts}-${random}`;
}

/**
 * Build a minimal valid image scan request. Privacy context defaults to
 * the honest current-mobile pass-through mode.
 */
export function buildScanRequest(
  source: ScanSource,
  input: { image?: ScanImageInput; textQuery?: string; privacy?: Partial<ScanPrivacyContext>; device?: ScanDeviceContext },
): ScanRequest {
  return {
    contractVersion: SCAN_CONTRACT_VERSION,
    requestId: createScanRequestId(),
    source,
    image: input.image,
    textQuery: input.textQuery,
    privacy: {
      sanitizerVersion: '1.0.0',
      mode: 'passthrough',
      faceDetectionPerformed: false,
      faceMaskApplied: false,
      plateDetectionPerformed: false,
      plateMaskApplied: false,
      ...input.privacy,
    },
    device: input.device,
  };
}
