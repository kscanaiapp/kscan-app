import type { AvatarEngineConfig, AvatarGazeTarget } from '../types';
import type { AvatarGazeVector } from '../contract';

/**
 * Gaze targets are expressed as normalized direction, then scaled by the
 * configured maxima. The engine says "look slightly down-left"; the renderer
 * decides what that means for its own geometry, which is what keeps the same
 * numbers meaningful for a 2D overlay today and a 3D or AR rig later.
 */
const TARGETS: Record<AvatarGazeTarget, readonly [number, number]> = {
  center: [0, 0],
  composer: [0, 0.55],
  message: [0, -0.25],
  closet: [-0.55, 0.15],
  scanResult: [0.55, -0.1],
  system: [0, -0.45],
};

export function deriveGaze(
  target: AvatarGazeTarget | undefined,
  enabled: boolean,
  config: AvatarEngineConfig,
): AvatarGazeVector {
  const resolved: AvatarGazeTarget = enabled && target && target in TARGETS ? target : 'center';
  const [nx, ny] = TARGETS[resolved];
  return { x: nx * config.gazeMaxX, y: ny * config.gazeMaxY, target: resolved };
}
