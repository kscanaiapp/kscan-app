'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

/**
 * Sign in with Apple during the 30-day deletion restoration window.
 *
 * The account is banned, Supabase refuses the sign-in with `user_banned`, and
 * the Apple branch told the person to "try again". It now points them to the
 * restoration email. Email and Google sign-in are shared code and unchanged.
 */

const ROOT = path.resolve(__dirname, '..');

// ── Sign in with Apple during the restoration window ────────────────────────

const AUTH_SCREEN = 'app/auth/index.tsx';

function loadBannedClassifier(source) {
  const start = source.indexOf('function isBannedSignInError(');
  assert.notEqual(start, -1, 'the classifier exists');
  const end = source.indexOf('\n}\n', start);
  const js = ts.transpileModule(source.slice(start, end + 2), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return vm.runInNewContext(`${js}\nisBannedSignInError`);
}

test('the Apple branch recognises a banned (pending-deletion) sign-in', () => {
  const isBanned = loadBannedClassifier(fs.readFileSync(path.join(ROOT, AUTH_SCREEN), 'utf8'));
  assert.equal(isBanned({ code: 'user_banned', message: 'User is banned' }), true);
  assert.equal(isBanned({ message: 'User is banned' }), true);
  assert.equal(isBanned({ code: 'invalid_credentials', message: 'Invalid login credentials' }), false);
  assert.equal(isBanned({ message: 'Unbanned token refresh' }), false);
  assert.equal(isBanned(null), false);
});

test('a banned Apple sign-in points to the restoration email; other failures keep the retry copy', () => {
  const source = fs.readFileSync(path.join(ROOT, AUTH_SCREEN), 'utf8');
  const appleStart = source.indexOf('const handleAppleSignIn');
  const appleEnd = source.indexOf('\n  const ', appleStart + 1);
  const apple = source.slice(appleStart, appleEnd === -1 ? undefined : appleEnd);

  assert.match(apple, /isBannedSignInError\(signInError\)\s*\?\s*APPLE_SIGN_IN_BLOCKED_MESSAGE/);
  assert.match(apple, /'We could not complete Apple sign-in\. Please try again\.'/);
  assert.match(source, /APPLE_SIGN_IN_BLOCKED_MESSAGE =\s*\n?\s*"[^"]*restoration link[^"]*"/);
  assert.equal(
    source.split('isBannedSignInError(signInError)').length - 1,
    1,
    'only the iOS Apple branch uses it; email and Google sign-in are shared code and unchanged',
  );
});
