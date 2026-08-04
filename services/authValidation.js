'use strict';

/**
 * @typedef {'sign-in' | 'create-account' | 'reset' | 'update-password'} AuthMode
 * @typedef {{ valid: boolean, error: string | null }} ValidationResult
 */

/**
 * Validates auth form inputs for sign-in and create-account modes.
 * @param {AuthMode} mode
 * @param {string} email
 * @param {string} password
 * @param {string} confirmPassword  - only evaluated in create-account mode
 * @returns {ValidationResult}
 */
function validateAuthInput(mode, email, password, confirmPassword) {
  const trimmedEmail = (email || '').trim();

  if (!trimmedEmail) {
    return { valid: false, error: 'Enter your email address.' };
  }
  const atIdx = trimmedEmail.indexOf('@');
  if (atIdx <= 0 || atIdx === trimmedEmail.length - 1) {
    return { valid: false, error: 'Enter a valid email address.' };
  }
  if (!password) {
    return { valid: false, error: 'Enter your password.' };
  }

  if (mode === 'create-account') {
    if (!confirmPassword) {
      return { valid: false, error: 'Confirm your password.' };
    }
    if (password !== confirmPassword) {
      return { valid: false, error: 'Passwords do not match.' };
    }
  }

  return { valid: true, error: null };
}

/**
 * Maps a raw Supabase auth error message to user-facing copy.
 * Does not over-disclose whether an email address is registered.
 * @param {string} msg
 * @param {AuthMode} mode
 * @returns {string}
 */
function mapAuthError(msg, mode) {
  const lower = (msg || '').toLowerCase();

  // Only Supabase Auth's own invalid-credentials response may produce the
  // incorrect-password message. Everything below this point must not blame
  // the user's credentials for a failure that retyping the password cannot fix.
  if (lower.includes('invalid login credentials') || lower.includes('invalid credentials')) {
    return 'Email or password is incorrect. Try again.';
  }
  if (
    lower.includes('account_unavailable') ||
    lower.includes('account is locked') ||
    lower.includes('pending_deletion')
  ) {
    return 'This account is not available. Contact support if you think this is a mistake.';
  }
  if (lower.includes('email not confirmed')) {
    return "Your email hasn't been confirmed yet. Check your inbox for the confirmation link.";
  }
  if (lower.includes('user already registered') || lower.includes('already exists')) {
    return mode === 'create-account'
      ? 'An account with this email may already exist. Try signing in instead.'
      : 'Email or password is incorrect. Try again.';
  }
  if (
    lower.includes('password') &&
    (lower.includes('least') ||
      lower.includes('short') ||
      lower.includes('minimum') ||
      lower.includes('characters'))
  ) {
    return 'Password must be at least 6 characters.';
  }
  if (
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('429')
  ) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('failed to connect')
  ) {
    return 'Network error. Check your connection and try again.';
  }

  // Unmatched failures are backend/transport problems, not credential problems.
  // Blaming the password here is what made an outage look like a wrong password.
  if (mode === 'sign-in') {
    return "We couldn't sign you in right now. This is a problem on our end — please try again in a moment.";
  }
  if (mode === 'create-account') {
    return "We couldn't create your account right now. Please try again.";
  }
  if (mode === 'reset') {
    return "We couldn't send the reset link right now. Please try again.";
  }
  if (mode === 'update-password') {
    return "We couldn't update your password right now. Please try again.";
  }
  return 'Something went wrong. Please try again.';
}

module.exports = { validateAuthInput, mapAuthError };
