async function getPendingDeletionRequest(supabase, userId) {
  const { data, error } = await supabase
    .from('deletion_requests')
    .select('id,status,requested_at')
    .eq('user_id', userId)
    .in('status', ['pending', 'processing'])
    .order('requested_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) ? data[0] ?? null : null;
}

async function submitAccountDeletionRequest(supabase, session) {
  const userId = session?.user?.id;
  if (!userId) throw new Error('No authenticated session. Sign in to request deletion.');

  const pending = await getPendingDeletionRequest(supabase, userId);
  if (pending) {
    return { status: 'already_requested', request: pending };
  }

  const { data, error } = await supabase
    .from('deletion_requests')
    .insert({
      user_id: userId,
      status: 'pending',
      request_source: 'mobile_app',
    })
    .select('id,status,requested_at')
    .single();

  if (error) throw error;
  return { status: 'submitted', request: data };
}

module.exports = {
  getPendingDeletionRequest,
  submitAccountDeletionRequest,
};
