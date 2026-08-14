// Facial overlay asset contract (round mouth, eyes, brows).
//
// This module is the single authoritative registry for localized facial
// overlay assets and the anchor convention they must follow. Capabilities
// are DERIVED from this registry: a capability can only become true when a
// complete, validated asset package is registered here with static Metro
// require() sources. Registering an entry is therefore a release act — it is
// how round-mouth/blink/brow capability flips on for an avatar.
//
// PRODUCTION STATUS: the registry below is EMPTY. No approved round-mouth,
// eye, or brow overlays exist for any avatar yet. They must be produced from
// the owner's approved portrait sources, visually reviewed, and added here
// with their measured regions and anchors. Do not register generated,
// placeholder, or unreviewed art; do not reference raw/ or preview
// directories.

// ── Anchor and region convention ─────────────────────────────────────────────
//
// All geometry is normalized to the 1024×1024 base portrait, matching the
// existing mouthRegion convention in stylistIdentity.ts:
//
// - `region` is the overlay's placement rectangle on the base portrait in
//   normalized [0,1] coordinates (x, y = top-left; width, height).
// - `anchor` is the overlay's registration point in normalized coordinates
//   RELATIVE TO THE REGION (0.5/0.5 = region center). The renderer aligns
//   the overlay's anchor to the region's anchor point, so an overlay may be
//   re-exported at a different pixel size without re-measuring the region.
// - `pixelWidth`/`pixelHeight` are the overlay image's intrinsic pixels.
// - `blendMarginPx` is the feathered transparent margin baked into the
//   overlay on every edge, at overlay pixel scale. It must be wide enough to
//   hide the seam at the smallest rendered size (67 px header avatar).
//
// Overlays are LOCALIZED TRANSPARENT images (the mouth layer's legacy
// full-canvas convention is grandfathered and must not be migrated here).

export type FacialOverlayLayer = 'mouthRound' | 'eyes' | 'brows';

export type EyeOverlayState = 'open' | 'halfClosed' | 'closed';
export type BrowOverlayState = 'neutral' | 'raised' | 'focused';

export interface FacialOverlayRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FacialOverlayAnchor {
  x: number;
  y: number;
}

/** One shipped overlay image and its registration metadata. */
export interface FacialOverlayAsset {
  /** Static local require() result. Never a URI, never raw/preview paths. */
  source: number;
  region: FacialOverlayRegion;
  anchor: FacialOverlayAnchor;
  pixelWidth: number;
  pixelHeight: number;
  blendMarginPx: number;
  /** State the asset renders. */
  supportedState: string;
  /** State served when this asset fails to load. */
  fallbackState: string;
}

/** Complete package required before a capability may flip true. */
export interface AvatarFacialOverlayPackage {
  avatarId: string;
  /** Round mouth: exactly one asset (state 'round', fallback 'open'). */
  mouthRound?: FacialOverlayAsset;
  /** Blink requires all three eye states. */
  eyes?: Record<EyeOverlayState, FacialOverlayAsset>;
  /** Brows require all three states. */
  brows?: Record<BrowOverlayState, FacialOverlayAsset>;
}

/**
 * Authoritative registry, keyed by avatarId.
 *
 * PRODUCTION STATUS: stylist_portrait_02 ships eyes + brows overlays,
 * derived from owner-supplied source photography of the same subject as the
 * approved base portrait, measured and registered below. mouthRound is
 * intentionally NOT registered for any avatar: it is defined in this
 * registry's type for future use, but the current renderer
 * (components/stylist/AnimatedStylistAvatar.tsx) never reads a mouthRound
 * overlay — round-mouth rendering exclusively uses the legacy full-canvas
 * `mouthStateSources.round` convention in constants/stylistIdentity.ts.
 * Registering a mouthRound entry here would flip AvatarMotionCapabilities.
 * roundMouth true via services/avatarMotionCapabilities.ts's OR condition
 * without the renderer ever displaying it — a capability that lies about
 * what's on screen. See docs/avatars/AVATAR_MOTION_V1_ASSET_AND_QA_CONTRACT.md
 * §2 for the outstanding asset requirements report, including why
 * stylist_portrait_02 round-mouth remains unshipped and 01/03/04/05/08
 * remain fully empty.
 */
export const AVATAR_FACIAL_OVERLAY_PACKAGES: ReadonlyMap<string, AvatarFacialOverlayPackage> =
  Object.freeze(
    new Map<string, AvatarFacialOverlayPackage>([
      [
        'stylist_portrait_02',
        {
          avatarId: 'stylist_portrait_02',
          eyes: {
            open: {
              source: require('../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_open.png'),
              region: { x: 0.3154, y: 0.1328, width: 0.4121, height: 0.0762 },
              anchor: { x: 0.5, y: 0.5 },
              pixelWidth: 844,
              pixelHeight: 156,
              blendMarginPx: 36,
              supportedState: 'open',
              fallbackState: 'open',
            },
            halfClosed: {
              source: require('../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_halfClosed.png'),
              region: { x: 0.3154, y: 0.1328, width: 0.4121, height: 0.0762 },
              anchor: { x: 0.5, y: 0.5 },
              pixelWidth: 844,
              pixelHeight: 156,
              blendMarginPx: 36,
              supportedState: 'halfClosed',
              fallbackState: 'closed',
            },
            closed: {
              source: require('../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_eyes_closed.png'),
              region: { x: 0.3154, y: 0.1328, width: 0.4121, height: 0.0762 },
              anchor: { x: 0.5, y: 0.5 },
              pixelWidth: 844,
              pixelHeight: 156,
              blendMarginPx: 36,
              supportedState: 'closed',
              fallbackState: 'closed',
            },
          },
          brows: {
            neutral: {
              source: require('../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_neutral.png'),
              region: { x: 0.3154, y: 0.0859, width: 0.4199, height: 0.0684 },
              anchor: { x: 0.5, y: 0.5 },
              pixelWidth: 860,
              pixelHeight: 140,
              blendMarginPx: 36,
              supportedState: 'neutral',
              fallbackState: 'neutral',
            },
            raised: {
              source: require('../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_raised.png'),
              region: { x: 0.3154, y: 0.0859, width: 0.4199, height: 0.0684 },
              anchor: { x: 0.5, y: 0.5 },
              pixelWidth: 860,
              pixelHeight: 140,
              blendMarginPx: 36,
              supportedState: 'raised',
              fallbackState: 'neutral',
            },
            focused: {
              source: require('../assets/stylist-avatars/portraits/facial-overlays/avatar_stylist_02_brows_focused.png'),
              region: { x: 0.3154, y: 0.0859, width: 0.4199, height: 0.0684 },
              anchor: { x: 0.5, y: 0.5 },
              pixelWidth: 860,
              pixelHeight: 140,
              blendMarginPx: 36,
              supportedState: 'focused',
              fallbackState: 'neutral',
            },
          },
        },
      ],
    ]),
  );

function isNormalized(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Structural validation for a single overlay asset. */
export function isValidFacialOverlayAsset(asset: FacialOverlayAsset | undefined): boolean {
  if (!asset || typeof asset !== 'object') return false;
  const { region, anchor } = asset;
  return (
    typeof asset.source === 'number' &&
    Number.isFinite(asset.source) &&
    asset.source > 0 &&
    region != null &&
    isNormalized(region.x) &&
    isNormalized(region.y) &&
    isNormalized(region.width) &&
    isNormalized(region.height) &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= 1 &&
    region.y + region.height <= 1 &&
    anchor != null &&
    isNormalized(anchor.x) &&
    isNormalized(anchor.y) &&
    Number.isInteger(asset.pixelWidth) &&
    asset.pixelWidth > 0 &&
    Number.isInteger(asset.pixelHeight) &&
    asset.pixelHeight > 0 &&
    Number.isInteger(asset.blendMarginPx) &&
    asset.blendMarginPx >= 0 &&
    typeof asset.supportedState === 'string' &&
    asset.supportedState.length > 0 &&
    typeof asset.fallbackState === 'string' &&
    asset.fallbackState.length > 0
  );
}

const EYE_STATES: readonly EyeOverlayState[] = Object.freeze(['open', 'halfClosed', 'closed']);
const BROW_STATES: readonly BrowOverlayState[] = Object.freeze(['neutral', 'raised', 'focused']);

/**
 * Whether an avatar ships a complete, valid package for a layer. Partial
 * packages (for example two of three eye states) count as absent: a
 * capability must never be half-true.
 */
export function hasValidFacialOverlayPackage(
  avatarId: string | null | undefined,
  layer: FacialOverlayLayer,
): boolean {
  if (!avatarId) return false;
  const pkg = AVATAR_FACIAL_OVERLAY_PACKAGES.get(avatarId);
  if (!pkg) return false;
  if (layer === 'mouthRound') return isValidFacialOverlayAsset(pkg.mouthRound);
  if (layer === 'eyes') {
    return EYE_STATES.every((state) => isValidFacialOverlayAsset(pkg.eyes?.[state]));
  }
  return BROW_STATES.every((state) => isValidFacialOverlayAsset(pkg.brows?.[state]));
}

/** Resolve an overlay asset, or null when absent/invalid (degrade safely). */
export function getFacialOverlayAsset(
  avatarId: string | null | undefined,
  layer: FacialOverlayLayer,
  state: string,
): FacialOverlayAsset | null {
  if (!avatarId || !hasValidFacialOverlayPackage(avatarId, layer)) return null;
  const pkg = AVATAR_FACIAL_OVERLAY_PACKAGES.get(avatarId)!;
  if (layer === 'mouthRound') return pkg.mouthRound ?? null;
  if (layer === 'eyes') return pkg.eyes?.[state as EyeOverlayState] ?? null;
  return pkg.brows?.[state as BrowOverlayState] ?? null;
}
