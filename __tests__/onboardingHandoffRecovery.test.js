/**
 * Onboarding Handoff Recovery Tests
 *
 * Step 6 ("Entering K Scan...") is a handoff spinner with NO navigation of its
 * own. It clears only when AuthGate (app/_layout.tsx) observes onboarding
 * completion and redirects to '/'. That makes step 6 a terminal route whenever
 * the completion write does not land, so every path into it must be guarded:
 *
 *   1. No resolvable user id  -> never enter step 6 (session died mid-flow).
 *   2. Completion write fails -> leave step 6 for a retryable step.
 *
 * These are source-level assertions, matching the convention established by
 * welcomeRouting.test.js: app/onboarding/index.tsx is a TSX screen with heavy
 * react-native imports and cannot be meaningfully executed under node:test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const onboardingSource = fs.readFileSync(
  path.join(ROOT, 'app', 'onboarding', 'index.tsx'),
  'utf8',
);
const layoutSource = fs.readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');

function extractGoToHome(source) {
  const start = source.indexOf('const goToHome = useCallback(');
  assert.notEqual(start, -1, 'goToHome must exist in the onboarding screen');
  const end = source.indexOf('const goToAuth', start);
  assert.notEqual(end, -1, 'goToAuth must follow goToHome');
  return source.slice(start, end);
}

const goToHome = extractGoToHome(onboardingSource);

test('goToHome resolves a user id from the live session, not just context state', () => {
  // user?.id alone is stale when the session drops between step 4 and step 5.
  assert.match(goToHome, /supabase\.auth\.getSession\(\)/);
  assert.match(goToHome, /const resolvedUserId\s*=/);
});

test('goToHome never enters the step 6 handoff without a resolvable user id', () => {
  const guardIndex = goToHome.indexOf('if (!resolvedUserId)');
  const stepSixIndex = goToHome.indexOf('setStep(6)');

  assert.notEqual(guardIndex, -1, 'a missing-user guard must exist');
  assert.notEqual(stepSixIndex, -1, 'the handoff step must still be reachable');
  assert.ok(
    guardIndex < stepSixIndex,
    'the missing-user guard must run before setStep(6), otherwise a lost session strands the tester on the handoff spinner',
  );

  // The guard must route somewhere actionable and return before the handoff.
  const guardBlock = goToHome.slice(guardIndex, stepSixIndex);
  assert.match(guardBlock, /setStep\(2\)/, 'lost session must return to the auth choice');
  assert.match(guardBlock, /return;/, 'the guard must short-circuit before the handoff');
});

test('goToHome marks completion with the resolved id and recovers if the write fails', () => {
  assert.match(goToHome, /markOnboardingComplete\(resolvedUserId\)/);

  // A rejected completion write would leave step 6 with nothing to clear it.
  assert.match(goToHome, /try\s*\{/, 'the completion write must be guarded');
  const catchIndex = goToHome.indexOf('catch');
  assert.notEqual(catchIndex, -1, 'the completion write must have a catch');
  assert.match(
    goToHome.slice(catchIndex),
    /setStep\(5\)/,
    'a failed completion write must fall back to a retryable step, not remain on the terminal spinner',
  );
});

test('the step 6 handoff still depends on AuthGate observing completion', () => {
  // If this coupling is ever removed, the guards above stop being necessary --
  // and this test should be revisited rather than deleted.
  assert.match(layoutSource, /subscribeOnboardingCompletion\(/);
  assert.match(layoutSource, /setOnboardingComplete\(true\)/);
  assert.match(onboardingSource, /testID="onboarding-home-handoff"/);

  // Step 6 must not attempt its own navigation.
  const handoff = onboardingSource.slice(
    onboardingSource.indexOf('const renderHomeHandoff'),
    onboardingSource.indexOf('// ── Main render'),
  );
  assert.doesNotMatch(handoff, /router\.(push|replace)/);
});
