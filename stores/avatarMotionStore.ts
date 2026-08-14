import {
  getAvatarSpeechState,
  subscribeToAvatarSpeech,
  type AvatarSpeechPhase,
  type AvatarSpeechSource,
} from './avatarSpeechStore';
import {
  deriveAvatarMouthState,
  type AvatarMouthState,
} from '../services/avatarSpeechMotion';
import { resolveSpeechEntryMouth } from '../services/avatarMotionController';

// Discrete motion projection of the avatar speech store.
//
// The speech store emits on every playback-position update (~12 Hz). UI that
// only cares about *visible* changes (mouth state, phase, scope) must not
// rerender per tick, so this store derives a discrete snapshot and emits only
// when a discrete field actually changes. Continuous values (playback
// seconds) never appear in the snapshot. No React dependency here; the
// useAvatarMotionState hook wraps it for components.

export interface AvatarDiscreteMotionSnapshot {
  actorId: string | null;
  sessionId: string | null;
  stylistId: string | null;
  avatarId: string | null;
  generation: number;
  phase: AvatarSpeechPhase;
  source: AvatarSpeechSource | null;
  /** True only while native playback reports active playback. */
  speaking: boolean;
  /**
   * Discrete mouth state derived from the cached timeline cursor. Reduce
   * Motion is applied by the consumer (a render concern), so the projection
   * itself stays renderer- and accessibility-agnostic.
   */
  mouth: AvatarMouthState;
}

type Listener = () => void;

function derive(): AvatarDiscreteMotionSnapshot {
  const speech = getAvatarSpeechState();
  const speaking = speech.phase === 'playing';
  let mouth: AvatarMouthState = 'closed';
  if (speaking) {
    const target = deriveAvatarMouthState({
      phase: speech.phase,
      playbackSeconds: speech.playbackSeconds,
      alignment: speech.alignment,
      reducedMotion: false,
    });
    // Start-of-speech anti-pop, deterministic from the playback position
    // itself: an open/round first frame softens through half-open. Provider
    // timestamps and audio are untouched.
    mouth = resolveSpeechEntryMouth(target, speech.playbackSeconds * 1000, false);
  }
  return {
    actorId: speech.actorId,
    sessionId: speech.sessionId,
    stylistId: speech.stylistId,
    avatarId: speech.avatarId,
    generation: speech.generation,
    phase: speech.phase,
    source: speech.source,
    speaking,
    mouth,
  };
}

function snapshotsEqual(
  a: AvatarDiscreteMotionSnapshot,
  b: AvatarDiscreteMotionSnapshot,
): boolean {
  return (
    a.actorId === b.actorId &&
    a.sessionId === b.sessionId &&
    a.stylistId === b.stylistId &&
    a.avatarId === b.avatarId &&
    a.generation === b.generation &&
    a.phase === b.phase &&
    a.source === b.source &&
    a.speaking === b.speaking &&
    a.mouth === b.mouth
  );
}

let snapshot: AvatarDiscreteMotionSnapshot = Object.freeze(derive());
const listeners = new Set<Listener>();
let upstreamUnsubscribe: (() => void) | null = null;

function refresh(): boolean {
  const next = derive();
  if (snapshotsEqual(snapshot, next)) return false;
  snapshot = Object.freeze(next);
  return true;
}

function handleUpstreamChange(): void {
  if (!refresh()) return;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A subscriber cannot break discrete propagation for the others.
    }
  }
}

/**
 * Current discrete snapshot. Cheap: the mouth lookup runs on the cached
 * timeline cursor, and the same object is returned until a discrete field
 * changes (required by useSyncExternalStore).
 */
export function getAvatarMotionSnapshot(): AvatarDiscreteMotionSnapshot {
  if (!upstreamUnsubscribe) refresh();
  return snapshot;
}

/**
 * Subscribe to discrete motion changes. The upstream speech-store
 * subscription exists only while at least one subscriber is registered, so
 * teardown leaves no dangling subscription.
 */
export function subscribeToAvatarMotion(listener: Listener): () => void {
  if (!upstreamUnsubscribe) {
    refresh();
    upstreamUnsubscribe = subscribeToAvatarSpeech(handleUpstreamChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && upstreamUnsubscribe) {
      upstreamUnsubscribe();
      upstreamUnsubscribe = null;
    }
  };
}

/** Test hook: whether an upstream speech-store subscription is active. */
export function isAvatarMotionUpstreamSubscribedForTests(): boolean {
  return upstreamUnsubscribe !== null;
}
