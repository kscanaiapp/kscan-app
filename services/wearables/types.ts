import type { ScanRequest } from '../scan-contract/request';
import type { ScanResponse } from '../scan-contract/response';

export type WearableDeviceType =
  | 'meta_glasses'
  | 'android_xr'
  | 'wearable_mock';

export interface WearableSession {
  sessionId: string;
  deviceType: WearableDeviceType;
  createdAt: string;
  expiresAt: string;
  capabilities: {
    camera: boolean;
    microphone: boolean;
    display: boolean;
    audioOutput: boolean;
  };
}

export interface WearableTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendScanRequest(request: ScanRequest): Promise<ScanResponse>;
  getSession(): WearableSession | null;
}
