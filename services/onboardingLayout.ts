// Pure onboarding layout helpers (Build 25 Phase 1 — BUG-01).
//
// Onboarding screens must never rely on a hardcoded device height: at
// increased Android "display size" (which shrinks the dp budget available
// on screen even though physical pixels are unchanged) plus a larger font
// scale, a fixed-height hero image can push primary CTAs toward — or past —
// the bottom safe-area, where the system navigation bar/gesture zone can
// swallow taps meant for the app. These helpers compute layout in terms of
// the actual measured window/inset values instead of a fixed constant.

/** Hard floor so the hero image never collapses to nothing on tiny screens. */
export const WELCOME_HERO_MIN_HEIGHT = 160;

/** Hard ceiling — matches the original fixed-height design intent. */
export const WELCOME_HERO_MAX_HEIGHT = 320;

/** Proportion of window height the hero image should target. */
export const WELCOME_HERO_HEIGHT_RATIO = 0.34;

/**
 * Responsive hero image height for the Welcome step.
 *
 * Scales with the actual window height (which shrinks under Android's
 * "Display size" accessibility setting) instead of a fixed 320dp constant,
 * clamped to a sane min/max so the image never disappears or dominates.
 */
export function getWelcomeHeroImageHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) {
    return WELCOME_HERO_MIN_HEIGHT;
  }
  const proportional = windowHeight * WELCOME_HERO_HEIGHT_RATIO;
  return Math.max(WELCOME_HERO_MIN_HEIGHT, Math.min(WELCOME_HERO_MAX_HEIGHT, proportional));
}

/** Minimum bottom clearance applied even if safe-area insets report 0. */
export const MIN_SYSTEM_NAV_CLEARANCE = 16;

/**
 * Bottom scroll-content clearance for onboarding steps.
 *
 * Floors the reported safe-area bottom inset at a small minimum so a
 * cold-start frame (before native insets are measured) or a misreported
 * zero inset never lets interactive content render flush with — or inside
 * — the system navigation area. `extra` is additional breathing room
 * (e.g. SPACING.xl) layered on top of the real/floored inset.
 */
export function getOnboardingBottomClearance(insetsBottom: number, extra: number): number {
  const safeInset = Number.isFinite(insetsBottom) && insetsBottom > MIN_SYSTEM_NAV_CLEARANCE
    ? insetsBottom
    : MIN_SYSTEM_NAV_CLEARANCE;
  const safeExtra = Number.isFinite(extra) && extra > 0 ? extra : 0;
  return safeInset + safeExtra;
}
