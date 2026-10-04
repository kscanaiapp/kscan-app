/**
 * VTO awareness runtime: the small amount of state the discovery model needs
 * and does not hold itself.
 *
 *   HISTORY   what this account has already seen or done, on this device.
 *             Kept by the shared services/featureAwareness (this file holds no
 *             device storage, like every other VTO module).
 *   SESSION   what happened since launch: whether the first-use tip was shown,
 *             and whether Try It On was pitched on the K+ membership step. In
 *             memory only, per account, gone on relaunch.
 *   BLOCKERS  which modals are presenting right now, so a tip never appears
 *             behind or on top of one.
 *
 * Nothing here is an authority. It never decides who may try something on,
 * and no function in this file can start a generation or open a photo chooser:
 * it records, it remembers, and it emits content-free telemetry.
 */

import { getActorContext } from '../actorContext';
import {
  getFeatureAwarenessNow,
  loadFeatureAwareness,
  patchFeatureAwareness,
  subscribeFeatureAwareness,
} from '../featureAwareness';
import type {
  VtoActorKPlusState,
  VtoAwarenessRecord,
  VtoAwarenessSession,
  VtoAwarenessSurface,
} from './vtoDiscovery';
import { emitVtoEvent } from './vtoTelemetry';

const FEATURE = 'virtual_try_on' as const;

// ── Change notification ──────────────────────────────────────────────────────

const listeners = new Set<() => void>();
let storeUnsubscribe: (() => void) | null = null;

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* a listener never breaks awareness */
    }
  }
}

/** Notified when history, session memory or the blocker set changes. */
export function subscribeVtoAwareness(listener: () => void): () => void {
  listeners.add(listener);
  if (!storeUnsubscribe) storeUnsubscribe = subscribeFeatureAwareness(notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storeUnsubscribe) {
      storeUnsubscribe();
      storeUnsubscribe = null;
    }
  };
}

// ── History ──────────────────────────────────────────────────────────────────

/** The current account's history, or `null` while it is unknown. */
export function readVtoAwareness(): VtoAwarenessRecord | null {
  return getFeatureAwarenessNow(FEATURE);
}

/** Warms the current account's history from the device. */
export function loadVtoAwareness(): Promise<VtoAwarenessRecord | null> {
  return loadFeatureAwareness(FEATURE);
}

export function dismissVtoHomeCard(): void {
  void patchFeatureAwareness(FEATURE, { homeCardDismissed: true });
}

/** The actor opened the try-on surface. Retires the Home introduction. */
export function markVtoInitiated(): void {
  if (readVtoAwareness()?.initiated) return;
  void patchFeatureAwareness(FEATURE, { initiated: true });
}

/** A try-on result was presented. */
export function markVtoCompleted(): void {
  if (readVtoAwareness()?.completed) return;
  void patchFeatureAwareness(FEATURE, { initiated: true, completed: true });
}

export function dismissVtoCue(): void {
  void patchFeatureAwareness(FEATURE, { cueDismissed: true });
}

// ── Session memory (per account, never persisted) ────────────────────────────

interface SessionEntry {
  cueShown: boolean;
  pitchedAtStep6: boolean;
  impressions: Set<string>;
}

const sessions = new Map<string, SessionEntry>();

const NO_SESSION: VtoAwarenessSession = Object.freeze({ cueShown: false, pitchedAtStep6: false });

function currentActorId(): string | null {
  const actorId = getActorContext().actorId;
  return typeof actorId === 'string' && actorId ? actorId : null;
}

function sessionFor(actorId: string): SessionEntry {
  let entry = sessions.get(actorId);
  if (!entry) {
    entry = { cueShown: false, pitchedAtStep6: false, impressions: new Set<string>() };
    sessions.set(actorId, entry);
  }
  return entry;
}

/** This launch's memory for the CURRENT account. Another account signing in
 *  on the same launch starts from an empty one. */
export function readVtoAwarenessSession(): VtoAwarenessSession {
  const actorId = currentActorId();
  if (!actorId) return NO_SESSION;
  const entry = sessions.get(actorId);
  if (!entry) return NO_SESSION;
  return { cueShown: entry.cueShown, pitchedAtStep6: entry.pitchedAtStep6 };
}

/**
 * The first-use tip is on screen. Claims the session's one presentation
 * synchronously -- so a second product card evaluating in the same tick sees
 * it taken -- and counts the presentation against the lifetime cap.
 */
export function noteVtoCuePresented(): void {
  const actorId = currentActorId();
  if (!actorId) return;
  const entry = sessionFor(actorId);
  if (entry.cueShown) return;
  entry.cueShown = true;
  const presentations = readVtoAwareness()?.cuePresentations ?? 0;
  void patchFeatureAwareness(FEATURE, { cuePresentations: presentations + 1 });
  notify();
}

/** Try It On was shown as a K+ benefit on the membership step, this session. */
export function noteVtoPitchedAtStep6(): void {
  const actorId = currentActorId();
  if (!actorId) return;
  const entry = sessionFor(actorId);
  if (entry.pitchedAtStep6) return;
  entry.pitchedAtStep6 = true;
  notify();
}

// ── Blockers ─────────────────────────────────────────────────────────────────

const blockers = new Set<symbol>();

/**
 * Declares that a modal or sheet is presenting. Returns its release. A surface
 * holds one for exactly as long as its modal is up.
 */
export function acquireVtoAwarenessBlocker(): () => void {
  const token = Symbol('vto-awareness-blocker');
  blockers.add(token);
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    blockers.delete(token);
    notify();
  };
}

export function isVtoAwarenessBlocked(): boolean {
  return blockers.size > 0;
}

// ── Telemetry ────────────────────────────────────────────────────────────────

export interface VtoAwarenessEventContext {
  surface: VtoAwarenessSurface;
  kplus: VtoActorKPlusState;
}

/**
 * An awareness surface became visible. Counted once per surface per session
 * per account: a shelf of ten eligible items is one impression of "the product
 * surface offered Try It On", not ten.
 */
export function emitVtoAwarenessImpression(context: VtoAwarenessEventContext): void {
  const actorId = currentActorId();
  if (!actorId) return;
  const entry = sessionFor(actorId);
  if (entry.impressions.has(context.surface)) return;
  entry.impressions.add(context.surface);
  emitVtoEvent('vto_awareness_impression', {
    surface: context.surface,
    actor_kplus_state: context.kplus,
  });
}

export function emitVtoAwarenessTap(context: VtoAwarenessEventContext): void {
  emitVtoEvent('vto_awareness_tap', {
    surface: context.surface,
    actor_kplus_state: context.kplus,
  });
}

export function emitVtoAwarenessDismissed(context: VtoAwarenessEventContext): void {
  emitVtoEvent('vto_awareness_dismissed', {
    surface: context.surface,
    actor_kplus_state: context.kplus,
  });
}

export function __resetVtoAwarenessForTests(): void {
  sessions.clear();
  blockers.clear();
  listeners.clear();
  if (storeUnsubscribe) {
    storeUnsubscribe();
    storeUnsubscribe = null;
  }
}
