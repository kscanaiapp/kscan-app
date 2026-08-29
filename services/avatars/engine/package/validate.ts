import type { AvatarAssetCapabilities } from '../types';
import { STATIC_CAPABILITIES } from '../types';
import type {
  AvatarPackage,
  AvatarPackageAssetDescriptor,
  AvatarPackageRegion,
} from './manifest';
import { SUPPORTED_AVATAR_PACKAGE_VERSION } from './manifest';

export type AvatarPackageIssueCode =
  | 'package-missing'
  | 'package-version-unsupported'
  | 'identity-missing'
  | 'base-not-approved'
  | 'compositing-unsupported'
  | 'fallback-policy-invalid'
  | 'region-invalid'
  | 'anchor-invalid'
  | 'dimensions-mismatch'
  | 'dimensions-unverified'
  | 'mouth-incomplete'
  | 'mouth-round-unavailable'
  | 'eyes-incomplete'
  | 'brows-incomplete'
  | 'capability-overdeclared';

export interface AvatarPackageIssue {
  code: AvatarPackageIssueCode;
  /** Channel the issue applies to, for host triage. Never contains PII. */
  channel: 'package' | 'base' | 'mouth' | 'eyes' | 'brows';
  detail: string;
}

/**
 * Integration-facing capability answer — "Sarah supports basic mouth sync but
 * not brows" — stated in the vocabulary the POC gate uses.
 */
export interface AvatarPackageCapabilityReport {
  basicLipSync: boolean;
  roundLipSync: boolean;
  blink: boolean;
  brows: boolean;
  expression: boolean;
  gaze: boolean;
}

export interface AvatarPackageValidation {
  valid: boolean;
  capabilities: AvatarPackageCapabilityReport;
  /** The same answer in the form the runtime consumes. */
  assetCapabilities: AvatarAssetCapabilities;
  errors: AvatarPackageIssue[];
  warnings: AvatarPackageIssue[];
}

const NEUTRAL_CAPABILITY_REPORT: AvatarPackageCapabilityReport = Object.freeze({
  basicLipSync: false,
  roundLipSync: false,
  blink: false,
  brows: false,
  expression: false,
  gaze: false,
});

/**
 * Derives what a package can actually draw.
 *
 * Two rules govern everything below:
 *
 *  1. FAIL CLOSED. Every capability starts off and is turned on only by
 *     approved assets plus a valid region. Anything unparseable, unapproved or
 *     geometrically impossible leaves the channel off.
 *
 *  2. CHANNELS ARE INDEPENDENT. A missing optional eye or brow asset degrades
 *     only that channel; it must never invalidate an otherwise usable
 *     mouth-only package. That is exactly Sarah's shape — a complete
 *     closed/half-open/open mouth set with no eye or brow artwork — and she is
 *     the first integration control, so this is the case that matters most.
 *
 * `valid` describes the PACKAGE, not its richness: a package is valid when it
 * can be rendered at all (supported version, identity, approved base, sane
 * compositing and fallback policy). A valid package with zero capabilities is a
 * legitimate static portrait, not an error.
 */
export function validateAvatarPackage(input: unknown): AvatarPackageValidation {
  const errors: AvatarPackageIssue[] = [];
  const warnings: AvatarPackageIssue[] = [];

  if (!input || typeof input !== 'object') {
    errors.push({ code: 'package-missing', channel: 'package', detail: 'package is not an object' });
    return fail(errors, warnings);
  }
  const pkg = input as AvatarPackage;

  if (pkg.packageVersion !== SUPPORTED_AVATAR_PACKAGE_VERSION) {
    errors.push({
      code: 'package-version-unsupported',
      channel: 'package',
      detail: `expected packageVersion ${SUPPORTED_AVATAR_PACKAGE_VERSION}`,
    });
    return fail(errors, warnings);
  }

  const identity = pkg.identity;
  if (
    !identity ||
    typeof identity.avatarId !== 'string' || identity.avatarId.length === 0 ||
    typeof identity.stylistId !== 'string' || identity.stylistId.length === 0 ||
    !Number.isInteger(identity.visualPackageVersion) || identity.visualPackageVersion < 1
  ) {
    errors.push({ code: 'identity-missing', channel: 'package', detail: 'identity is incomplete' });
    return fail(errors, warnings);
  }

  if (
    !pkg.compositing ||
    pkg.compositing.mode !== 'rigid-overlay' ||
    pkg.compositing.overlayDrawsFullFrame !== true
  ) {
    errors.push({
      code: 'compositing-unsupported',
      channel: 'package',
      detail: 'only full-frame rigid-overlay compositing is supported',
    });
    return fail(errors, warnings);
  }

  const fallback = pkg.fallback;
  if (
    !fallback ||
    fallback.onMissingMouth !== 'static' ||
    fallback.onMissingEyes !== 'static' ||
    fallback.onMissingBrows !== 'static'
  ) {
    errors.push({
      code: 'fallback-policy-invalid',
      channel: 'package',
      detail: 'every missing channel must fall back to static',
    });
    return fail(errors, warnings);
  }

  if (!isApproved(pkg.base)) {
    errors.push({ code: 'base-not-approved', channel: 'base', detail: 'base portrait is not approved' });
    return fail(errors, warnings);
  }

  const requireUniform = pkg.registration?.requireUniformOverlayDimensions === true;
  const baseWidth = pkg.base.widthPx;
  const baseHeight = pkg.base.heightPx;

  const registers = (
    asset: AvatarPackageAssetDescriptor | undefined,
    channel: AvatarPackageIssue['channel'],
  ): boolean => {
    if (!isApproved(asset)) return false;
    if (!requireUniform) return true;
    const declaresBoth =
      Number.isFinite(baseWidth) && Number.isFinite(baseHeight) &&
      Number.isFinite(asset.widthPx) && Number.isFinite(asset.heightPx);
    if (!declaresBoth) {
      // The K Scan registry legitimately does not carry decoded pixel sizes,
      // and the region system is normalized, so unverified dimensions are
      // reported rather than treated as disqualifying. A DECLARED mismatch is
      // fatal, because rigid overlays land in the wrong place when the frames
      // are not the same size.
      warnings.push({
        code: 'dimensions-unverified',
        channel,
        detail: `asset ${asset.key} declares no pixel dimensions to register against the base`,
      });
      return true;
    }
    if (asset.widthPx !== baseWidth || asset.heightPx !== baseHeight) {
      errors.push({
        code: 'dimensions-mismatch',
        channel,
        detail: `asset ${asset.key} does not match base dimensions`,
      });
      return false;
    }
    return true;
  };

  // -- Mouth ------------------------------------------------------------------
  let mouthClosed = false;
  let mouthHalfOpen = false;
  let mouthOpen = false;
  let mouthRound = false;
  let mouthWide = false;
  const mouth = pkg.mouth;
  if (mouth) {
    if (!isValidRegion(mouth.region)) {
      errors.push({ code: 'region-invalid', channel: 'mouth', detail: 'mouth region is outside the normalized frame' });
    } else if (!isValidAnchor(mouth.anchor)) {
      errors.push({ code: 'anchor-invalid', channel: 'mouth', detail: 'mouth anchor is outside the normalized frame' });
    } else {
      mouthClosed = registers(mouth.closed, 'mouth');
      mouthHalfOpen = registers(mouth.halfOpen, 'mouth');
      mouthOpen = registers(mouth.open, 'mouth');
      mouthRound = registers(mouth.round, 'mouth');
      mouthWide = registers(mouth.wide, 'mouth');
      // A closed mouth is the neutral state every other state returns to. With
      // no approved closed asset there is nothing to animate back to, so the
      // whole mouth channel stays off rather than half-working.
      if (!mouthClosed) {
        mouthHalfOpen = false;
        mouthOpen = false;
        mouthRound = false;
        mouthWide = false;
        warnings.push({
          code: 'mouth-incomplete',
          channel: 'mouth',
          detail: 'no approved closed mouth; mouth channel disabled',
        });
      } else if (!mouthHalfOpen && !mouthOpen) {
        mouthRound = false;
        mouthWide = false;
        warnings.push({
          code: 'mouth-incomplete',
          channel: 'mouth',
          detail: 'closed mouth only; no open state to animate to',
        });
      } else if (!mouthRound) {
        warnings.push({
          code: 'mouth-round-unavailable',
          channel: 'mouth',
          detail: 'round visemes will resolve to open',
        });
      }
    }
  }

  // -- Eyes -------------------------------------------------------------------
  let eyes = false;
  if (pkg.eyes) {
    if (!isValidRegion(pkg.eyes.region)) {
      errors.push({ code: 'region-invalid', channel: 'eyes', detail: 'eye region is outside the normalized frame' });
    } else if (!isValidAnchor(pkg.eyes.anchor)) {
      errors.push({ code: 'anchor-invalid', channel: 'eyes', detail: 'eye anchor is outside the normalized frame' });
    } else {
      // A blink needs all three frames; two of three reads as a glitch, so the
      // channel is refused rather than approximated.
      eyes =
        registers(pkg.eyes.open, 'eyes') &&
        registers(pkg.eyes.half, 'eyes') &&
        registers(pkg.eyes.closed, 'eyes');
      if (!eyes) {
        warnings.push({
          code: 'eyes-incomplete',
          channel: 'eyes',
          detail: 'blink needs approved open, half and closed frames',
        });
      }
    }
  }

  // -- Brows ------------------------------------------------------------------
  let brows = false;
  if (pkg.brows) {
    if (!isValidRegion(pkg.brows.region)) {
      errors.push({ code: 'region-invalid', channel: 'brows', detail: 'brow region is outside the normalized frame' });
    } else if (!isValidAnchor(pkg.brows.anchor)) {
      errors.push({ code: 'anchor-invalid', channel: 'brows', detail: 'brow anchor is outside the normalized frame' });
    } else {
      brows =
        registers(pkg.brows.neutral, 'brows') &&
        registers(pkg.brows.raised, 'brows') &&
        registers(pkg.brows.focused, 'brows');
      if (!brows) {
        warnings.push({
          code: 'brows-incomplete',
          channel: 'brows',
          detail: 'brows need approved neutral, raised and focused frames',
        });
      }
    }
  }

  const assetCapabilities: AvatarAssetCapabilities = {
    base: true,
    mouthClosed,
    mouthHalfOpen,
    mouthOpen,
    mouthRound,
    mouthWide,
    eyes,
    brows,
    // Gaze redirects the eyes, so it cannot exist without approved eye artwork.
    gaze: eyes,
    // Composite idle motion transforms the approved base only.
    compositeMotion: true,
    tapAcknowledgement: true,
  };

  const capabilities: AvatarPackageCapabilityReport = {
    basicLipSync: mouthClosed && (mouthHalfOpen || mouthOpen),
    roundLipSync: mouthClosed && mouthRound,
    blink: eyes,
    brows,
    // "Expression" means a readable change of face. A portrait with neither
    // eyes nor brows can only be transformed, not expressive.
    expression: eyes || brows,
    gaze: eyes,
  };

  reportOverdeclaration(pkg, assetCapabilities, warnings);

  const valid = errors.length === 0;
  return {
    valid,
    capabilities: valid ? capabilities : NEUTRAL_CAPABILITY_REPORT,
    assetCapabilities: valid ? assetCapabilities : { ...STATIC_CAPABILITIES },
    errors,
    warnings,
  };
}

/**
 * Runtime capability derivation. Always routes through validation so an invalid
 * package can only ever produce the static capability set.
 */
export function deriveCapabilitiesFromPackage(input: unknown): AvatarAssetCapabilities {
  return validateAvatarPackage(input).assetCapabilities;
}

function reportOverdeclaration(
  pkg: AvatarPackage,
  derived: AvatarAssetCapabilities,
  warnings: AvatarPackageIssue[],
): void {
  const declared = pkg.declaredCapabilities;
  if (!declared) return;
  for (const key of Object.keys(declared) as (keyof AvatarAssetCapabilities)[]) {
    if (declared[key] === true && derived[key] !== true) {
      warnings.push({
        code: 'capability-overdeclared',
        channel: 'package',
        detail: `declared ${key} is not backed by approved assets`,
      });
    }
  }
}

function isApproved(
  asset: AvatarPackageAssetDescriptor | undefined,
): asset is AvatarPackageAssetDescriptor {
  return !!asset && asset.approval === 'approved' && typeof asset.key === 'string' && asset.key.length > 0;
}

export function isValidRegion(region: AvatarPackageRegion | undefined): boolean {
  if (!region) return false;
  const { x, y, width, height } = region;
  return (
    [x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    x >= 0 && y >= 0 && width > 0 && height > 0 &&
    x + width <= 1 && y + height <= 1
  );
}

function isValidAnchor(anchor: { x: number; y: number } | undefined): boolean {
  if (!anchor) return false;
  return (
    typeof anchor.x === 'number' && Number.isFinite(anchor.x) && anchor.x >= 0 && anchor.x <= 1 &&
    typeof anchor.y === 'number' && Number.isFinite(anchor.y) && anchor.y >= 0 && anchor.y <= 1
  );
}

function fail(
  errors: AvatarPackageIssue[],
  warnings: AvatarPackageIssue[],
): AvatarPackageValidation {
  return {
    valid: false,
    capabilities: NEUTRAL_CAPABILITY_REPORT,
    assetCapabilities: { ...STATIC_CAPABILITIES },
    errors,
    warnings,
  };
}
