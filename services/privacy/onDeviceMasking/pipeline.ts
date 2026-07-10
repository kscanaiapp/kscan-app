import type {
  DecodedPipelineInput,
  EncodedPipelineInput,
  OnDevicePrivacyResult,
  DetectionResult,
  DetectedPiiRegion,
  MaskingResult,
} from './types';
import { maskRgbaRegions } from './rgbaMasking';
import { deduplicateRegions } from './boundingBoxes';
import { verifyMasking } from './verifyMasking';

const SANITIZER_VERSION = 'on-device-poc-1.0.0';

function collectRegions(...results: DetectionResult[]): DetectedPiiRegion[] {
  return results
    .filter((r) => r.completed && Array.isArray(r.regions))
    .flatMap((r) => r.regions);
}

function runDetection(
  detector: DetectionResult | undefined,
  required: boolean | undefined,
  detectorName: string,
): { result: DetectionResult; failureReasons: string[] } {
  const result = detector ?? {
    attempted: false,
    completed: false,
    supported: false,
    regions: [],
    warnings: [`No ${detectorName} detector was supplied.`],
  };

  const failureReasons: string[] = [];
  if (required && !result.completed) {
    failureReasons.push(`${detectorName} detection is required but is not supported or did not complete.`);
  }

  return { result, failureReasons };
}

async function safeDetect(
  detector: import('./types').OnDevicePiiDetector | undefined,
  input: { rgba?: import('./types').RgbaImageBuffer; imageUri?: string; base64?: string; mimeType?: string },
): Promise<DetectionResult> {
  if (!detector) {
    return {
      attempted: false,
      completed: false,
      supported: false,
      regions: [],
      warnings: ['No detector supplied.'],
    };
  }
  try {
    return await detector.detect(input);
  } catch (err) {
    return {
      attempted: true,
      completed: false,
      supported: detector.supported,
      regions: [],
      warnings: [`Detector failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

function buildFailureResult(
  face: DetectionResult,
  plate: DetectionResult,
  failureReasons: string[],
): OnDevicePrivacyResult {
  return {
    faceDetection: face,
    plateDetection: plate,
    masking: {
      attempted: false,
      completed: false,
      regionsRequested: 0,
      regionsMasked: 0,
      inputHash: '',
      outputHash: '',
      pixelsChanged: false,
      output: undefined,
      warnings: [],
    },
    safeForTransmission: false,
    sanitizerVersion: SANITIZER_VERSION,
    failureReasons,
  };
}

/**
 * Run the decoded-buffer privacy pipeline.
 *
 * This path accepts an already-decoded RGBA buffer and detector providers.
 * It is intended for POC testing and future native codec integration.
 */
export async function runDecodedRgbaPrivacyPipeline(input: DecodedPipelineInput): Promise<OnDevicePrivacyResult> {
  const failureReasons: string[] = [];

  if (!input || typeof input !== 'object') {
    return buildFailureResult(
      { attempted: false, completed: false, supported: false, regions: [], warnings: [] },
      { attempted: false, completed: false, supported: false, regions: [], warnings: [] },
      ['Invalid pipeline input.'],
    );
  }

  const faceRun = runDetection(
    await safeDetect(input.detectors.face, { rgba: input.rgba }),
    input.policy.requireFaceDetection,
    'face',
  );
  failureReasons.push(...faceRun.failureReasons);

  const plateRun = runDetection(
    await safeDetect(input.detectors.plate, { rgba: input.rgba }),
    input.policy.requirePlateDetection,
    'license plate',
  );
  failureReasons.push(...plateRun.failureReasons);

  if (failureReasons.length > 0) {
    return buildFailureResult(faceRun.result, plateRun.result, failureReasons);
  }

  const rawRegions = collectRegions(faceRun.result, plateRun.result);

  // Deduplicate only same-type overlaps; cross-type overlaps are preserved.
  const regions = deduplicateRegions(rawRegions, 0.5);

  const masking = maskRgbaRegions(input.rgba, regions);

  if (masking.output) {
    const verification = verifyMasking(input.rgba, masking.output, regions);
    if (!verification.passed) {
      failureReasons.push(...verification.failures);
    }
  }

  const noRegions = regions.length === 0;
  const cleanAllowed = !!input.policy.allowCleanNoDetection && noRegions;

  // A no-region result is only safe when explicitly allowed and all required detectors completed.
  const safeForTransmission =
    failureReasons.length === 0 &&
    masking.completed &&
    masking.pixelsChanged === (regions.length > 0) &&
    (regions.length > 0 || cleanAllowed);

  if (noRegions && !cleanAllowed) {
    failureReasons.push('No PII regions detected and policy does not allow clean passthrough.');
  }

  return {
    faceDetection: faceRun.result,
    plateDetection: plateRun.result,
    masking,
    safeForTransmission,
    sanitizerVersion: SANITIZER_VERSION,
    failureReasons,
  };
}

/**
 * Run the encoded-image privacy pipeline.
 *
 * This path requires a real supported codec and real supported detectors.
 * It always returns `safeForTransmission: false` when any required component
 * is unsupported, because the POC does not install a real codec or detectors.
 */
export async function runEncodedImagePrivacyPipeline(input: EncodedPipelineInput): Promise<OnDevicePrivacyResult> {
  const failureReasons: string[] = [];

  if (!input.codec.supported) {
    failureReasons.push('Local image codec is not supported; cannot decode/encode the image.');
  }

  const faceRun = runDetection(
    await safeDetect(input.detectors.face, { imageUri: input.imageUri, base64: input.base64, mimeType: input.mimeType }),
    input.policy.requireFaceDetection,
    'face',
  );
  failureReasons.push(...faceRun.failureReasons);

  const plateRun = runDetection(
    await safeDetect(input.detectors.plate, { imageUri: input.imageUri, base64: input.base64, mimeType: input.mimeType }),
    input.policy.requirePlateDetection,
    'license plate',
  );
  failureReasons.push(...plateRun.failureReasons);

  if (failureReasons.length > 0) {
    return buildFailureResult(faceRun.result, plateRun.result, failureReasons);
  }

  // Encoded-image pipeline requires real supported detectors.
  if (input.policy.requireFaceDetection && !faceRun.result.supported) {
    failureReasons.push('Encoded-image face detection requires a supported real detector.');
  }
  if (input.policy.requirePlateDetection && !plateRun.result.supported) {
    failureReasons.push('Encoded-image plate detection requires a supported real detector.');
  }
  if (failureReasons.length > 0) {
    return buildFailureResult(faceRun.result, plateRun.result, failureReasons);
  }

  let rgba: import('./types').RgbaImageBuffer;
  try {
    rgba = await input.codec.decode({ imageUri: input.imageUri, base64: input.base64, mimeType: input.mimeType });
  } catch (err) {
    failureReasons.push(`Codec decode failed: ${err instanceof Error ? err.message : String(err)}`);
    return buildFailureResult(faceRun.result, plateRun.result, failureReasons);
  }

  const decodedResult = await runDecodedRgbaPrivacyPipeline({
    rgba,
    detectors: input.detectors,
    policy: input.policy,
  });

  if (decodedResult.failureReasons.length > 0) {
    return decodedResult;
  }

  if (!decodedResult.masking.output) {
    failureReasons.push('Decoded pipeline produced no masked output.');
    return buildFailureResult(faceRun.result, plateRun.result, failureReasons);
  }

  let encoded: { outputUri?: string; outputBase64?: string; mimeType: string };
  try {
    encoded = await input.codec.encode(decodedResult.masking.output);
  } catch (err) {
    failureReasons.push(`Codec encode failed: ${err instanceof Error ? err.message : String(err)}`);
    return buildFailureResult(faceRun.result, plateRun.result, failureReasons);
  }

  if (!encoded.outputUri && !encoded.outputBase64) {
    failureReasons.push('Codec produced no encoded output.');
    return buildFailureResult(faceRun.result, plateRun.result, failureReasons);
  }

  return {
    faceDetection: faceRun.result,
    plateDetection: plateRun.result,
    masking: decodedResult.masking,
    safeForTransmission: decodedResult.safeForTransmission,
    sanitizerVersion: SANITIZER_VERSION,
    failureReasons,
  };
}
