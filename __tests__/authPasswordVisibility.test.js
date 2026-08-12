'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const authSource = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'auth', 'index.tsx'),
  'utf8',
);

test('sign-in password has a non-submitting accessible visibility toggle', () => {
  assert.match(authSource, /const \[passwordVisible, setPasswordVisible\] = useState\(false\)/);
  assert.match(authSource, /testID="auth-password-visibility-toggle"/);
  assert.match(authSource, /secureTextEntry=\{!passwordVisible\}/);
  assert.match(authSource, /onPress=\{\(\) => setPasswordVisible\(\(visible\) => !visible\)\}/);
  assert.match(authSource, /accessibilityLabel=\{passwordVisible \? 'Hide password' : 'Show password'\}/);
  assert.doesNotMatch(
    authSource,
    /testID="auth-password-visibility-toggle"[\s\S]{0,500}onPress=\{handleSubmit\}/,
  );
});

test('visibility changes do not mutate password values and reset on mode changes', () => {
  const switchMode = authSource.match(/const switchMode = \(newMode: AuthMode\) => \{([\s\S]*?)\n  \};/);
  assert.ok(switchMode, 'switchMode must remain explicit and testable');
  assert.match(switchMode[1], /setPasswordVisible\(false\)/);
  assert.match(switchMode[1], /setConfirmPasswordVisible\(false\)/);
  assert.doesNotMatch(switchMode[1], /setPassword\(/);

  const passwordToggle = authSource.match(
    /testID="auth-password-visibility-toggle"([\s\S]*?)<\/Pressable>/,
  );
  assert.ok(passwordToggle, 'password visibility toggle must render');
  assert.doesNotMatch(passwordToggle[1], /setPassword\(/);
});

test('create-account confirmation password uses an independent visibility state', () => {
  assert.match(
    authSource,
    /const \[confirmPasswordVisible, setConfirmPasswordVisible\] = useState\(false\)/,
  );
  assert.match(authSource, /testID="auth-confirm-password-visibility-toggle"/);
  assert.match(authSource, /secureTextEntry=\{!confirmPasswordVisible\}/);
});
