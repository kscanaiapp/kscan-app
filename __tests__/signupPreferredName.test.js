const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSignupNameMetadata, resolvePreferredName } = require('../services/userFirstName.ts');

const ROOT = path.resolve(__dirname, '..');

test('email signup retains the collected full name and style nickname', () => {
  assert.deepEqual(
    buildSignupNameMetadata({ fullName: '  Tester   Five  ', styleNickname: '  Tester   5  ' }),
    { full_name: 'Tester Five', first_name: 'Tester', style_nickname: 'Tester 5' },
  );
});

test('preferred greeting is nickname then established first-name chain, never email', () => {
  assert.equal(resolvePreferredName({ id: 'a', user_metadata: { style_nickname: 'The Edit' } }), 'The Edit');
  assert.equal(resolvePreferredName({ id: 'b', user_metadata: { full_name: 'Ada Lovelace' } }), 'Ada');
  assert.equal(resolvePreferredName({ id: 'c', user_metadata: { email: 'person@example.com' } }), null);
});

test('signup and Home are wired to the shared name contract', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');
  const onboarding = fs.readFileSync(path.join(ROOT, 'app/onboarding/index.tsx'), 'utf8');
  const home = fs.readFileSync(path.join(ROOT, 'components/home/HomeLuxuryTechV1.tsx'), 'utf8');
  assert.match(auth, /buildSignupNameMetadata\(profile \?\? \{\}\)/);
  assert.match(auth, /data: nameMetadata/);
  assert.match(onboarding, /signUp\(trimmedEmail, password, \{ fullName, styleNickname \}\)/);
  assert.match(home, /const preferredName = resolvePreferredName\(user\)/);
});
