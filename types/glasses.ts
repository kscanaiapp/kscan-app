/**
 * types/glasses.ts
 *
 * Shared types for the isolated Google Glasses / XR mock prototype.
 * This file is intentionally dependency-free.
 * It does not import app types, backend contracts, or native modules.
 *
 * All shapes are temporary and will align with the canonical backend
 * contract in a future integration phase.
 */

/**
 * How the mock capture was triggered.
 */
export type GlassesCaptureMode =
  | 'mock-camera'
  | 'mock-gallery'
  | 'mock-voice'
  | 'mock-manual';

/**
 * Human-readable confidence bucket.
 */
export type GlassesConfidenceLevel =
  | 'high'
  | 'medium'
  | 'low'
  | 'uncertain';

/**
 * A single detected fashion item inside a mock result.
 */
export interface GlassesMockItem {
  /** Detected item label, e.g. "Tailored Wool Blazer" */
  label: string;

  /** Guessed brand, e.g. "Unbranded / similar to Acne Studios" */
  brandGuess: string;

  /** Dominant color description, e.g. "Charcoal Grey" */
  colorGuess: string;

  /** Fashion category, e.g. "Outerwear" */
  category: string;

  /** Silhouette description, e.g. "Single-breasted, slim fit" */
  silhouette: string;

  /** Confidence score 0.0 – 1.0 */
  confidence: number;

  /** Human-readable confidence bucket */
  confidenceLevel: GlassesConfidenceLevel;
}

/**
 * The full mock analysis result for a single capture.
 *
 * Field names are intentionally aligned with native Android result
 * shapes (title, summary, category, color, silhouette, confidence)
 * so future backend integration is straightforward.
 */
export interface GlassesMockResult {
  /** Result title / headline */
  title: string;

  /** Short summary of what was detected */
  summary: string;

  /** Top-level category for the result */
  category: string;

  /** Dominant color */
  color: string;

  /** Silhouette note */
  silhouette: string;

  /** Overall confidence score 0.0 – 1.0 */
  confidence: number;

  /** Confidence bucket */
  confidenceLevel: GlassesConfidenceLevel;

  /** One or more detected items */
  items: GlassesMockItem[];

  /** Short recommendation text */
  recommendation: string;

  /** ISO-8601 timestamp string */
  createdAt: string;

  /** Local-only image preview URI — never uploaded in mock builds */
  imagePreviewUri: string | null;

  /** Explicit mock-only flag */
  isMockOnly: true;
}

/**
 * A lightweight mock session record.
 */
export interface GlassesMockSession {
  /** Unique session identifier */
  sessionId: string;

  /** When the session was created */
  createdAt: string;

  /** Capture mode used for this session */
  captureMode: GlassesCaptureMode;

  /** Number of mock captures performed in this session */
  captureCount: number;
}

/**
 * Safe error shape used when mock analysis cannot produce a result.
 */
export interface GlassesMockError {
  /** Error code string */
  code: string;

  /** Human-readable message */
  message: string;

  /** Whether this is a recoverable error */
  recoverable: boolean;
}

/**
 * Union type for the outcome of a mock analysis call.
 */
export type GlassesMockAnalysisOutcome =
  | { success: true; result: GlassesMockResult }
  | { success: false; error: GlassesMockError };
