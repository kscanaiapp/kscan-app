import { getSharedAvatarMotionController } from './avatarMotionController';

// Tap acknowledgement.
//
// Tapping Elise while she is at rest produces exactly one restrained
// acknowledgement: the controller's brief self-expiring `reacting` mode plus
// a warm expression bias (which, with brow capability, presents as a subtle
// raise). Purely local — no provider call, no backend request, no speech
// interaction of any kind. The speech store is never touched, so a tap can
// neither interrupt active speech nor restart completed speech.

export const ACKNOWLEDGEMENT_POLICY = {
  /** Minimum gap between acknowledgements; rapid taps collapse into one. */
  cooldownMs: 2_500,
} as const;

/** Semantic event name for analytics/accessibility consumers. */
export const AVATAR_ACKNOWLEDGED_EVENT = 'avatar_acknowledged';

type AcknowledgementListener = (event: { name: typeof AVATAR_ACKNOWLEDGED_EVENT }) => void;

const listeners = new Set<AcknowledgementListener>();
let lastAcknowledgedAtMs: number | null = null;

function emitAcknowledged(): void {
  for (const listener of [...listeners]) {
    try {
      listener({ name: AVATAR_ACKNOWLEDGED_EVENT });
    } catch {
      // One subscriber cannot break acknowledgement for the others.
    }
  }
}

export function subscribeToAvatarAcknowledgement(
  listener: AcknowledgementListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type AcknowledgementOutcome =
  | 'acknowledged'
  | 'busy'
  | 'cooldown';

export interface AcknowledgeAvatarTapInput {
  /** Caller-supplied timestamp; injected for deterministic tests. */
  nowMs: number;
  reducedMotion: boolean;
}

/**
 * Handle one avatar tap.
 *
 * - Runs only when the current motion state permits it (idle or listening):
 *   speaking, thinking, and reacting are never preempted, so a tap cannot
 *   interrupt speech, and completed speech is never restarted because
 *   nothing here touches the speech pipeline.
 * - Rapid repeated taps inside the cooldown collapse to a single
 *   acknowledgement.
 * - Under Reduce Motion the semantic event still fires (the UI announces it
 *   textually) but no motion mode or expression changes.
 */
export function acknowledgeAvatarTap(
  input: AcknowledgeAvatarTapInput,
): AcknowledgementOutcome {
  const controller = getSharedAvatarMotionController();
  const mode = controller.getSnapshot().mode;
  if (mode !== 'idle' && mode !== 'listening') return 'busy';
  if (
    lastAcknowledgedAtMs !== null &&
    Number.isFinite(input.nowMs) &&
    input.nowMs - lastAcknowledgedAtMs < ACKNOWLEDGEMENT_POLICY.cooldownMs
  ) {
    return 'cooldown';
  }
  lastAcknowledgedAtMs = Number.isFinite(input.nowMs) ? input.nowMs : lastAcknowledgedAtMs;

  if (!input.reducedMotion) {
    // Brief, self-expiring reaction plus a warm expression bias. The
    // controller arbitrates; if a higher-priority state slipped in between
    // the check above and this call, the request is simply rejected.
    controller.requestMode('reacting');
    controller.setExpression('warm');
  }
  emitAcknowledged();
  return 'acknowledged';
}

/** Test hook: clear cooldown and listeners. */
export function resetAvatarAcknowledgementForTests(): void {
  lastAcknowledgedAtMs = null;
  listeners.clear();
}
