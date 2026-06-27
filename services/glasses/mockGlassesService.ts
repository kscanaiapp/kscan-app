/**
 * services/glasses/mockGlassesService.ts
 *
 * Deterministic mock service for the isolated Google Glasses / XR prototype.
 *
 * Rules:
 * - No network calls.
 * - No Supabase.
 * - No auth / session.
 * - No backend.
 * - No phone bridge.
 * - No android-xr dependency.
 * - No real camera / microphone / BLE / WiFi dependency.
 * - Uses only local constants and types/glasses.ts.
 *
 * Future integration TODO: replace mock data with real backend calls
 * behind a feature flag after backend consolidation is complete.
 */

import {
  GlassesCaptureMode,
  GlassesConfidenceLevel,
  GlassesMockItem,
  GlassesMockResult,
  GlassesMockSession,
  GlassesMockError,
  GlassesMockAnalysisOutcome,
} from '../../types/glasses';

// ─── Local constants ───────────────────────────────────────────────────────

const MOCK_DELAY_MS = 400;

const MOCK_ITEMS: Record<string, GlassesMockItem> = {
  blazer: {
    label: 'Tailored Wool Blazer',
    brandGuess: 'Unbranded / similar to Acne Studios',
    colorGuess: 'Charcoal Grey',
    category: 'Outerwear',
    silhouette: 'Single-breasted, slim fit',
    confidence: 0.92,
    confidenceLevel: 'high',
  },
  sneakers: {
    label: 'Minimalist Leather Sneakers',
    brandGuess: 'Unbranded / similar to Common Projects',
    colorGuess: 'Off-White',
    category: 'Footwear',
    silhouette: 'Low-top, round toe',
    confidence: 0.88,
    confidenceLevel: 'high',
  },
  dress: {
    label: 'Midi Slip Dress',
    brandGuess: 'Unbranded / similar to Reformation',
    colorGuess: 'Sage Green',
    category: 'Dresses',
    silhouette: 'Bias-cut, midi length',
    confidence: 0.85,
    confidenceLevel: 'high',
  },
};

const LOW_CONFIDENCE_ITEM: GlassesMockItem = {
  label: 'Unknown Item',
  brandGuess: 'Could not determine',
  colorGuess: 'Ambiguous',
  category: 'Uncategorized',
  silhouette: 'Indeterminate',
  confidence: 0.31,
  confidenceLevel: 'low',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function generateSessionId(): string {
  return `mock-session-${Date.now()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pickMockItem(triggerId?: string): GlassesMockItem {
  if (!triggerId || triggerId.trim().length === 0) {
    return LOW_CONFIDENCE_ITEM;
  }
  const keys = Object.keys(MOCK_ITEMS);
  // Deterministic selection based on triggerId length
  const index = triggerId.length % keys.length;
  return MOCK_ITEMS[keys[index]];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a fresh mock session.
 */
export function createMockGlassesSession(
  captureMode: GlassesCaptureMode = 'mock-camera'
): GlassesMockSession {
  return {
    sessionId: generateSessionId(),
    createdAt: nowIso(),
    captureMode,
    captureCount: 0,
  };
}

/**
 * Perform a mock analysis of a captured input.
 *
 * Simulates a short local delay only. No network is used.
 * The result is deterministic for the same triggerId.
 */
export async function analyzeMockGlassesCapture(
  session: GlassesMockSession,
  triggerId: string
): Promise<GlassesMockAnalysisOutcome> {
  if (!triggerId || triggerId.trim().length === 0) {
    const error: GlassesMockError = {
      code: 'MOCK_INVALID_INPUT',
      message: 'Trigger ID was empty. Provide a non-empty string to simulate a capture.',
      recoverable: true,
    };
    return { success: false, error };
  }

  // Simulate local processing delay
  await sleep(MOCK_DELAY_MS);

  const item = pickMockItem(triggerId);
  const result: GlassesMockResult = {
    title: item.label,
    summary: `Detected ${item.label} in ${item.colorGuess} (${item.category}).`,
    category: item.category,
    color: item.colorGuess,
    silhouette: item.silhouette,
    confidence: item.confidence,
    confidenceLevel: item.confidenceLevel,
    items: [item],
    recommendation:
      item.confidenceLevel === 'low'
        ? 'Try a clearer angle or better lighting for a more confident match.'
        : 'This piece pairs well with neutral tones and minimalist accessories.',
    createdAt: nowIso(),
    imagePreviewUri: null, // local-only, never uploaded in mock builds
    isMockOnly: true,
  };

  return { success: true, result };
}

/**
 * Retrieve a pre-canned mock result without triggering analysis.
 * Useful for UI previews and static tests.
 */
export function getMockGlassesResult(): GlassesMockResult {
  return {
    title: 'Tailored Wool Blazer',
    summary: 'Detected Tailored Wool Blazer in Charcoal Grey (Outerwear).',
    category: 'Outerwear',
    color: 'Charcoal Grey',
    silhouette: 'Single-breasted, slim fit',
    confidence: 0.92,
    confidenceLevel: 'high',
    items: [MOCK_ITEMS.blazer],
    recommendation: 'This piece pairs well with neutral tones and minimalist accessories.',
    createdAt: nowIso(),
    imagePreviewUri: null,
    isMockOnly: true,
  };
}

/**
 * Force a low-confidence mock result.
 * Useful for testing edge-case UI states.
 */
export function getMockLowConfidenceResult(): GlassesMockResult {
  return {
    title: 'Unknown Item',
    summary: 'Detected Unknown Item in Ambiguous (Uncategorized).',
    category: 'Uncategorized',
    color: 'Ambiguous',
    silhouette: 'Indeterminate',
    confidence: 0.31,
    confidenceLevel: 'low',
    items: [LOW_CONFIDENCE_ITEM],
    recommendation: 'Try a clearer angle or better lighting for a more confident match.',
    createdAt: nowIso(),
    imagePreviewUri: null,
    isMockOnly: true,
  };
}

/**
 * Force an error outcome.
 * Useful for testing error-handling UI states.
 */
export function getMockErrorOutcome(): GlassesMockAnalysisOutcome {
  const error: GlassesMockError = {
    code: 'MOCK_ERROR_FORCED',
    message: 'A forced mock error occurred for testing purposes.',
    recoverable: true,
  };
  return { success: false, error };
}
