// Session-scoped and actor-scoped visual context for Elise.
//
// Rules:
// - In-memory only. No AsyncStorage, no Supabase, no image bytes.
// - One active visual context per actor + session.
// - Replacements are explicit; stale async results are rejected by revision.
// - Sign-out / actor change clears the store.

import type { EliseVisualContext } from '../../types/eliseVisualContext';

type StoreEntry = {
  context: EliseVisualContext | null;
  revision: number;
};

export type VisualContextScanIntent = {
  id: string;
  actorKey: string;
  sessionId: string;
  expectedRevision: number;
  createdAt: number;
};

const store = new Map<string, StoreEntry>();
const scanIntents = new Map<string, VisualContextScanIntent>();
const listeners = new Set<() => void>();
let revisionCounter = 0;
let intentCounter = 0;
const SCAN_INTENT_TTL_MS = 15 * 60 * 1000;
const MAX_SCAN_INTENTS = 20;

function key(actorKey: string, sessionId: string): string {
  return `${actorKey}:${sessionId}`;
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Listener failures never corrupt the store.
    }
  }
}

function getEntry(actorKey: string, sessionId: string): StoreEntry {
  const k = key(actorKey, sessionId);
  let entry = store.get(k);
  if (!entry) {
    entry = { context: null, revision: 0 };
    store.set(k, entry);
  }
  return entry;
}

function currentRevision(actorKey: string, sessionId: string): number {
  return store.get(key(actorKey, sessionId))?.revision ?? 0;
}

function pruneScanIntents(now = Date.now(), reserveSlot = false): void {
  for (const [id, intent] of scanIntents) {
    if (now - intent.createdAt > SCAN_INTENT_TTL_MS) scanIntents.delete(id);
  }
  const maximumSize = reserveSlot ? MAX_SCAN_INTENTS - 1 : MAX_SCAN_INTENTS;
  while (scanIntents.size > maximumSize) {
    const oldest = scanIntents.keys().next().value as string | undefined;
    if (!oldest) break;
    scanIntents.delete(oldest);
  }
}

export function subscribeToVisualContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVisualContext(
  actorKey: string,
  sessionId: string,
): EliseVisualContext | null {
  return store.get(key(actorKey, sessionId))?.context ?? null;
}

export function getVisualContextRevision(actorKey: string, sessionId: string): number {
  return currentRevision(actorKey, sessionId);
}

/** Create an opaque scanner return intent without exposing actor identity in the route. */
export function createVisualContextScanIntent(actorKey: string, sessionId: string): string {
  pruneScanIntents(Date.now(), true);
  for (const [id, intent] of scanIntents) {
    if (intent.actorKey === actorKey && intent.sessionId === sessionId) scanIntents.delete(id);
  }
  const id = `vc-scan-${Date.now().toString(36)}-${(++intentCounter).toString(36)}`;
  scanIntents.set(id, {
    id,
    actorKey,
    sessionId,
    expectedRevision: currentRevision(actorKey, sessionId),
    createdAt: Date.now(),
  });
  return id;
}

export function getVisualContextScanIntent(id: string): VisualContextScanIntent | null {
  pruneScanIntents();
  return scanIntents.get(id) ?? null;
}

export function consumeVisualContextScanIntent(id: string): VisualContextScanIntent | null {
  const intent = getVisualContextScanIntent(id);
  scanIntents.delete(id);
  return intent;
}

/**
 * Set (or replace) the visual context for an actor/session.
 * Returns the minted revision token. Callers doing async work must later verify
 * the revision is still current before applying updates.
 */
export function setVisualContext(
  actorKey: string,
  sessionId: string,
  context: EliseVisualContext | null,
): number {
  const entry = getEntry(actorKey, sessionId);
  entry.revision = ++revisionCounter;
  entry.context = context;
  if (context) {
    entry.context.revision = entry.revision;
  }
  notify();
  return entry.revision;
}

/**
 * Update the context in place only if the supplied revision is still current.
 * This prevents stale async work (superseded uploads, session switches, etc.)
 * from resurrecting or overwriting newer state.
 */
export function updateVisualContextIfCurrent(
  actorKey: string,
  sessionId: string,
  revision: number,
  updater: (ctx: EliseVisualContext) => EliseVisualContext,
): boolean {
  const entry = getEntry(actorKey, sessionId);
  if (entry.revision !== revision) return false;
  if (!entry.context) return false;
  entry.context = updater(entry.context);
  notify();
  return true;
}

export function removeVisualContext(actorKey: string, sessionId: string): void {
  const entry = getEntry(actorKey, sessionId);
  entry.revision = ++revisionCounter;
  entry.context = null;
  notify();
}

/**
 * Clear all visual-context state. Called on sign-out / actor change.
 */
export function resetVisualContextStore(): string[] {
  const previewUris = [...new Set(
    [...store.values()]
      .map((entry) => entry.context?.sanitizedPreviewUri)
      .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0),
  )];
  store.clear();
  scanIntents.clear();
  notify();
  return previewUris;
}

/**
 * True when the supplied revision token is still the active one for the actor/session.
 */
export function isVisualContextRevisionCurrent(
  actorKey: string,
  sessionId: string,
  revision: number,
): boolean {
  return currentRevision(actorKey, sessionId) === revision;
}
