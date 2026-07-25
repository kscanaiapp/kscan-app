// Canonical platform-neutral visual-context model for Elise (StyleChat).
//
// Rules:
// - Only fields supported by actual scan or fashion-analysis evidence are populated.
// - Descriptive fields are optional; the title is the only required identity field.
// - No raw image bytes, unrestricted file paths, base64, or remote credentials.
// - `rawImageUri` is a local-only working URI and must never leave the device.

export type EliseVisualContextSource = 'scan' | 'upload';

export type EliseVisualContextStatus = 'preparing' | 'analyzing' | 'ready' | 'blocked' | 'failed';

export type EliseVisualContextPrivacyPolicy = {
  mode: string;
  sanitizerVersion: string;
  faceDetectionAvailable: boolean;
  faceMaskApplied: boolean;
  plateDetectionAvailable: boolean;
  plateMaskApplied: boolean;
  metadataStripped: boolean;
};

/**
 * Server-safe subset of visual context. This is the only shape that may cross
 * the network to the Edge Function. It must never contain local URIs, ids,
 * actor keys, session ids, or raw image references.
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

/** Bounded, server-safe evidence entry sent to StyleChat generation. */
export type EliseVisualEvidenceInput = EliseVisualContextInput & {
  id: string;
  order: number;
};

/** All ready evidence intended for one StyleChat message. */
export type EliseVisualCollectionInput = {
  evidence: EliseVisualEvidenceInput[];
  focusEvidenceId?: string | null;
};

export type EliseVisualContextEntry = EliseVisualContextInput & {
  /** Stable client-generated id for this pending entry. */
  id: string;
  /** Actor-scoped owner (e.g. user:<uuid>). */
  actorKey: string;
  /** StyleChat session this entry belongs to. */
  sessionId: string;
  /** Current lifecycle status. */
  status: EliseVisualContextStatus;
  /** Display order within the collection (1-based). */
  order: number;
  /** Optional local saved-scan id when the entry originated from a saved scan. */
  savedScanId?: string;
  /** Local URI of the preview derivative. Must never be sent remotely. */
  sanitizedPreviewUri?: string;
  /** Local URI of the original selected/captured image, used for retries. Must never be sent remotely. */
  rawImageUri?: string;
  /** UTC timestamp (ms). */
  createdAt: number;
  /** Monotonic revision token. Used to reject stale async results. */
  revision: number;
  /** Privacy policy applied to the derivative. */
  privacyPolicy?: EliseVisualContextPrivacyPolicy;
};

/** Legacy alias kept for existing imports while the collection lands. */
export type EliseVisualContext = EliseVisualContextEntry;

export const ELISE_VISUAL_CONTEXT_MAX_ENTRIES = 6;

export type EliseVisualContextCollection = {
  entries: EliseVisualContextEntry[];
  /** Optional user-selected emphasis; every ready entry is still sent. */
  focusedEntryId: string | null;
  maxEntries: number;
  revision: number;
};

export type VisualContextMemoryCandidateInput = {
  source: EliseVisualContextSource;
  title: string;
  category?: string | null;
  colors?: string[] | null;
  materials?: string[] | null;
  styleAttributes?: string[] | null;
  brand?: string | null;
};
