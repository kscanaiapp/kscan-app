/**
 * KSB29-058 — onboarding consent bottom clearance.
 *
 * Forward-ported from the approved Build 28 guard
 * (`__tests__/onboardingWelcomeLayout.test.js`), which did not survive the
 * Build 28 -> Build 29 fork along with the module it defended.
 *
 * OnboardingShell went back to `insets.bottom + SPACING.xl`. When the measured
 * bottom inset is 0 — a cold-start frame before native insets resolve, or a
 * device that misreports it — the padding collapses to SPACING.xl alone and the
 * step's call-to-action renders inside the system navigation/gesture area.
 *
 * On onboarding that CTA is the user's AI-processing consent gate, so this is
 * not cosmetic. A consent control the user cannot reliably press — or presses
 * by accident while swiping the system gesture bar — is a consent problem.
 *
 * SCOPE NOTE: Build 28's module also carried welcome-hero sizing constants.
 * Build 29 has no consumer for them, so only the clearance contract is
 * forward-ported; restoring the rest would add dead code to close an
 * accessibility defect. The hero assertions from the Build 28 file are
 * deliberately not carried over.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SPACING_XL = 32;

function loadLayout() {
  const source = fs.readFileSync(path.join(ROOT, 'services', 'onboardingLayout.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { exports: module.exports, module };
  vm.createContext(sandbox);
  new vm.Script(output).runInContext(sandbox);
  return module.exports;
}

const { getOnboardingBottomClearance, MIN_SYSTEM_NAV_CLEARANCE } = loadLayout();

test('a healthy inset is used as reported, plus the extra breathing room', () => {
  const gestureNavInset = 48; // typical Android gesture-nav inset in dp
  assert.equal(
    getOnboardingBottomClearance(gestureNavInset, SPACING_XL),
    gestureNavInset + SPACING_XL,
  );
});

test('a zero inset is floored, never trusted', () => {
  // THE DEFECT, exactly: a cold-start frame reporting insets.bottom === 0 must
  // not leave the consent CTA flush with the system navigation area.
  const result = getOnboardingBottomClearance(0, SPACING_XL);
  assert.ok(
    result >= MIN_SYSTEM_NAV_CLEARANCE + SPACING_XL,
    'a zero inset must still floor to the minimum system-nav clearance',
  );
  assert.notEqual(result, SPACING_XL, 'clearance must not collapse to the extra padding alone');
});

test('negative and non-finite insets are floored the same way', () => {
  // A NaN inset would otherwise propagate into the style and produce no padding
  // at all — the very failure the floor exists to prevent.
  assert.equal(getOnboardingBottomClearance(-5, SPACING_XL), MIN_SYSTEM_NAV_CLEARANCE + SPACING_XL);
  assert.equal(getOnboardingBottomClearance(NaN, SPACING_XL), MIN_SYSTEM_NAV_CLEARANCE + SPACING_XL);
  assert.equal(
    getOnboardingBottomClearance(Infinity, SPACING_XL),
    MIN_SYSTEM_NAV_CLEARANCE + SPACING_XL,
  );
});

test('an invalid extra is ignored rather than reducing the floor', () => {
  assert.equal(getOnboardingBottomClearance(48, -100), 48);
  assert.equal(getOnboardingBottomClearance(48, NaN), 48);
});

test('WIRING: the shell actually uses the floor, not the raw inset', () => {
  // The Build 28 file made the same point: a fix that exists but is not called
  // is not a fix. This is what the fork lost — the arithmetic went with the
  // module, and the shell quietly reverted to the raw inset.
  const shell = fs.readFileSync(
    path.join(ROOT, 'components', 'onboarding', 'OnboardingShell.tsx'),
    'utf8',
  );
  assert.match(shell, /getOnboardingBottomClearance\(insets\.bottom, SPACING\.xl\)/);
  assert.doesNotMatch(
    shell,
    /paddingBottom:\s*insets\.bottom\s*\+/,
    'the shell must not add the raw inset directly',
  );
});
