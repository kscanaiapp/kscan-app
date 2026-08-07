function validateNewPassword(password) {
  if (!password) return 'Enter a new password.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

async function verifySessionAfterPasswordUpdate(supabase) {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data?.user) throw new Error('Session verification failed.');
  return data.user;
}

/**
 * Copy for the one outcome the user can act on: the password changed but the
 * revocation did not, so other sessions may still hold refresh capability.
 */
const REVOKE_FAILED_MESSAGE =
  'Password changed, but we could not revoke existing sessions. Reconnect and try again.';

/**
 * The complete post-recovery password update sequence, shared by both platform
 * lines so the security behaviour cannot drift between them.
 *
 * A password change is a SECURITY BOUNDARY. On success every session is revoked
 * globally — including this recovery session — so an old refresh token held in
 * secure storage on another device cannot silently restore access, and the user
 * must prove the new password.
 *
 * Ordering is the whole contract:
 *
 *   - validation failure  -> nothing is called, nothing is revoked;
 *   - update failure      -> NO sign-out. Revoking here would punish a user for
 *                            a weak-password rejection or a network blip by
 *                            destroying a session whose password never changed;
 *   - update success      -> global sign-out, then route to the signed-out
 *                            screen so the new password is exercised.
 *
 * Returns a decision, never navigation: the caller owns routing. `stage` names
 * the furthest point reached, so a caller (or a test) can tell "did not revoke
 * because the update failed" apart from "tried to revoke and could not".
 */
async function updatePasswordAndRevokeSessions(supabase, password) {
  const validationError = validateNewPassword(password);
  if (validationError) {
    return { ok: false, revoked: false, stage: 'validation', route: null, message: validationError };
  }

  const { error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError) {
    return { ok: false, revoked: false, stage: 'update', route: null, updateError, message: null };
  }

  const { error: revokeError } = await supabase.auth.signOut({ scope: 'global' });
  if (revokeError) {
    return {
      ok: false,
      revoked: false,
      stage: 'revoke',
      route: null,
      message: REVOKE_FAILED_MESSAGE,
    };
  }

  return { ok: true, revoked: true, stage: 'complete', route: '/auth', message: null };
}

module.exports = {
  REVOKE_FAILED_MESSAGE,
  updatePasswordAndRevokeSessions,
  validateNewPassword,
  verifySessionAfterPasswordUpdate,
};
