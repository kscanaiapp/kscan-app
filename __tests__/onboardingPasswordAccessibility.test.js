// RP-112 / AUD-P5-004 — static accessibility contract for the shipping
// onboarding account form. This follows the repository's source-contract test
// style because no React Native renderer is installed for these controls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const onboarding = fs.readFileSync(path.join(ROOT, 'app', 'onboarding', 'index.tsx'), 'utf8');

function fieldBlock(testId, nextTestId) {
  const start = onboarding.indexOf(`testID="${testId}"`);
  assert.ok(start >= 0, `expected ${testId} in the shipping account form`);
  const end = nextTestId ? onboarding.indexOf(`testID="${nextTestId}"`, start + 1) : -1;
  return onboarding.slice(start, end >= 0 ? end : start + 1800);
}

function visibilityControlBlock(field) {
  const pressable = field.indexOf('<Pressable');
  assert.ok(pressable >= 0, 'expected a Pressable visibility control');
  const end = field.indexOf('</Pressable>', pressable);
  assert.ok(end > pressable, 'expected a closed Pressable visibility control');
  return field.slice(pressable, end + '</Pressable>'.length);
}

const passwordField = fieldBlock('onboarding-create-password-input', 'onboarding-create-confirm-password-input');
const confirmPasswordField = fieldBlock('onboarding-create-confirm-password-input', 'onboarding-style-nickname-input');
const passwordControl = visibilityControlBlock(passwordField);
const confirmPasswordControl = visibilityControlBlock(confirmPasswordField);

test('RP-112: both shipping password visibility controls are accessible buttons', () => {
  assert.match(passwordControl, /accessibilityRole="button"/);
  assert.match(confirmPasswordControl, /accessibilityRole="button"/);
  assert.match(passwordControl, /setPasswordVisible\(\(v\) => !v\)/);
  assert.match(confirmPasswordControl, /setConfirmPasswordVisible\(\(v\) => !v\)/);
});

test('RP-112: each control names its field and dynamically communicates the Show/Hide action', () => {
  assert.match(passwordControl, /accessibilityLabel=\{passwordVisible \? 'Hide password' : 'Show password'\}/);
  assert.match(passwordControl, /accessibilityHint=\{passwordVisible \? 'Password is currently visible\.' : 'Password is currently hidden\.'\}/);
  assert.match(confirmPasswordControl, /accessibilityLabel=\{confirmPasswordVisible \? 'Hide confirmation password' : 'Show confirmation password'\}/);
  assert.match(confirmPasswordControl, /accessibilityHint=\{confirmPasswordVisible \? 'Confirmation password is currently visible\.' : 'Confirmation password is currently hidden\.'\}/);
});

test('RP-112: password and confirmation controls remain independently identified', () => {
  assert.doesNotMatch(confirmPasswordControl, /'Show password'|'Hide password'/);
  assert.match(passwordField, /accessibilityLabel="Password"/);
  assert.match(confirmPasswordField, /accessibilityLabel="Confirm password"/);
});

test('RP-112: password content cannot reach the accessibility surface', () => {
  for (const control of [passwordControl, confirmPasswordControl]) {
    assert.doesNotMatch(control, /\$\{\s*(?:confirmPassword|password)\s*\}/);
    assert.doesNotMatch(control, /accessibility(?:Label|Hint)=\{(?:confirmPassword|password)\}/);
    assert.doesNotMatch(control, /testID=.*(?:password|confirmPassword).*\$/i);
  }
});

test('RP-112: secure entry tracks visibility, begins hidden, and keeps validation wiring unchanged', () => {
  assert.match(onboarding, /const \[passwordVisible, setPasswordVisible\] = useState\(false\)/);
  assert.match(onboarding, /const \[confirmPasswordVisible, setConfirmPasswordVisible\] = useState\(false\)/);
  assert.match(passwordField, /secureTextEntry=\{!passwordVisible\}/);
  assert.match(confirmPasswordField, /secureTextEntry=\{!confirmPasswordVisible\}/);
  assert.match(onboarding, /validateAuthInput\('create-account', email, password, confirmPassword\)/);
});

test('RP-112: visibility controls preserve a 44-point touch target without changing their visual text', () => {
  const styleStart = onboarding.indexOf('eyeToggle: {');
  const styleEnd = onboarding.indexOf('eyeToggleText:', styleStart);
  const eyeToggleStyle = onboarding.slice(styleStart, styleEnd);
  assert.match(eyeToggleStyle, /minWidth:\s*44/);
  assert.match(eyeToggleStyle, /minHeight:\s*44/);
  assert.match(passwordControl, /\{passwordVisible \? 'Hide' : 'Show'\}/);
  assert.match(confirmPasswordControl, /\{confirmPasswordVisible \? 'Hide' : 'Show'\}/);
});
