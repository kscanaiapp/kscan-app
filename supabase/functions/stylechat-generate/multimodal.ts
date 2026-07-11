// stylechat-generate v2 — multimodal inspection rules (pure module).
//
// Metadata remains the default attachment context. Image inspection happens
// only when the user's question genuinely needs it AND authorized,
// remote-backed private media exists. Selection and limits are decided here;
// byte fetching (server-side storage download under the caller's RLS) happens
// in index.ts. Signed URLs are never exposed to the client, bytes are never
// logged and never persisted in chat history.

import type { ResolvedAttachment, ResolvedAttachmentItem } from './attachmentContext.ts';

export const MAX_MULTIMODAL_IMAGES = 2;
export const MAX_MULTIMODAL_TOTAL_BYTES = 4 * 1024 * 1024;
export const ALLOWED_MULTIMODAL_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Conservative heuristic: inspect images only for visually grounded
 * questions. Anything ambiguous stays metadata-only.
 */
export function requiresImageInspection(message: string): boolean {
  const text = String(message ?? '').toLowerCase();
  if (!text.trim()) return false;
  return /\b(exact colors?|these colors|color match|clash|pattern (too )?busy|looks? more formal|which looks|visually|in the photo|in the picture|in the image|the detail|texture)\b/.test(text);
}

export function isAllowedMultimodalMime(mime: string): boolean {
  return (ALLOWED_MULTIMODAL_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Selects up to two authorized items with ready private media, preserving
 * attachment order. Items without verified remote media are never selected —
 * missing visuals are acknowledged, not fabricated.
 */
export function selectImagesForInspection(
  resolved: ResolvedAttachment[],
): Array<{ item: ResolvedAttachmentItem; bucket: string; path: string }> {
  const selected: Array<{ item: ResolvedAttachmentItem; bucket: string; path: string }> = [];
  for (const attachment of resolved) {
    for (const item of attachment.items) {
      if (selected.length >= MAX_MULTIMODAL_IMAGES) return selected;
      if (item.media && item.ref.sourceId) {
        selected.push({ item, bucket: item.media.bucket, path: item.media.path });
      }
    }
  }
  return selected;
}
