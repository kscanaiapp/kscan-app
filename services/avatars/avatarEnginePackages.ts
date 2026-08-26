import {
  STYLIST_AVATAR_PRESET_BY_ID,
  getStylistMouthMotionConfig,
  isRenderablePortraitPreset,
  resolveStylistVisualAvatarId,
  type StylistSpeechConfiguration,
} from '../../constants/stylistIdentity';
import type {
  AvatarPackage,
  AvatarPackageAssetDescriptor,
} from './engine/package/manifest';
import { SUPPORTED_AVATAR_PACKAGE_VERSION } from './engine/package/manifest';
import {
  validateAvatarPackage,
  type AvatarPackageValidation,
} from './engine/package/validate';

/**
 * Host-side translation from the K Scan avatar registry to an engine package.
 *
 * This is the ONLY file that knows both vocabularies. The registry keeps
 * owning Metro module references and static `require(...)` calls; the engine
 * receives metadata and keys only, and never learns how an asset is loaded.
 * That separation is what lets a future Skia, native, 3D or smart-glasses
 * renderer reuse the same engine without touching it.
 *
 * Availability rule: an asset counts as `approved` only when the registry holds
 * a real, positive Metro module reference for it. Anything absent stays
 * `missing`, so a package can only ever under-claim.
 */

/**
 * Eye and brow artwork exists in `expressionFrameSources` for one portrait, but
 * no eye or brow REGION has been calibrated in the registry, and a rigid
 * overlay cannot be placed without one. Those channels are therefore
 * deliberately not described yet: the engine's fail-closed derivation keeps
 * blink, brows and gaze off until real regions land, rather than compositing
 * facial features at a guessed position.
 */
const EYE_AND_BROW_REGIONS_CALIBRATED = false;

function descriptor(
  key: string,
  source: number | undefined,
): AvatarPackageAssetDescriptor {
  const approved = typeof source === 'number' && Number.isFinite(source) && source > 0;
  return { key, approval: approved ? 'approved' : 'missing' };
}

/**
 * Builds the engine package for one avatar id, or null when the registry has no
 * renderable portrait for it (abstract presets and placeholder slots).
 */
export function buildAvatarPackage(avatarId: string | null | undefined): AvatarPackage | null {
  if (!avatarId) return null;
  // Unknown ids fail closed. The system Elise alias is a known persisted id and
  // resolves through the identity authority to its canonical visible portrait.
  if (!STYLIST_AVATAR_PRESET_BY_ID.has(avatarId)) return null;
  const visualAvatarId = resolveStylistVisualAvatarId(avatarId);
  const preset = STYLIST_AVATAR_PRESET_BY_ID.get(visualAvatarId);
  if (!preset || !isRenderablePortraitPreset(preset)) return null;

  const speech: StylistSpeechConfiguration | undefined = getStylistMouthMotionConfig(visualAvatarId);
  const mouthSources = speech?.mouthStateSources;
  const mouthRegion = speech?.mouthRegion;
  const mouthUsable =
    speech?.speakingMotionMode === 'mouth_states' && !!mouthRegion && !!mouthSources;

  const pkg: AvatarPackage = {
    packageVersion: SUPPORTED_AVATAR_PACKAGE_VERSION,
    identity: {
      avatarId: visualAvatarId,
      // Package identity is visual. Persisted speech identity may be the
      // owner-approved `elise_default` alias and is reconciled by the host.
      stylistId: visualAvatarId,
      visualPackageVersion: 1,
    },
    base: descriptor(`${visualAvatarId}:base`, preset.source),
    registration: {
      // The registry carries no decoded pixel sizes. Uniform registration is
      // still REQUIRED so a package that does declare mismatched dimensions is
      // rejected; undeclared dimensions surface as a warning instead.
      requireUniformOverlayDimensions: true,
    },
    compositing: {
      mode: 'rigid-overlay',
      overlayDrawsFullFrame: true,
    },
    fallback: {
      onMissingMouth: 'static',
      onMissingEyes: 'static',
      onMissingBrows: 'static',
    },
  };

  if (mouthUsable && mouthRegion && mouthSources) {
    pkg.mouth = {
      region: mouthRegion,
      // The registry has no separate anchor; the region centre is the anchor
      // for full-frame rigid overlays, which is exactly how the current
      // renderer positions the mouth layer.
      anchor: {
        x: mouthRegion.x + mouthRegion.width / 2,
        y: mouthRegion.y + mouthRegion.height / 2,
      },
      closed: descriptor(`${visualAvatarId}:mouth:closed`, mouthSources.closed),
      halfOpen: descriptor(`${visualAvatarId}:mouth:halfOpen`, mouthSources.halfOpen),
      open: descriptor(`${visualAvatarId}:mouth:open`, mouthSources.open),
      round: descriptor(`${visualAvatarId}:mouth:round`, mouthSources.round),
    };
  }

  if (EYE_AND_BROW_REGIONS_CALIBRATED) {
    // Intentionally unreachable until calibrated regions exist. Kept as the
    // single documented place those channels will be described.
  }

  return pkg;
}

export interface AvatarPackageResolution {
  avatarId: string;
  package: AvatarPackage | null;
  validation: AvatarPackageValidation;
}

/**
 * Package resolution is memoized because the registry is a frozen module
 * constant: for a given avatar id the answer cannot change within a session,
 * and validation must never run on a render path.
 */
const RESOLUTION_CACHE = new Map<string, AvatarPackageResolution>();

export function resolveAvatarPackage(avatarId: string | null | undefined): AvatarPackageResolution {
  const id = avatarId ?? '';
  const cached = RESOLUTION_CACHE.get(id);
  if (cached) return cached;
  const built = buildAvatarPackage(id);
  const resolution: AvatarPackageResolution = {
    avatarId: built?.identity.avatarId ?? id,
    package: built,
    validation: validateAvatarPackage(built),
  };
  RESOLUTION_CACHE.set(id, resolution);
  return resolution;
}

export function resetAvatarPackageCacheForTests(): void {
  RESOLUTION_CACHE.clear();
}
