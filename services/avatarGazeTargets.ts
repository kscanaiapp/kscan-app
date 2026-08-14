import { MOTION_LIMITS, type AvatarGazeTarget, type AvatarMotionMode } from './avatarMotionState';

// Local UI gaze targeting.
//
// "Gaze" here means attention to a LOCAL UI ANCHOR — the composer, a product
// card, a scan result, a saved-item confirmation. It is driven exclusively
// by semantic UI events inside the app. There is no camera access, no user
// eye tracking, no face tracking, no facial recognition, no biometric
// processing, no cloud visual analysis, and no transmission of user images;
// none of those are permitted in this module or downstream of it.
//
// Rendering is additionally capability-gated: visible eye movement needs the
// independent eye overlay package, and the head-orientation-only fallback
// cue is not visually approved, so with assets missing the resolved gaze is
// always neutral even though targets can be registered and tested.

export type AvatarGazeSemanticTarget =
  | 'composer'
  | 'product-card'
  | 'scan-result'
  | 'saved-confirmation'
  | 'neutral';

/**
 * Restrained direction for each semantic anchor, in the normalized gaze
 * space of the motion contract ([-1, 1], clamped again downstream). These
 * are deliberately small: attention reads as a glance, never a stare.
 */
const SEMANTIC_TARGET_VECTORS: Readonly<Record<AvatarGazeSemanticTarget, AvatarGazeTarget>> =
  Object.freeze({
    composer: Object.freeze({ x: 0, y: 0.35 }),
    'product-card': Object.freeze({ x: 0.3, y: 0.15 }),
    'scan-result': Object.freeze({ x: -0.3, y: 0.15 }),
    'saved-confirmation': Object.freeze({ x: 0.2, y: -0.1 }),
    neutral: Object.freeze({ x: 0, y: 0 }),
  });

const NEUTRAL_GAZE: AvatarGazeTarget = SEMANTIC_TARGET_VECTORS.neutral;

type Listener = () => void;

let activeTarget: AvatarGazeSemanticTarget = 'neutral';
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One subscriber cannot break gaze propagation for the others.
    }
  }
}

function isKnownTarget(value: unknown): value is AvatarGazeSemanticTarget {
  return typeof value === 'string' && value in SEMANTIC_TARGET_VECTORS;
}

/**
 * Register the current semantic attention anchor. Unknown or invalid values
 * fall back to neutral instead of throwing — a bad caller can never aim the
 * avatar somewhere undefined.
 */
export function setAvatarGazeTarget(target: AvatarGazeSemanticTarget | null | undefined): void {
  const next = isKnownTarget(target) ? target : 'neutral';
  if (next === activeTarget) return;
  activeTarget = next;
  emit();
}

/** Remove the current anchor; gaze returns to neutral. */
export function clearAvatarGazeTarget(): void {
  setAvatarGazeTarget('neutral');
}

export function getAvatarGazeTargetSnapshot(): AvatarGazeSemanticTarget {
  return activeTarget;
}

export function subscribeToAvatarGazeTarget(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ResolveGazeInput {
  mode: AvatarMotionMode;
  reducedMotion: boolean;
  /** Whether the avatar has the eye package (gaze capability). */
  gazeCapable: boolean;
}

/**
 * Resolve the renderable gaze vector for the active target.
 *
 * Priority arbitration: speaking and interrupted retain full authority —
 * gaze never overrides them and resolves neutral there. Reduce Motion
 * disables visible gaze movement entirely, and without gaze capability the
 * result is always neutral. Values are clamped to the contract range.
 */
export function resolveAvatarGaze(input: ResolveGazeInput): AvatarGazeTarget {
  if (!input.gazeCapable || input.reducedMotion) return NEUTRAL_GAZE;
  if (input.mode === 'speaking' || input.mode === 'interrupted') return NEUTRAL_GAZE;
  const vector = SEMANTIC_TARGET_VECTORS[activeTarget] ?? NEUTRAL_GAZE;
  const limit = MOTION_LIMITS.gazeRange;
  return {
    x: Math.max(-limit, Math.min(limit, vector.x)),
    y: Math.max(-limit, Math.min(limit, vector.y)),
  };
}

/** Test hook: number of registered gaze listeners. */
export function getAvatarGazeListenerCountForTests(): number {
  return listeners.size;
}

/** Test hook: reset the module to its initial state. */
export function resetAvatarGazeForTests(): void {
  activeTarget = 'neutral';
  listeners.clear();
}
