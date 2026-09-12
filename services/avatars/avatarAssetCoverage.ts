import { STYLIST_AVATAR_PRESET_BY_ID } from '../../constants/stylistIdentity';
import { resolveAvatarPackage } from './avatarEnginePackages';

/**
 * Per-avatar × per-state approved-asset coverage, and the degradation contract
 * that follows from it.
 *
 * Coverage is DERIVED from the validated engine package — the same capability
 * derivation the runtime uses — so this module cannot claim artwork the renderer
 * would not actually draw. Nothing here generates, substitutes or approves an
 * asset: a state with no approved frame degrades to an approved one or is
 * reported MISSING.
 */

export type AvatarCoverage = 'MAPPED' | 'DEGRADED' | 'MISSING';

/** The presentation states the coverage grid must account for. */
export type AvatarCoverageState =
  | 'IDLE'
  | 'LISTENING'
  | 'THINKING'
  | 'SPEAKING_CLOSED'
  | 'SPEAKING_HALF'
  | 'SPEAKING_OPEN'
  | 'INTERRUPTED'
  | 'ERROR';

export const AVATAR_COVERAGE_STATES: readonly AvatarCoverageState[] = Object.freeze([
  'IDLE',
  'LISTENING',
  'THINKING',
  'SPEAKING_CLOSED',
  'SPEAKING_HALF',
  'SPEAKING_OPEN',
  'INTERRUPTED',
  'ERROR',
]);

/**
 * How much of a speaking face an avatar's approved assets support.
 *
 *   full   closed + half-open + open, so consonants and vowels differ.
 *   basic  closed + open only; half-open degrades to closed.
 *   none   no approved speaking frames; the face cannot show speech at all.
 */
export type AvatarSpeakingTier = 'full' | 'basic' | 'none';

export interface AvatarCoverageCell {
  coverage: AvatarCoverage;
  /** The approved asset key actually drawn, or null when nothing is drawn. */
  assetKey: string | null;
  note: string;
}

export interface AvatarCoverageRow {
  /** The persisted preset id a customer can select. */
  presetId: string;
  /** The portrait actually rendered for that preset. */
  visualAvatarId: string;
  voiceProfile: string;
  /** False for silent presets, which can never reach a speaking state. */
  canSpeak: boolean;
  packageValid: boolean;
  speakingTier: AvatarSpeakingTier;
  cells: Readonly<Record<AvatarCoverageState, AvatarCoverageCell>>;
}

export interface AvatarSpeakingCoverage {
  visualAvatarId: string;
  /** True when a distinct speaking mouth can be drawn. */
  mouthCapable: boolean;
  /**
   * False when the registry holds no shipped preset for this id — an unknown id
   * or a reserved placeholder slot.
   *
   * The renderer independently guarantees something is always drawn: an
   * unrecognized id falls back to the approved default treatment in
   * `components/stylist/StylistAvatar`. This flag is therefore about what the
   * avatar may be ANIMATED as, not about whether the screen has a picture: a
   * false here projects FALLBACK, which holds that safe static pose.
   */
  assetsAvailable: boolean;
  speakingTier: AvatarSpeakingTier;
}

/**
 * THE DEGRADATION CONTRACT.
 *
 * Recorded here as executable text so the behaviour and its description cannot
 * drift, and so owner review has one place to read it.
 *
 * 1. A state is MAPPED only when the engine package holds an approved asset for
 *    it. Approval comes from the registry; this module can only under-claim.
 * 2. A missing speaking frame degrades along the renderer's existing chain
 *    (`resolveMouthStateSource`): round -> open -> half-open -> closed, and
 *    half-open -> closed. It is never replaced by a placeholder, a generated
 *    frame, or another portrait's artwork.
 * 3. No approved speaking frames at all is not a blocker. The avatar keeps its
 *    approved base pose and SPEAKING is carried entirely by the status channel
 *    the header already renders, so degraded SPEAKING stays visibly distinct
 *    from IDLE without any new artwork.
 * 4. LISTENING and INTERRUPTED have no approved artwork on any avatar. Both
 *    draw the approved base pose; the engine is still told the real mode.
 * 5. Reduce Motion renders the approved base statically for every avatar, and
 *    the status channel again carries SPEAKING.
 */
export const AVATAR_DEGRADATION_CONTRACT: readonly string[] = Object.freeze([
  'MAPPED requires an approved asset in the validated engine package.',
  'Missing speaking frames degrade round -> open -> halfOpen -> closed; never substituted.',
  'No approved speaking frames: base pose held, SPEAKING carried by the header status channel.',
  'LISTENING and INTERRUPTED draw the approved base pose; the engine still receives the real mode.',
  'Reduce Motion holds the approved base pose; the status channel carries SPEAKING.',
]);

function cell(coverage: AvatarCoverage, assetKey: string | null, note: string): AvatarCoverageCell {
  return Object.freeze({ coverage, assetKey, note });
}

function resolveSpeakingTier(caps: {
  mouthClosed: boolean;
  mouthHalfOpen: boolean;
  mouthOpen: boolean;
}): AvatarSpeakingTier {
  if (!caps.mouthClosed || !caps.mouthOpen) return 'none';
  return caps.mouthHalfOpen ? 'full' : 'basic';
}

/**
 * The per-avatar answer the render path needs. Package resolution is memoized
 * upstream, so this is safe to call per render.
 */
export function resolveAvatarSpeakingCoverage(
  avatarId: string | null | undefined,
): AvatarSpeakingCoverage {
  const resolution = resolveAvatarPackage(avatarId);
  const caps = resolution.validation.assetCapabilities;
  return {
    visualAvatarId: resolution.avatarId,
    // A distinct speaking mouth needs the closed frame plus at least one open
    // shape; closed alone would render speech identically to silence.
    mouthCapable: caps.mouthClosed && (caps.mouthOpen || caps.mouthHalfOpen),
    assetsAvailable: isShippedPreset(avatarId),
    speakingTier: resolveSpeakingTier(caps),
  };
}

/** A shipped preset is one the registry holds and marks available. */
function isShippedPreset(avatarId: string | null | undefined): boolean {
  if (!avatarId) return false;
  return STYLIST_AVATAR_PRESET_BY_ID.get(avatarId)?.availability === 'ready';
}

function buildRow(presetId: string): AvatarCoverageRow {
  const preset = STYLIST_AVATAR_PRESET_BY_ID.get(presetId);
  const resolution = resolveAvatarPackage(presetId);
  const caps = resolution.validation.assetCapabilities;
  const visualAvatarId = resolution.avatarId;
  const voiceProfile = preset?.voiceProfile ?? 'silent';
  const canSpeak = voiceProfile !== 'silent';
  const tier = resolveSpeakingTier(caps);
  const shipped = isShippedPreset(presetId);
  const base = shipped ? `${visualAvatarId}:base` : null;

  const speakingCell = (
    state: 'SPEAKING_CLOSED' | 'SPEAKING_HALF' | 'SPEAKING_OPEN',
  ): AvatarCoverageCell => {
    if (!shipped) {
      return cell('MISSING', null, 'not a shipped preset');
    }
    if (!canSpeak) {
      return cell('MISSING', null, 'silent preset: no speaking state is reachable');
    }
    if (tier === 'none') {
      return cell(
        'DEGRADED',
        base,
        'no approved speaking frames: base pose held, SPEAKING shown by the status channel',
      );
    }
    if (state === 'SPEAKING_CLOSED') {
      return cell('MAPPED', `${visualAvatarId}:mouth:closed`, 'approved closed frame');
    }
    if (state === 'SPEAKING_OPEN') {
      return cell('MAPPED', `${visualAvatarId}:mouth:open`, 'approved open frame');
    }
    return caps.mouthHalfOpen
      ? cell('MAPPED', `${visualAvatarId}:mouth:halfOpen`, 'approved half-open frame')
      : cell(
          'DEGRADED',
          `${visualAvatarId}:mouth:closed`,
          'no approved half-open frame: degrades to closed',
        );
  };

  const cells: Record<AvatarCoverageState, AvatarCoverageCell> = {
    IDLE: shipped
      ? cell('MAPPED', base, 'approved base pose')
      : cell('MISSING', null, 'not a shipped preset'),
    LISTENING: shipped
      ? cell('DEGRADED', base, 'no approved listening pose: base pose held')
      : cell('MISSING', null, 'not a shipped preset'),
    THINKING: shipped
      ? cell('MAPPED', base, 'approved base pose plus the existing thinking ring')
      : cell('MISSING', null, 'not a shipped preset'),
    SPEAKING_CLOSED: speakingCell('SPEAKING_CLOSED'),
    SPEAKING_HALF: speakingCell('SPEAKING_HALF'),
    SPEAKING_OPEN: speakingCell('SPEAKING_OPEN'),
    INTERRUPTED: shipped
      ? cell('DEGRADED', base, 'no approved interrupted pose: base pose held, mouth closed')
      : cell('MISSING', null, 'not a shipped preset'),
    ERROR: shipped
      ? cell('MAPPED', base, 'safe static approved base pose')
      : cell('MISSING', null, 'not a shipped preset'),
  };

  return Object.freeze({
    presetId,
    visualAvatarId,
    voiceProfile,
    canSpeak,
    packageValid: resolution.validation.valid,
    speakingTier: tier,
    cells: Object.freeze(cells),
  });
}

/** Every selectable preset, in registry order. */
export function buildAvatarCoverageGrid(): readonly AvatarCoverageRow[] {
  return Object.freeze([...STYLIST_AVATAR_PRESET_BY_ID.keys()].map(buildRow));
}
