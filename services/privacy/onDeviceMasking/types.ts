/**
 * On-device PII masking POC types.
 *
 * These types intentionally contain no user identity, biometric templates,
 * demographic inference, plate text, or persistent device identifiers.
 */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PiiRegionType = 'face' | 'license_plate';

export interface DetectedPiiRegion {
  type: PiiRegionType;
  box: BoundingBox;
  confidence?: number;
  detectorVersion: string;
}

export interface DetectionResult {
  attempted: boolean;
  completed: boolean;
  supported: boolean;
  regions: DetectedPiiRegion[];
  warnings: string[];
  durationMs?: number;
}

export interface RgbaImageBuffer {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface MaskingResult {
  attempted: boolean;
  completed: boolean;
  regionsRequested: number;
  regionsMasked: number;
  inputHash: string;
  outputHash: string;
  pixelsChanged: boolean;
  output?: RgbaImageBuffer;
  warnings: string[];
  durationMs?: number;
}

export interface OnDevicePrivacyResult {
  faceDetection: DetectionResult;
  plateDetection: DetectionResult;
  masking: MaskingResult;
  safeForTransmission: boolean;
  sanitizerVersion: string;
  failureReasons: string[];
}

export interface LocalImageCodec {
  readonly codecVersion: string;
  readonly supported: boolean;

  decode(input: {
    imageUri?: string;
    base64?: string;
    mimeType: string;
  }): Promise<RgbaImageBuffer>;

  encode(input: RgbaImageBuffer): Promise<{
    outputUri?: string;
    outputBase64?: string;
    mimeType: string;
  }>;
}

export interface OnDevicePiiDetector {
  readonly detectorVersion: string;
  readonly regionType: PiiRegionType;
  readonly supported: boolean;

  detect(input: {
    imageUri?: string;
    base64?: string;
    mimeType?: string;
    rgba?: RgbaImageBuffer;
  }): Promise<DetectionResult>;
}

export interface DecodedPipelineInput {
  rgba: RgbaImageBuffer;
  detectors: {
    face?: OnDevicePiiDetector;
    plate?: OnDevicePiiDetector;
  };
  policy: {
    requireFaceDetection?: boolean;
    requirePlateDetection?: boolean;
    allowCleanNoDetection?: boolean;
  };
}

export interface EncodedPipelineInput {
  imageUri?: string;
  base64?: string;
  mimeType: string;
  codec: LocalImageCodec;
  detectors: {
    face?: OnDevicePiiDetector;
    plate?: OnDevicePiiDetector;
  };
  policy: {
    requireFaceDetection?: boolean;
    requirePlateDetection?: boolean;
    allowCleanNoDetection?: boolean;
  };
}
