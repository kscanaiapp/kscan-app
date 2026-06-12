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

module.exports = {
  validateNewPassword,
  verifySessionAfterPasswordUpdate,
};
