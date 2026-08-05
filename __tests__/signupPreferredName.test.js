/**
 * Email-signup name capture and the Home greeting it feeds.
 *
 * Greeting priority: style nickname -> stored first name -> first token of a
 * stored full name -> "K Scanner". OAuth identities carry no style nickname and
 * must keep resolving exactly as before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  buildSignupNameMetadata,
  resolvePreferredName,
  resolveUserFirstName,
} = require('../services/userFirstName.ts');

const asUser = (user_metadata) => ({ id: 'u', user_metadata });

// ─── Signup metadata construction ───────────────────────────────────────────

test('captures full name and nickname from the Create Account form', () => {
  assert.deepEqual(
    buildSignupNameMetadata({ fullName: 'Tester Five', styleNickname: 'Tester 5' }),
    { full_name: 'Tester Five', first_name: 'Tester', style_nickname: 'Tester 5' },
  );
});

test('omits the nickname when it is blank', () => {
  assert.deepEqual(
    buildSignupNameMetadata({ fullName: 'Tester Five', styleNickname: '' }),
    { full_name: 'Tester Five', first_name: 'Tester' },
  );
});

test('treats a whitespace-only nickname as blank', () => {
  assert.deepEqual(
    buildSignupNameMetadata({ fullName: 'Tester Five', styleNickname: '   \t  ' }),
    { full_name: 'Tester Five', first_name: 'Tester' },
  );
});

test('normalizes surrounding and repeated whitespace before persisting', () => {
  assert.deepEqual(
    buildSignupNameMetadata({ fullName: '  Tester   Five  ', styleNickname: '  Tester   5  ' }),
    { full_name: 'Tester Five', first_name: 'Tester', style_nickname: 'Tester 5' },
  );
});

test('writes no name fields at all when the form is empty', () => {
  assert.deepEqual(buildSignupNameMetadata({}), {});
  assert.deepEqual(buildSignupNameMetadata({ fullName: '  ', styleNickname: '  ' }), {});
});

test('strips control characters', () => {
  assert.deepEqual(
    buildSignupNameMetadata({ fullName: '\x00Jane Doe', styleNickname: 'J\x07Dot' }),
    { full_name: 'Jane Doe', first_name: 'Jane', style_nickname: 'JDot' },
  );
});

// ─── Greeting resolution ────────────────────────────────────────────────────

test('nickname wins over the full name and is kept whole, not split', () => {
  const meta = buildSignupNameMetadata({ fullName: 'Tester Five', styleNickname: 'Tester 5' });
  assert.equal(resolvePreferredName(asUser(meta)), 'Tester 5');
});

test('falls back to the first name when no nickname was given', () => {
  const meta = buildSignupNameMetadata({ fullName: 'Tester Five', styleNickname: '' });
  assert.equal(resolvePreferredName(asUser(meta)), 'Tester');
});

test('a whitespace-only nickname falls back to the first name', () => {
  const meta = buildSignupNameMetadata({ fullName: 'Tester Five', styleNickname: '   ' });
  assert.equal(resolvePreferredName(asUser(meta)), 'Tester');
});

test('a nickname stored as whitespace is ignored at read time too', () => {
  assert.equal(resolvePreferredName(asUser({ full_name: 'Tester Five', style_nickname: '   ' })), 'Tester');
});

test('resolves to null when there is no usable name, so Home shows K Scanner', () => {
  assert.equal(resolvePreferredName(asUser({})), null);
  assert.equal(resolvePreferredName(asUser({ email: 'eve@example.com' })), null);
  assert.equal(resolvePreferredName(null), null);
});

test('never derives a name from the email address', () => {
  assert.equal(resolvePreferredName(asUser({ email: 'tester.five@example.com' })), null);
});

// ─── OAuth must not regress ─────────────────────────────────────────────────

test('a Google identity resolves through the unchanged first-name chain', () => {
  const google = { full_name: 'Ada Lovelace', name: 'Ada Lovelace', given_name: 'Ada' };
  assert.equal(resolvePreferredName(asUser(google)), 'Ada');
  assert.equal(resolveUserFirstName(asUser(google)).firstName, 'Ada');
});

test('OAuth resolution is identical with and without the nickname step', () => {
  for (const meta of [
    { given_name: 'Ada' },
    { full_name: 'Ada Lovelace' },
    { name: 'Ada Lovelace' },
    { display_name: 'Ada Lovelace' },
    { first_name: 'Ada' },
  ]) {
    assert.equal(resolvePreferredName(asUser(meta)), resolveUserFirstName(asUser(meta)).firstName);
  }
});

// ─── Wiring ─────────────────────────────────────────────────────────────────

test('signUp forwards the form values into auth metadata', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');
  assert.match(auth, /profile\?: SignupNameInput/);
  assert.match(auth, /buildSignupNameMetadata\(profile \?\? \{\}\)/);
  // Sent at sign-up time, so the name survives email confirmation.
  assert.match(auth, /data: nameMetadata/);
});

test('the Create Account screen passes the name fields to signUp', () => {
  const onboarding = fs.readFileSync(path.join(ROOT, 'app/onboarding/index.tsx'), 'utf8');
  assert.match(onboarding, /signUp\(trimmedEmail, password, \{ fullName, styleNickname \}\)/);
});

test('Home renders the shared resolver and keeps the K Scanner fallback', () => {
  const home = fs.readFileSync(path.join(ROOT, 'components/home/HomeLuxuryTechV1.tsx'), 'utf8');
  assert.match(home, /import \{ resolvePreferredName \} from '\.\.\/\.\.\/services\/userFirstName'/);
  assert.match(home, /const preferredName = resolvePreferredName\(user\)/);
  assert.match(home, /Welcome, \$\{preferredName \?\? 'K Scanner'\}/);
  // No email-only greeting path.
  assert.doesNotMatch(home, /user_metadata/);
});
