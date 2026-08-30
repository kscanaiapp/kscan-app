import type { AvatarAssetCapabilities, AvatarMouthState } from '../types';

/**
 * Used only when speech is genuinely playing but alignment never arrived or was
 * unusable. It is a function of the NATIVE PLAYBACK POSITION, so it stops when
 * playback stops and resumes in place — it is not an independent animation.
 *
 * A genuinely empty alignment is not routed here: an utterance the provider
 * says has no spoken characters must stay closed rather than mime.
 */
export function fallbackMouthState(
  playbackSeconds: number,
  cycleMs: number,
  caps: AvatarAssetCapabilities,
): AvatarMouthState {
  if (!Number.isFinite(playbackSeconds) || playbackSeconds < 0 || !caps.mouthClosed) return 'closed';
  const states: AvatarMouthState[] = [
    'closed',
    caps.mouthHalfOpen ? 'halfOpen' : 'closed',
    caps.mouthOpen ? 'open' : caps.mouthHalfOpen ? 'halfOpen' : 'closed',
    caps.mouthHalfOpen ? 'halfOpen' : 'closed',
  ];
  const cycleSeconds = Math.max(0.18, cycleMs / 1000);
  const index = Math.min(
    states.length - 1,
    Math.floor(((playbackSeconds % cycleSeconds) / cycleSeconds) * states.length),
  );
  return states[index]!;
}
