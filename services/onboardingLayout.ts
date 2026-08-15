// Onboarding layout arithmetic.
//
// KSB29-058. This module existed in the approved Build 28 line and did not
// survive the Build 28 -> Build 29 fork. OnboardingShell went back to using
// `insets.bottom + SPACING.xl` directly, which is the defect: when the measured
// bottom inset is 0 — a cold-start frame before native insets are resolved, or
// a device that misreports it — the padding collapses to SPACING.xl alone and
// the step's call-to-action can render inside the system navigation/gesture
// area.
//
// On onboarding that CTA is the user's AI-processing consent gate, so this is
// not cosmetic: a consent control the user cannot reliably press, or presses by
// accident while swiping the system gesture bar, is a consent problem.
//
// DELIBERATELY NARROWER THAN THE BUILD 28 MODULE. Build 28 also exported
// welcome-hero sizing constants (WELCOME_HERO_MIN_HEIGHT and friends). Build 29
// has no consumer for them, so restoring them here would add dead code to close
// an accessibility defect. Only the clearance contract is forward-ported.

/** Minimum bottom clearance applied even if safe-area insets report 0. */
export const MIN_SYSTEM_NAV_CLEARANCE = 16;

/**
 * Bottom scroll-content clearance for onboarding steps.
 *
 * Floors the reported safe-area bottom inset at a small minimum so a cold-start
 * frame or a misreported zero inset never lets interactive content render flush
 * with — or inside — the system navigation area. `extra` is additional
 * breathing room (e.g. SPACING.xl) layered on top of the real/floored inset.
 *
 * Non-finite and negative inputs are treated as absent rather than trusted: a
 * NaN inset would otherwise propagate into the style and produce no padding at
 * all, which is the exact failure this floor exists to prevent.
 */
export function getOnboardingBottomClearance(insetsBottom: number, extra: number): number {
  const safeInset = Number.isFinite(insetsBottom) && insetsBottom > MIN_SYSTEM_NAV_CLEARANCE
    ? insetsBottom
    : MIN_SYSTEM_NAV_CLEARANCE;
  const safeExtra = Number.isFinite(extra) && extra > 0 ? extra : 0;
  return safeInset + safeExtra;
}
