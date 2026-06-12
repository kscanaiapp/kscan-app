const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateNewPassword,
  verifySessionAfterPasswordUpdate,
} = require('../services/passwordReset');

test('validateNewPassword requires a password', () => {
  assert.match(validateNewPassword(''), /new password/i);
});

test('validateNewPassword enforces minimum length', () => {
  assert.match(validateNewPassword('short'), /8 characters/i);
});

test('verifySessionAfterPasswordUpdate returns user when session is valid', async () => {
  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
  };

  const user = await verifySessionAfterPasswordUpdate(supabase);
  assert.equal(user.id, 'user-1');
});

test('verifySessionAfterPasswordUpdate fails on 401-like auth error', async () => {
  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: null }, error: new Error('401 Unauthorized') }),
    },
  };

  await assert.rejects(
    () => verifySessionAfterPasswordUpdate(supabase),
    /401 Unauthorized/,
  );
});
