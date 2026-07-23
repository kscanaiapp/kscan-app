import {
  buildRestorationUrl,
  corsHeaders,
  hashRestorationToken,
  json,
  logEvent,
  rpc,
  sendRestorationEmail,
} from '../_shared/deletion/common.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token || token.length < 32) {
      logEvent('restoration_rejected', { reason: 'invalid_token_shape' });
      return json({ error: 'Invalid or expired restoration link' }, 400);
    }

    const tokenHash = await hashRestorationToken(token);
    const restoreResponse = await rpc('restore_account_by_token_hash', {
      p_token_hash: tokenHash,
    });

    if (!restoreResponse.ok) {
      logEvent('restoration_rpc_failed', { status: restoreResponse.status });
      return json({ error: 'Unable to restore account' }, 500);
    }

    const rows = await restoreResponse.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      logEvent('restoration_rejected', { reason: 'no_matching_request' });
      return json({ error: 'Invalid or expired restoration link' }, 400);
    }

    const restored = rows[0];
    logEvent('restoration_succeeded', {
      requestIdPrefix: String(restored.request_id ?? '').slice(0, 8),
    });

    try {
      const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      if (restored.user_id) {
        // Unban + ensure old sessions stay dead; user must sign in again.
        await admin.auth.admin.updateUserById(restored.user_id, { ban_duration: 'none' });
        await rpc('revoke_user_sessions', { p_user_id: restored.user_id });

        const { data } = await admin.auth.admin.getUserById(restored.user_id);
        const email = data?.user?.email;
        if (email) {
          await sendRestorationEmail({
            to: email,
            requestId: String(restored.request_id),
            requestedAt: new Date().toISOString(),
            gracePeriodEndsAt: restored.grace_period_ends_at ?? new Date().toISOString(),
            restorationUrl: buildRestorationUrl(''),
            kind: 'restored',
          });
        }
      }
    } catch {
      logEvent('restoration_confirmation_email_failed', {});
    }

    return json({
      status: 'restored',
      restoredAt: new Date().toISOString(),
      message: 'Your account has been restored. Please sign in again.',
    });
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('restoration_unexpected_error', {
      type: error instanceof Error ? error.name : 'unknown',
    });
    return json({ error: 'Unable to restore account' }, 500);
  }
});
