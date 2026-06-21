/**
 * Shared result types for K Scan Google Glasses bridge and phone app integration.
 */

export type CaptureSource = 'glasses' | 'phone' | 'mock';

export interface CapturedPhoto {
  base64: string;
  mimeType: string;
  source: CaptureSource;
}

export interface ProductMatch {
  id: string;
  name: string;
  retailer: string;
  price: string;
  imageUrl?: string | null;
  productUrl?: string | null;
  purchaseUrl?: string | null;
  affiliateUrl?: string | null;
}

export interface FashionMetadata {
  category?: string;
  color?: string;
  silhouette?: string;
}

export type AnalyzeResult =
  | {
      type: 'fashion';
      result: string;
      metadata: FashionMetadata;
      products: ProductMatch[];
    }
  | {
      type: 'non-fashion';
      message: string;
    };

export interface DeviceCapabilitiesSnapshot {
  hasDisplay: boolean;
  hasCamera: boolean;
  hasMicrophone: boolean;
  hasSpeaker: boolean;
  supportsProjectedContext: boolean;
  supportsBluetoothBridge: boolean;
  supportsWifiTransfer: boolean;
  supportsTouchpadOrGestureInput: boolean;
}

export interface DeviceStateSnapshot {
  connected: boolean;
  batteryPercent?: number;
  capabilities: DeviceCapabilitiesSnapshot;
  bridgeMode: 'mock' | 'phone' | 'google';
}
