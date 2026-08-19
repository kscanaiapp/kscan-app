import type { AvatarAssetCapabilities } from '../types';

/**
 * Platform-neutral avatar package description.
 *
 * The package carries METADATA AND REFERENCES ONLY. There is deliberately no
 * `require()`, no module id, no URI and no decoded image here: actual asset
 * loading stays a host/renderer responsibility, which is what lets the same
 * package description drive React Native images today and a Skia, native, 3D or
 * smart-glasses renderer later.
 */

export type AvatarAssetApproval = 'missing' | 'reference' | 'approved';

export interface AvatarPackageAssetDescriptor {
  /** Stable identifier the host uses to resolve the real asset. */
  key: string;
  /**
   * Only `approved` enables a capability. `reference` exists so unreviewed or
   * research artwork can be described without ever becoming shippable — the
   * V9 archive shipped ten stylists' mouth references on those terms.
   */
  approval: AvatarAssetApproval;
  /** Optional native pixel dimensions, used for registration checks. */
  widthPx?: number;
  heightPx?: number;
  sha256?: string;
}

/** Normalized 0..1 rectangle within the square avatar frame. */
export interface AvatarPackageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AvatarPackageAnchor {
  x: number;
  y: number;
}

export interface AvatarIdentityMetadata {
  avatarId: string;
  stylistId: string;
  visualPackageVersion: number;
  /** Non-identifying label for diagnostics. Never emitted through metrics. */
  label?: string;
}

export interface AvatarRegistrationMetadata {
  /** Native pixel size of the square base portrait overlays register against. */
  baseSizePx?: number;
  /**
   * When true, every overlay that declares dimensions must match the base
   * exactly. Rigid overlay compositing draws each overlay full-frame and clips
   * it to its region, so a differently sized overlay lands in the wrong place.
   */
  requireUniformOverlayDimensions: boolean;
}

export interface AvatarCompositingMetadata {
  /**
   * `rigid-overlay` is the only model V10 describes: a static base portrait
   * with full-frame overlays clipped to normalized regions. Naming it here
   * means a future warped/mesh/3D model is an added value, not a rewrite.
   */
  mode: 'rigid-overlay';
  overlayDrawsFullFrame: boolean;
}

export interface AvatarFallbackPolicy {
  onMissingMouth: 'static';
  onMissingEyes: 'static';
  onMissingBrows: 'static';
}

export interface AvatarMouthPackage {
  region: AvatarPackageRegion;
  anchor: AvatarPackageAnchor;
  closed?: AvatarPackageAssetDescriptor;
  halfOpen?: AvatarPackageAssetDescriptor;
  open?: AvatarPackageAssetDescriptor;
  round?: AvatarPackageAssetDescriptor;
  wide?: AvatarPackageAssetDescriptor;
}

export interface AvatarEyePackage {
  region: AvatarPackageRegion;
  anchor: AvatarPackageAnchor;
  open?: AvatarPackageAssetDescriptor;
  half?: AvatarPackageAssetDescriptor;
  closed?: AvatarPackageAssetDescriptor;
}

export interface AvatarBrowPackage {
  region: AvatarPackageRegion;
  anchor: AvatarPackageAnchor;
  neutral?: AvatarPackageAssetDescriptor;
  raised?: AvatarPackageAssetDescriptor;
  focused?: AvatarPackageAssetDescriptor;
}

export const SUPPORTED_AVATAR_PACKAGE_VERSION = 1 as const;

export interface AvatarPackage {
  packageVersion: number;
  identity: AvatarIdentityMetadata;
  base: AvatarPackageAssetDescriptor;
  mouth?: AvatarMouthPackage;
  eyes?: AvatarEyePackage;
  brows?: AvatarBrowPackage;
  registration: AvatarRegistrationMetadata;
  compositing: AvatarCompositingMetadata;
  fallback: AvatarFallbackPolicy;
  /**
   * Advisory only. Validation derives real capabilities from assets and reports
   * a warning when a declaration overstates what the package can actually draw.
   * A declaration can never turn a capability on.
   */
  declaredCapabilities?: Partial<AvatarAssetCapabilities>;
}
