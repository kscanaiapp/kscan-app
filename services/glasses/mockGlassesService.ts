// TODO(Glasses-Backend-Integration): After backend consolidation completes,
// replace mockGlassesService.analyze() with the canonical gateway-backed call.
// DO NOT import aiGateway or scan-identify directly from this prototype layer.
// Expected canonical endpoint: POST /api/glasses/analyze-debug
// Expected result shape: FashionAnalyzeResult (align with native Android repo)

import type {
  GlassesCaptureInput,
  GlassesMockResult,
  GlassesAnalysisError,
} from '../../types/glasses';

const MOCK_RESULTS: Record<string, GlassesMockResult> = {
  'jacket-black': {
    id: 'mock-jacket-001',
    title: 'Oversized Black Jacket',
    summary:
      'A structured oversized black jacket with strong shoulders and a relaxed silhouette.',
    category: 'jacket',
    color: 'black',
    silhouette: 'oversized',
    confidence: 0.92,
    privacyStatus: 'local_only',
    createdAt: new Date().toISOString(),
  },
  'dress-red': {
    id: 'mock-dress-002',
    title: 'Floral Midi Dress',
    summary:
      'A flowing midi-length dress with a soft floral print and cinched waist.',
    category: 'dress',
    color: 'red',
    silhouette: 'midi',
    confidence: 0.88,
    privacyStatus: 'local_only',
    createdAt: new Date().toISOString(),
  },
  default: {
    id: 'mock-default',
    title: 'Fashion Item Detected',
    summary:
      'This is a safe mock response for the glasses prototype preview.',
    category: 'unknown',
    confidence: 0.0,
    privacyStatus: 'local_only',
    createdAt: new Date().toISOString(),
  },
};

const MOCK_DELAY_MS = 400;

function resolveMockResult(input: GlassesCaptureInput): GlassesMockResult {
  const key = input.mockTriggerId ?? 'default';
  const result = MOCK_RESULTS[key] ?? MOCK_RESULTS['default'];
  return {
    ...result,
    id: `${result.id}-${Date.now()}`,
    createdAt: new Date().toISOString(),
  };
}

export async function analyze(
  input: GlassesCaptureInput
): Promise<GlassesMockResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(resolveMockResult(input));
    }, MOCK_DELAY_MS);
  });
}

export function analyzeWithError(): Promise<never> {
  return Promise.reject(
    new Error(
      JSON.stringify({
        code: 'GLASSES_ANALYZE_ERROR',
        message: 'The image could not be analyzed.',
      } as GlassesAnalysisError)
    )
  );
}
