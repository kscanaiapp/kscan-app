/**
 * BUG-01 regression: onboarding CTA safe-area / system-navigation overlap.
 *
 * At increased Android display density + font scale, a hardcoded hero-image
 * height combined with unfloored safe-area padding let the "I ALREADY HAVE
 * AN ACCOUNT" CTA render inside the system navigation area, so taps hit the
 * OS Home gesture instead of the app.
 *
 * These tests exercise the real pure layout functions (not source-text
 * matching) so they fail against the pre-fix behavior: a fixed 320dp hero
 * height that never shrinks, and bottom padding that trusts a possibly-zero
 * safe-area inset with no floor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getWelcomeHeroImageHeight,
  getOnboardingBottomClearance,
  WELCOME_HERO_MIN_HEIGHT,
  WELCOME_HERO_MAX_HEIGHT,
  MIN_SYSTEM_NAV_CLEARANCE,
} = require('../services/onboardingLayout.ts');

const ROOT = path.resolve(__dirname, '..');
const SPACING_XL = 24;

// -- getWelcomeHeroImageHeight ----------------------------------------------

test('hero image height shrinks on a small/dense screen instead of staying fixed at 320', () => {
  // A common small Android profile in dp terms once "Display size" is
  // increased (e.g. 480dpi) is well under 640dp tall.
  const smallScreenHeight = 560;
  const result = getWelcomeHeroImageHeight(smallScreenHeight);
  assert.ok(result < WELCOME_HERO_MAX_HEIGHT, 'hero height must shrink below the old fixed 320dp on a small screen');
  assert.ok(result >= WELCOME_HERO_MIN_HEIGHT, 'hero height must never collapse below the floor');
});

test('hero image height is proportional to window height, not a constant', () => {
  const short = getWelcomeHeroImageHeight(600);
  const tall = getWelcomeHeroImageHeight(900);
  assert.ok(tall > short, 'a taller window must produce a taller (or equal, once clamped) hero image');
});

test('hero image height is clamped at the historical 320dp ceiling on very tall screens', () => {
  const result = getWelcomeHeroImageHeight(2000);
  assert.equal(result, WELCOME_HERO_MAX_HEIGHT);
});

test('hero image height falls back to the floor for invalid/unmeasured window height', () => {
  assert.equal(getWelcomeHeroImageHeight(0), WELCOME_HERO_MIN_HEIGHT);
  assert.equal(getWelcomeHeroImageHeight(-100), WELCOME_HERO_MIN_HEIGHT);
  assert.equal(getWelcomeHeroImageHeight(NaN), WELCOME_HERO_MIN_HEIGHT);
});

// -- getOnboardingBottomClearance --------------------------------------------

test('bottom clearance uses the real inset plus extra breathing room when insets are healthy', () => {
  const gestureNavInset = 48; // typical Android gesture-nav inset in dp
  assert.equal(getOnboardingBottomClearance(gestureNavInset, SPACING_XL), gestureNavInset + SPACING_XL);
});

test('bottom clearance never trusts a zero/misreported inset — it floors to a minimum', () => {
  // This is the exact failure mode: a cold-start frame (native insets not
  // yet measured) reporting insets.bottom === 0 must NOT leave interactive
  // content flush with the system navigation area.
  const result = getOnboardingBottomClearance(0, SPACING_XL);
  assert.ok(result >= MIN_SYSTEM_NAV_CLEARANCE + SPACING_XL,
    'zero insets must still be floored to the minimum system-nav clearance');
  assert.notEqual(result, SPACING_XL, 'clearance must not collapse to just the extra padding');
});

test('bottom clearance floors negative/invalid insets the same way', () => {
  assert.equal(getOnboardingBottomClearance(-5, SPACING_XL), MIN_SYSTEM_NAV_CLEARANCE + SPACING_XL);
  assert.equal(getOnboardingBottomClearance(NaN, SPACING_XL), MIN_SYSTEM_NAV_CLEARANCE + SPACING_XL);
});

test('bottom clearance ignores a negative/invalid extra rather than reducing the floor', () => {
  const result = getOnboardingBottomClearance(48, -100);
  assert.equal(result, 48);
});

// -- Wiring: the fix must actually be used, not just exist -------------------

test('WelcomeStepV1 no longer hardcodes the hero image height', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components/account-home/WelcomeStepV1.tsx'), 'utf8');
  assert.doesNotMatch(source, /heroImage:\s*\{[^}]*height:\s*320/s,
    'a fixed 320dp height must not be reintroduced into the heroImage style');
  assert.match(source, /getWelcomeHeroImageHeight/, 'WelcomeStepV1 must compute hero height responsively');
  assert.match(source, /useWindowDimensions/, 'WelcomeStepV1 must measure the real window to size the hero image');
});

test('OnboardingShell floors bottom padding instead of trusting raw insets.bottom', () => {
  const source = fs.readFileSync(path.join(ROOT, 'components/onboarding/OnboardingShell.tsx'), 'utf8');
  assert.match(source, /getOnboardingBottomClearance/,
    'OnboardingShell must floor bottom clearance so a zero/misreported inset cannot place content in the system nav area');
  assert.doesNotMatch(source, /paddingBottom:\s*insets\.bottom\s*\+\s*SPACING\.xl,/,
    'raw unfloored insets.bottom + SPACING.xl must not be reintroduced');
});
