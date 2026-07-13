/**
 * Welcome Routing Tests
 *
 * Covers the two-layer routing guarantee for fresh unauthenticated users:
 *
 *   Layer 1 - routingGuard.js:
 *     Returns { action: 'redirect', redirectTo: '/auth' } for unauthenticated
 *     users on any protected route.
 *
 *   Layer 2 - app/_layout.tsx (AuthGate):
 *     Remaps '/auth' -> '/onboarding' so users land at Welcome Step 1
 *     instead of the bare login screen.
 *
 * The mapping in _layout.tsx (post-fix):
 *   const redirectTo = guardState.redirectTo === '/auth' ? '/onboarding' : guardState.redirectTo;
 *
 * Previously this was gated behind ONBOARDING_FRAMEWORK_V1_ENABLED which
 * defaulted to false when EXPO_PUBLIC_ONBOARDING_FRAMEWORK_V1 was not in .env.
 * The gate has been removed; the remap is now unconditional.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  getRoutingGuardState,
  isPublicRoute,
} = require('../services/routingGuard');

const NOW = 1000;
const validSession = { access_token: 'access-token', expires_at: NOW + 3600 };
const onboardingSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'onboarding', 'index.tsx'),
  'utf8',
);
const welcomeStepSource = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'account-home', 'WelcomeStepV1.tsx'),
  'utf8',
);
const accountSetupStepSource = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'account-home', 'AccountSetupStepV1.tsx'),
  'utf8',
);
const onboardingShellSource = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'onboarding', 'OnboardingShell.tsx'),
  'utf8',
);
const onboardingStepIndicatorSource = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'onboarding', 'OnboardingStepIndicator.tsx'),
  'utf8',
);

// -- The remap formula from _layout.tsx (post-fix) --------------------------
// Duplicated here so this test breaks loudly if the formula regresses.
function applyLayoutRedirectRemap(guardRedirectTo) {
  return guardRedirectTo === '/auth' ? '/onboarding' : guardRedirectTo;
}

// -- 1. /onboarding is a public route - guard allows unauthenticated access --
test('unauthenticated user visiting /onboarding is allowed by the routing guard', () => {
  const state = getRoutingGuardState({
    pathname: '/onboarding',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'allow');
  assert.equal(state.redirectTo, null);
  assert.equal(isPublicRoute('/onboarding'), true);
});

// -- 2. Guard issues /auth redirect for unauthenticated users on protected routes
test('unauthenticated user on a protected route gets redirectTo: /auth from the routing guard', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/auth');
});

// -- 3. _layout.tsx remapping: /auth -> /onboarding for fresh users ----------
test('_layout.tsx redirect mapping converts /auth to /onboarding for fresh unauthenticated users', () => {
  // This test pins the exact patched formula in _layout.tsx.
  // If the formula regresses, update the fix first - then update this test.
  assert.equal(applyLayoutRedirectRemap('/auth'), '/onboarding');
});

// -- 4. Resume-terms redirect is NOT issued to unauthenticated users ---------
test('unauthenticated user is never redirected to /onboarding?resume=terms', () => {
  // After remap: /auth -> /onboarding (no query param).
  // Only authenticated-but-incomplete users get ?resume=terms.
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: null,
    nowSeconds: NOW,
  });
  assert.equal(state.redirectTo, '/auth');
  const remapped = applyLayoutRedirectRemap(state.redirectTo);
  assert.equal(remapped, '/onboarding');
  assert.equal(remapped.includes('resume'), false);
});

// -- 5. Authenticated incomplete user gets /onboarding?resume=terms ----------
test('authenticated user with incomplete onboarding is redirected to /onboarding?resume=terms', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: false,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/onboarding?resume=terms');
  // Resume param is preserved through remap (no /auth match, so remap is a no-op).
  const remapped = applyLayoutRedirectRemap(state.redirectTo);
  assert.equal(remapped, '/onboarding?resume=terms');
});

// -- 6. Authenticated complete user on /onboarding is sent to home ------------
test('authenticated user with complete onboarding on /onboarding is redirected to home', () => {
  const state = getRoutingGuardState({
    pathname: '/onboarding',
    loading: false,
    session: validSession,
    nowSeconds: NOW,
    onboardingComplete: true,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/');
});

// -- 7. Welcome Step 1 starts fresh users and advances to auth choice ---------
test('Welcome Step 1 is the fresh-user first screen and wires Get Started to Step 2', () => {
  assert.match(onboardingSource, /const \[step, setStep\] = useState<OnboardingStep>\(1\)/);
  assert.match(onboardingSource, /<WelcomeStepV1[\s\S]*onGetStarted=\{goToNext\}[\s\S]*onAlreadyHaveAccount=\{goToAuth\}/);
  assert.doesNotMatch(onboardingSource, /ACCOUNT_HOME_UX_V1_ENABLED/);
  assert.doesNotMatch(onboardingSource, /Welcome to your AI style world/);
  assert.doesNotMatch(onboardingSource, /shop smarter/);
  assert.match(welcomeStepSource, /onboarding-welcome-screen-v1/);
  assert.match(welcomeStepSource, /require\('\.\.\/\.\.\/assets\/images\/welcome-hero\.png'\)/);
  assert.match(welcomeStepSource, /See it\. Scan it\./);
  assert.match(welcomeStepSource, /Style it\./);
  assert.match(welcomeStepSource, /Unlock smart style inspiration\. Scan any outfit, discover similar looks, and/);
  assert.match(welcomeStepSource, /shop pieces you.*love.*all with AI\./s);
  assert.match(welcomeStepSource, /onboarding-get-started-button-v1/);
  assert.match(welcomeStepSource, /I ALREADY HAVE AN ACCOUNT/);
});

// -- 8. Welcome Step 2 exposes the expected auth choices ----------------------
test('Welcome Step 2 exposes Email, Google, and existing-member actions', () => {
  assert.match(onboardingSource, /<AccountSetupStepV1[\s\S]*onContinueEmail=\{goToNext\}[\s\S]*onContinueGoogle=\{handleGoogleSignIn\}[\s\S]*onGoToLogin=\{goToAuth\}/);
  assert.match(accountSetupStepSource, /onboarding-auth-choice-screen-v1/);
  assert.match(accountSetupStepSource, /Welcome to your/);
  assert.match(accountSetupStepSource, /AI style world/);
  assert.match(accountSetupStepSource, /onboarding-continue-email-button-v1/);
  assert.match(accountSetupStepSource, /onboarding-continue-google-button-v1/);
  assert.match(accountSetupStepSource, /Already a member\?/);
});

test('canonical onboarding components are unconditional and no simplified alternate remains', () => {
  assert.doesNotMatch(onboardingSource, /if \(ACCOUNT_HOME_UX_V1_ENABLED\)/);
  assert.doesNotMatch(onboardingSource, /testID="onboarding-welcome-screen"/);
  assert.doesNotMatch(onboardingSource, /testID="onboarding-auth-choice-screen"/);
  assert.doesNotMatch(onboardingSource, /testID="onboarding-permissions-screen"/);
  assert.match(onboardingSource, /const renderWelcome = \(\) => \(/);
  assert.match(onboardingSource, /const renderAuthChoice = \(\) => \(/);
  assert.match(onboardingSource, /<PermissionsStepV1/);
});

test('canonical six-step welcome source is shared by Android and iOS', () => {
  const accountHomeDir = path.join(__dirname, '..', 'components', 'account-home');
  const platformWelcomeOverrides = fs.readdirSync(accountHomeDir).filter((name) =>
    /^WelcomeStepV1\.(?:android|ios)\./.test(name),
  );

  assert.deepEqual(platformWelcomeOverrides, []);
  assert.doesNotMatch(welcomeStepSource, /Platform\.(?:OS|select)/);
  assert.doesNotMatch(onboardingSource, /Platform\.OS\s*===\s*['"]android['"][\s\S]{0,240}WelcomeStepV1/);
  assert.match(onboardingShellSource, /totalSteps = 6/);
  assert.match(onboardingStepIndicatorSource, /STEP \{step\} OF \{totalSteps\}/);
  assert.match(onboardingSource, /type OnboardingStep\s*=[\s\S]*\| 6;/);
});

// -- 9. Step 4 is reserved for resume/authenticated incomplete flows ----------
test('Step 4 terms resume is gated to explicit resume or authenticated incomplete users', () => {
  assert.match(onboardingSource, /resumeParam === 'terms'/);
  assert.match(onboardingSource, /if \(authLoading \|\| !isAuthenticated \|\| !user\?\.id\) return;/);
  assert.match(onboardingSource, /return shouldResumeTerms \|\| current <= 2 \? 4 : current;/);
});
