// Canonical platform-neutral visual-context model for Elise (StyleChat).
//
// Rules:
// - Only fields supported by actual scan or fashion-analysis evidence are populated.
// - Descriptive fields are optional; the title is the only required identity field.
// - No raw image bytes, unrestricted file paths, base64, or remote credentials.
// - `rawImageUri` is a local-only working URI and must never leave the device.

export type EliseVisualContextSource = 'scan' | 'upload';

/**
 * KSB29-028 — E4.1 room provenance.
 *
 * The server can already resolve a Dressing Room item against the database and
 * mark the resulting evidence `server_verified`
 * (`resolveOwnedRoomItem` / `resolveSharedRoomItem` in
 * supabase/functions/stylechat-generate/eliseResourceResolvers.ts). To do that
 * it needs the resource triple below. The client had no way to express it —
 * `EliseVisualContextSource` is only 'scan' | 'upload' — so a Dressing Room
 * hand-off arrived describing a garment with no resolvable identity, and the
 * certified E4.1 path was unreachable from the app.
 *
 * `roomId` and `itemId` ARE ids, which this module otherwise forbids. The
 * distinction is deliberate and narrow: the banned ids are LOCAL ones — device
 * URIs, actor keys, session ids — which identify the user or their device.
 * These two are canonical server-side RESOURCE ids that the server must have in
 * order to verify ownership at all, and it re-checks them against the actor on
 * every request. Sending them is what makes verification possible; withholding
 * them is what forced the server to fall back to unverified client metadata.
 *
 * 'shared' must never be upgraded to 'owned' — the server enforces that
 * independently, and the client must not assert an ownership it cannot prove.
 */
export type EliseRoomEvidenceSourceType = 'owned_room_item' | 'shared_room_item';

export type EliseRoomProvenance = {
  sourceType: EliseRoomEvidenceSourceType;
  roomId: string;
  itemId: string;
};

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
  /**
   * Room provenance, when this evidence came from a Dressing Room. Absent for
   * every other source, and absence keeps today's behaviour exactly.
   */
  roomProvenance?: EliseRoomProvenance | null;
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
  /** Durable app-local attachment media; this is not a committed Closet item. */
  closetCandidateId?: string;
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
  /**
   * Canonical V2 identity for this reference (Phase 2B.3).
   *
   * Client-local, exactly like `sanitizedPreviewUri` and `rawImageUri`: it is NOT
   * part of `EliseVisualContextInput` and therefore cannot reach the server
   * through the descriptive `visualCollection` payload. It travels in the separate
   * top-level `fashionContextV2` field instead.
   *
   * Typed loosely to keep this platform-neutral model free of a dependency on the
   * contract module. Every read path validates before use.
   */
  identificationV2?: unknown;
  /** Canonical outcome for this reference: `ready` or `partial`. */
  identificationState?: 'ready' | 'partial' | null;
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
