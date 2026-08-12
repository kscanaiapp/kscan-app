// StyleChat attachment draft store (Phase 2 — Closet Intelligence).
//
// In-memory module store following the styleChatHandoffContext pattern (no new
// dependency). Two responsibilities:
//
//   1. Per-session composer drafts (attachments + preserved typed text) that
//      survive navigation, scanner round-trips, screen remounts, orientation
//      changes, and brief backgrounding. Cleared only by explicit user discard
//      or successful send. (Full app-restart persistence is deferred — P2.)
//   2. A one-time entry handoff so Closet / Look Detail / Stylist entry points
//      can preload an attachment into the StyleChat composer without
//      auto-sending and without touching older sent messages.
//
// The selection layer here may hold local ids/URIs; ONLY resolved contracts
// (state === 'ready') ever leave through snapshotReadyAttachments, which
// returns an immutable copy bound to one outgoing message operation.

import type {
  DraftAttachment,
  StyleChatAttachment,
  StyleChatAttachmentSummary,
} from '../../types/styleChatAttachments';

type SessionDraft = {
  attachments: DraftAttachment[];
  /** Preserved composer text across remounts/round-trips. */
  composerText: string;
};

type PendingAttachmentHandoff = {
  resolved?: StyleChatAttachment | null;
  /** For local-only items that still need the resolution saga. */
  localScanId?: string | null;
  localImageUri?: string | null;
  /** Owned item + local scan passed through so the composer can resolve. */
  ownedItem?: unknown | null;
  localScan?: unknown | null;
  summary: StyleChatAttachmentSummary;
  createdAt: string;
};

const drafts = new Map<string, SessionDraft>();
let pendingHandoff: PendingAttachmentHandoff | null = null;
const listeners = new Set<() => void>();
let resetSagaGuardsCallback: (() => void) | null = null;
const EMPTY_ATTACHMENTS = Object.freeze([]) as DraftAttachment[];

function notify() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Listener failures never corrupt the store.
    }
  }
}

export function subscribeToAttachmentDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function compositeKey(sessionId: string, actorKey?: string | null): string {
  return actorKey ? `${actorKey}:${sessionId}` : sessionId;
}

function getOrCreateDraft(sessionId: string, actorKey?: string | null): SessionDraft {
  const k = compositeKey(sessionId, actorKey);
  let draft = drafts.get(k);
  if (!draft) {
    draft = { attachments: [], composerText: '' };
    drafts.set(k, draft);
  }
  return draft;
}

export function getDraftAttachments(sessionId: string, actorKey?: string | null): DraftAttachment[] {
  return drafts.get(compositeKey(sessionId, actorKey))?.attachments ?? EMPTY_ATTACHMENTS;
}

export function getDraftComposerText(sessionId: string, actorKey?: string | null): string {
  return drafts.get(compositeKey(sessionId, actorKey))?.composerText ?? '';
}

export function setDraftComposerText(sessionId: string, text: string, actorKey?: string | null): void {
  getOrCreateDraft(sessionId, actorKey).composerText = text;
  // Text changes don't need re-render fan-out; the composer owns its state and
  // this store is its recovery source after remount.
}

export function upsertDraftAttachment(
  sessionId: string,
  attachment: DraftAttachment,
  actorKey?: string | null,
): void {
  const draft = getOrCreateDraft(sessionId, actorKey);
  const index = draft.attachments.findIndex((entry) => entry.draftId === attachment.draftId);
  if (index >= 0) {
    draft.attachments = draft.attachments.map((entry, entryIndex) =>
      entryIndex === index ? attachment : entry,
    );
  } else {
    draft.attachments = [...draft.attachments, attachment];
  }
  notify();
}

/**
 * Update-only saga transition: applies a new draft snapshot ONLY if the draftId
 * still exists in the session. A removed (or session-cleared) draft is NEVER
 * resurrected — a late resolution/upload/finalization completion that lands
 * after the user removed the attachment (or after the send cleared the draft)
 * becomes a no-op rather than a "ghost" attachment reappearing. Returns true
 * when the transition was applied.
 *
 * The resolution saga owns per-draftId serialization (one operation at a time),
 * and removal deletes the draftId while re-adding mints a fresh draftId, so an
 * obsolete operation can never overwrite the current state through this path.
 */
export function updateDraftAttachment(
  sessionId: string,
  attachment: DraftAttachment,
  actorKey?: string | null,
): boolean {
  const draft = drafts.get(compositeKey(sessionId, actorKey));
  if (!draft) return false;
  const index = draft.attachments.findIndex((entry) => entry.draftId === attachment.draftId);
  if (index < 0) return false;
  // `useSyncExternalStore` compares snapshots with Object.is. Publish a new
  // array identity for every applied transition so a Closet-only state change
  // (saving -> saved / save_failed) cannot remain visually stale while the
  // underlying attachment has already changed.
  draft.attachments = draft.attachments.map((entry, entryIndex) =>
    entryIndex === index ? attachment : entry,
  );
  notify();
  return true;
}

export function removeDraftAttachment(
  sessionId: string,
  draftId: string,
  actorKey?: string | null,
): void {
  const draft = drafts.get(compositeKey(sessionId, actorKey));
  if (!draft) return;
  draft.attachments = draft.attachments.filter((entry) => entry.draftId !== draftId);
  notify();
}

/** Explicit discard or successful send: clears attachments (and optionally text). */
export function clearDraftAttachments(
  sessionId: string,
  options?: { keepText?: boolean; actorKey?: string | null },
): void {
  const draft = drafts.get(compositeKey(sessionId, options?.actorKey));
  if (!draft) return;
  draft.attachments = [];
  if (!options?.keepText) draft.composerText = '';
  notify();
}

function attachmentKey(ref: StyleChatAttachment): string {
  if (ref.attachmentType === 'owned_item') return `owned:${ref.sourceType}:${ref.sourceId}`;
  if (ref.attachmentType === 'shared_item') return `shared:${ref.sourceType}:${ref.sourceId}`;
  if (ref.attachmentType === 'look') return `look:${ref.lookId}`;
  return `outfit:${ref.itemRefs.map((r) => `${r.sourceType}:${r.sourceId}`).sort().join('|')}`;
}

/**
 * Immutable snapshot of READY attachments for one outgoing message operation.
 * Duplicate resolved references are collapsed to a single entry so the server
 * never receives the same source id twice. Later draft mutations can never
 * touch an in-flight request.
 */
export function snapshotReadyAttachments(
  sessionId: string,
  actorKey?: string | null,
): {
  references: StyleChatAttachment[];
  drafts: DraftAttachment[];
} {
  const ready = getDraftAttachments(sessionId, actorKey).filter(
    (entry) =>
      (entry.state === 'ready' || entry.state === 'send_failed') &&
      Boolean(entry.resolved || entry.fashionContext),
  );
  const seen = new Set<string>();
  const unique: DraftAttachment[] = [];
  for (const entry of ready) {
    const key = entry.resolved
      ? attachmentKey(entry.resolved)
      : `direct:${entry.selection.closetCandidateId ?? entry.draftId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return {
    references: unique
      .map((entry) =>
        entry.resolved
          ? (JSON.parse(JSON.stringify(entry.resolved)) as StyleChatAttachment)
          : null,
      )
      .filter(Boolean) as StyleChatAttachment[],
    drafts: unique.map((entry) => JSON.parse(JSON.stringify(entry)) as DraftAttachment),
  };
}

/**
 * Full store reset for actor changes (sign-out / a different account signing
 * in). Composer drafts hold this device's local image URIs and selection
 * metadata; they must never survive across users. Also drops any un-consumed
 * entry handoff so it cannot leak into the next account's composer.
 */
export function resetAttachmentStore(): void {
  drafts.clear();
  pendingHandoff = null;
  resetSagaGuardsCallback?.();
  notify();
}

/**
 * Register a callback that clears any in-flight attachment saga guards when
 * the store is reset (e.g., on sign-out). The resolution hook registers this
 * so a stale per-draftId guard cannot leak across account switches.
 */
export function registerAttachmentSagaReset(callback: () => void): () => void {
  resetSagaGuardsCallback = callback;
  return () => {
    if (resetSagaGuardsCallback === callback) resetSagaGuardsCallback = null;
  };
}

// ── One-time entry handoff ────────────────────────────────────────────────────

export function setAttachmentHandoff(handoff: PendingAttachmentHandoff): void {
  pendingHandoff = handoff;
}

export function consumeAttachmentHandoff(): PendingAttachmentHandoff | null {
  const handoff = pendingHandoff;
  pendingHandoff = null;
  return handoff;
}

export function peekAttachmentHandoff(): PendingAttachmentHandoff | null {
  return pendingHandoff;
}
