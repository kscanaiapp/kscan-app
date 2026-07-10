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

async function submitAccountDeletionRequest(supabase, _session) {
  const { data, error } = await supabase.functions.invoke('handle-user-deletion', {
    body: {},
  });

  if (error) {
    throw new Error(error.message || 'Unable to submit deletion request.');
  }

  if (!data) {
    throw new Error('Unexpected empty response from deletion service.');
  }

  if (data.status === 'already_requested') {
    return {
      status: 'already_requested',
      request: { requested_at: data.requested_at },
    };
  }

  if (data.status !== 'pending' || !data.request_id || !data.requested_at) {
    throw new Error('Unexpected response from deletion service.');
  }

  return {
    status: 'submitted',
    request: {
      id: data.request_id,
      status: 'pending',
      requested_at: data.requested_at,
    },
  };
}

module.exports = {
  getPendingDeletionRequest,
  submitAccountDeletionRequest,
};
