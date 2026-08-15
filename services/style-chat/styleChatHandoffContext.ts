// StyleChat Handoff Context — frontend-only ephemeral bridge.
//
// Rules:
// - In-memory only. No AsyncStorage, no Supabase, no backend calls.
// - Cleared when consumed or when a new handoff replaces it.
// - Do not pass large image data or base64 through here; imageUri is a local URI reference only.
// - Do not store PII, facial data, or biometrics.

import type {
  EliseRoomProvenance,
  EliseVisualCollectionInput,
  EliseVisualContextInput,
} from '../../types/eliseVisualContext';

/**
 * KSB29-028: 'dressing-room' is a distinct entry path, not a flavour of
 * 'camera'. The room hand-off previously collapsed onto 'camera'/'upload',
 * which told the server this was an ad-hoc photo and discarded the fact that a
 * verifiable room resource stood behind it.
 */
export type StyleChatHandoffSource = 'camera' | 'upload' | 'text-scan' | 'dressing-room';

export type StyleChatHandoffContext = {
  source: StyleChatHandoffSource;
  imageUri?: string | null;
  query?: string | null;
  textScanId?: string | null;
  category?: string | null;
  color?: string | null;
  silhouette?: string | null;
  material?: string | null;
  descriptors?: string[];
  analysisText?: string | null;
  createdAt?: string;
  /** Structured visual context for Elise. Client-local preview URIs must never be included here. */
  visualContext?: EliseVisualContextInput | null;
  /** Bounded ordered collection for multi-reference reasoning. */
  visualCollection?: EliseVisualCollectionInput | null;
  /**
   * Room provenance for a Dressing Room hand-off (KSB29-028).
   *
   * Unlike `imageUri` and `identificationV2`, this IS part of the server-safe
   * projection: the server needs the resource triple to resolve the item and
   * mark the evidence `server_verified` rather than falling back to unverified
   * client metadata.
   */
  roomProvenance?: EliseRoomProvenance | null;
  /**
   * Canonical V2 identity from the Scanner result that produced this handoff
   * (Phase 2B.3).
   *
   * Present only when Scanner actually ran the V2 contract. Its purpose is REUSE:
   * Elise validates and forwards it instead of re-identifying a garment Scanner
   * already identified, so the handoff spends no second scan and the two surfaces
   * cannot report different identities for one photo.
   *
   * Client-local like `imageUri` — it is NOT part of the server-safe projection
   * `toServerSafeActiveContext` produces, and travels in the separate top-level
   * `fashionContextV2` request field instead.
   *
   * Typed loosely to keep this ephemeral bridge free of a contract dependency.
   * Every read path validates before use.
   */
  identificationV2?: unknown;
};

let currentHandoff: StyleChatHandoffContext | null = null;

/**
 * Set a one-time handoff context for StyleChat.
 * Replaces any previous context (single active context for V1).
 */
export function setStyleChatHandoffContext(context: StyleChatHandoffContext): void {
  currentHandoff = context;
}

/**
 * Get the current handoff context, if any.
 */
export function getStyleChatHandoffContext(): StyleChatHandoffContext | null {
  return currentHandoff;
}

/**
 * Clear the current handoff context immediately.
 */
export function clearStyleChatHandoffContext(): void {
  currentHandoff = null;
}
