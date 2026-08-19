/**
 * Avatar visual migration mode.
 *
 * This gate affects VISUALS ONLY. It must never be consulted to decide whether
 * a message speaks, whether audio starts, or how the speech lifecycle behaves —
 * speech reliability does not depend on which visual system is drawing.
 *
 *   LEGACY       existing `deriveAvatarMouthState` output is visible.
 *                The engine is not invoked at all.
 *
 *   V10_SHADOW   existing output stays visible and authoritative. The engine
 *                calculates the same moment invisibly and records metrics, so
 *                real alignment, real playback and real lifecycle behaviour can
 *                be measured before anything reaches a user.
 *
 *   V10_VISIBLE  the engine frame drives the renderer.
 *
 * Rollback is always available: dropping the environment variable returns the
 * app to LEGACY with no other change.
 */

export type AvatarVisualMode = 'LEGACY' | 'V10_SHADOW' | 'V10_VISIBLE';

export const AVATAR_VISUAL_MODE_ENV = 'EXPO_PUBLIC_AVATAR_VISUAL_MODE';

export const DEFAULT_AVATAR_VISUAL_MODE: AvatarVisualMode = 'LEGACY';

/**
 * Parses a mode from an arbitrary value, failing closed to LEGACY.
 *
 * Exported separately from the environment read so the policy is testable
 * without mutating `process.env`.
 */
export function parseAvatarVisualMode(value: unknown): AvatarVisualMode {
  if (value === 'V10_SHADOW' || value === 'V10_VISIBLE' || value === 'LEGACY') return value;
  return DEFAULT_AVATAR_VISUAL_MODE;
}

/**
 * Resolves the active mode.
 *
 * The engine core never reads an environment variable; this host-side helper is
 * the only place the flag is consulted. It is read on each call rather than
 * captured at module load so a test can set the variable without re-importing.
 */
export function getAvatarVisualMode(): AvatarVisualMode {
  return parseAvatarVisualMode(process.env[AVATAR_VISUAL_MODE_ENV]);
}

/** True when the engine should be invoked at all. */
export function isAvatarEngineActive(mode: AvatarVisualMode = getAvatarVisualMode()): boolean {
  return mode !== 'LEGACY';
}

/** True when the engine frame — rather than the legacy value — drives pixels. */
export function isAvatarEngineVisible(mode: AvatarVisualMode = getAvatarVisualMode()): boolean {
  return mode === 'V10_VISIBLE';
}
