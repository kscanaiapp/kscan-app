async function getPendingDeletionRequest(supabase, userId) {
  // Prefer the safe status RPC when available (hides worker/token fields).
  try {
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_my_deletion_status');
    if (!rpcError && Array.isArray(rpcData) && rpcData[0]) {
      const row = rpcData[0];
      return {
        id: null,
        status: row.status,
        requested_at: row.requested_at,
        grace_period_ends_at: row.grace_period_ends_at,
      };
    }
  } catch {
    // Fall through to legacy select if RPC is unavailable.
  }

  const { data, error } = await supabase
    .from('deletion_requests')
    .select('id,status,requested_at,grace_period_ends_at')
    .eq('user_id', userId)
    .in('status', ['pending', 'processing', 'deactivated', 'purging', 'legal_hold', 'failed'])
    .order('requested_at', { ascending: false })
    .limit(1);

  if (error) {
    // After RLS tightening, direct selects may be denied — treat as no visible request.
    if (String(error.message || '').toLowerCase().includes('permission') || error.code === '42501') {
      return null;
    }
    throw error;
  }
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

  if (data.alreadyRequested || data.status === 'already_requested') {
    return {
      status: 'already_requested',
      request: {
        requested_at: data.requestedAt || data.requested_at,
        grace_period_ends_at: data.gracePeriodEndsAt || data.grace_period_ends_at || null,
      },
    };
  }

  const status = data.status;
  const requestedAt = data.requestedAt || data.requested_at;
  const gracePeriodEndsAt = data.gracePeriodEndsAt || data.grace_period_ends_at;

  // Accept legacy 'pending' and new 'deactivated' lifecycle responses.
  if ((status !== 'pending' && status !== 'deactivated') || !requestedAt) {
    throw new Error('Unexpected response from deletion service.');
  }

  return {
    status: 'submitted',
    request: {
      id: data.request_id || null,
      status: status === 'deactivated' ? 'deactivated' : 'pending',
      requested_at: requestedAt,
      grace_period_ends_at: gracePeriodEndsAt || null,
      restoration_email_queued: Boolean(data.restorationEmailQueued),
    },
  };
}

async function resendRestorationEmail(supabase, email) {
  const { data, error } = await supabase.functions.invoke('resend-restoration-email', {
    body: { email },
  });
  if (error) {
    throw new Error(error.message || 'Unable to resend restoration email.');
  }
  return data || {
    status: 'ok',
    message:
      'If an eligible deletion request exists for that email, a restoration message has been sent.',
  };
}

async function restoreAccountWithToken(supabase, token) {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed || trimmed.length < 32) {
    throw new Error('Invalid restoration token.');
  }
  const { data, error } = await supabase.functions.invoke('restore-account', {
    body: { token: trimmed },
  });
  if (error) {
    throw new Error(error.message || 'Unable to restore account.');
  }
  if (!data || (data.status !== 'restored' && data.status !== 'restored_pending_unban')) {
    throw new Error(data?.error || 'Unable to restore account.');
  }
  return data;
}

module.exports = {
  getPendingDeletionRequest,
  submitAccountDeletionRequest,
  resendRestorationEmail,
  restoreAccountWithToken,
};
