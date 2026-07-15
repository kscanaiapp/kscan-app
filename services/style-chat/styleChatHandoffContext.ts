// StyleChat Handoff Context — frontend-only ephemeral bridge.
//
// Rules:
// - In-memory only. No AsyncStorage, no Supabase, no backend calls.
// - Cleared when consumed or when a new handoff replaces it.
// - Do not pass large image data or base64 through here; imageUri is a local URI reference only.
// - Do not store PII, facial data, or biometrics.

import type { EliseVisualContextInput } from '../../types/eliseVisualContext';

export type StyleChatHandoffSource = 'camera' | 'upload' | 'text-scan';

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
