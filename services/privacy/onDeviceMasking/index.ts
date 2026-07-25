export type {
  BoundingBox,
  PiiRegionType,
  DetectedPiiRegion,
  DetectionResult,
  RgbaImageBuffer,
  MaskingResult,
  OnDevicePrivacyResult,
  LocalImageCodec,
  OnDevicePiiDetector,
  DecodedPipelineInput,
  EncodedPipelineInput,
} from './types';

export {
  OnDevicePrivacyError,
  UnsupportedCodecError,
  UnsupportedDetectorError,
  InvalidBufferError,
  MaskingVerificationError,
} from './errors';

export {
  validateBox,
  boxArea,
  intersectionArea,
  unionArea,
  boxIoU,
  deduplicateRegions,
} from './boundingBoxes';

export { maskRgbaRegions } from './rgbaMasking';
export { verifyMasking, verifyMaskingResult } from './verifyMasking';

export { unsupportedFaceDetector, unsupportedLicensePlateDetector } from './unsupportedDetectors';
export { syntheticFaceDetector, syntheticLicensePlateDetector } from './syntheticDetectors';
export { unsupportedLocalImageCodec } from './unsupportedCodec';

export { runDecodedRgbaPrivacyPipeline, runEncodedImagePrivacyPipeline } from './pipeline';
export { toPrivacySanitizerResult } from './adapter';
