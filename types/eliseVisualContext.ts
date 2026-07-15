// Canonical platform-neutral visual-context model for Elise (StyleChat).
//
// Rules:
// - Only fields supported by actual scan or fashion-analysis evidence are populated.
// - Descriptive fields are optional; the title is the only required identity field.
// - No raw image bytes, unrestricted file paths, base64, or remote credentials.

export type EliseVisualContextSource = 'scan' | 'upload';

export type EliseVisualContextStatus = 'preparing' | 'analyzing' | 'ready' | 'failed';

/**
 * Server-safe subset of visual context. This is the only shape that may cross
 * the network to the Edge Function. It must never contain local URIs, ids,
 * actor keys, or session ids.
 */
export type EliseVisualContextInput = {
  source: EliseVisualContextSource;
  title: string;
  summary?: string | null;
  category?: string | null;
  colors?: string[] | null;
  materials?: string[] | null;
  silhouette?: string | null;
  styleAttributes?: string[] | null;
  brand?: string | null;
  confidence?: number | null;
};

export type EliseVisualContext = EliseVisualContextInput & {
  /** Stable client-generated id for this pending context. */
  id: string;
  /** Actor-scoped owner (e.g. user:<uuid>). */
  actorKey: string;
  /** StyleChat session this context belongs to. */
  sessionId: string;
  /** Current lifecycle status. */
  status: EliseVisualContextStatus;
  /** Optional local saved-scan id when the context originated from a saved scan. */
  savedScanId?: string;
  /** Local URI of the sanitized preview derivative. Must never be sent remotely. */
  sanitizedPreviewUri?: string;
  /** UTC timestamp (ms). */
  createdAt: number;
  /** Monotonic revision token. Used to reject stale async results. */
  revision: number;
  /** Privacy policy applied to the derivative. */
  privacyPolicy?: {
    mode: string;
    sanitizerVersion: string;
    faceDetectionAvailable: boolean;
    faceMaskApplied: boolean;
    plateDetectionAvailable: boolean;
    plateMaskApplied: boolean;
    metadataStripped: boolean;
  };
};
