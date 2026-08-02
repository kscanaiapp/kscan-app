import {
  addDaysIso,
  appendTransition,
  corsHeaders,
  deliverLifecycleAlert,
  generateRestorationToken,
  hashRestorationToken,
  json,
  logEvent,
  requireUser,
  rest,
  revokeAllSessions,
  sendRestorationEmail,
  buildRestorationUrl,
  shortUserId,
} from '../_shared/deletion/common.ts';

const ACTIVE_STATUSES = ['pending', 'processing', 'deactivated', 'purging', 'legal_hold'];

function deletionRequestSource(req: Request): 'external_web' | 'mobile_app' {
  return req.headers.get('x-deletion-request-source')?.trim() === 'external_web'
    ? 'external_web'
    : 'mobile_app';
}

async function appendIntakeEvidenceEvent(input: {
  requestId: string;
  userId: string;
  requestSource: 'external_web' | 'mobile_app';
}) {
  const response = await rest('rpc/append_account_lifecycle_event', {
    method: 'POST',
    body: JSON.stringify({
      p_deletion_request_id: input.requestId,
      p_correlation_id: input.requestId,
      p_event_type:
        input.requestSource === 'external_web'
          ? 'DELETE_REQUEST_AUTHENTICATED_WEB'
          : 'DELETE_REQUEST_AUTHENTICATED_MOBILE',
      p_source: 'handle-user-deletion',
      p_actor_type: 'user',
      p_outcome: 'accepted',
      p_idempotency_key: `delete-intake:${input.requestId}:${input.requestSource}`,
      p_subject_user_id: input.userId,
      p_sanitized_metadata: { request_source: input.requestSource },
    }),
  });
  if (!response.ok) {
    logEvent('deletion_intake_evidence_append_failed', {
      uid: shortUserId(input.userId),
      requestSource: input.requestSource,
      status: response.status,
    });
  }
}

function isMissingColumn(detail: string, column: string) {
  return detail.includes('PGRST204') && detail.includes(`'${column}' column`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const user = await requireUser(req);
    const safeUid = shortUserId(user.id);
    const requestSource = deletionRequestSource(req);

    const openRequestResponse = await rest(
      `deletion_requests?user_id=eq.${user.id}&status=in.(${ACTIVE_STATUSES.join(',')})&select=id,status,requested_at,grace_period_ends_at,deactivated_at,restoration_email_count,restoration_email_sent_at&order=requested_at.desc&limit=1`,
      { method: 'GET' },
    );

    if (!openRequestResponse.ok) {
      return json({ error: 'Unable to check existing deletion requests' }, 500);
    }

    const openRequests = await openRequestResponse.json();
    if (Array.isArray(openRequests) && openRequests.length > 0) {
      const existing = openRequests[0];
      // Upgrade legacy pending rows into the deactivated lifecycle.
      if (existing.status === 'pending' || existing.status === 'processing') {
        const upgradeToken = generateRestorationToken();
        const upgradeHash = await hashRestorationToken(upgradeToken);
        const nowIso = new Date().toISOString();
        const grace = existing.grace_period_ends_at ?? addDaysIso(new Date(), 30);
        const upgradeResponse = await rest(`deletion_requests?id=eq.${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'deactivated',
            deactivated_at: existing.deactivated_at ?? nowIso,
            grace_period_ends_at: grace,
            restoration_token_hash: upgradeHash,
            restoration_token_expires_at: grace,
          }),
        });
        if (!upgradeResponse.ok) {
          logEvent('legacy_pending_upgrade_failed', { uid: safeUid });
          return json({ error: 'Unable to process deletion request' }, 500);
        }
        const profileUpgrade = await rest(`profiles?id=eq.${user.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            account_status: 'pending_deletion',
            deletion_requested_at: existing.requested_at ?? nowIso,
          }),
        });
        if (!profileUpgrade.ok) {
          return json({ error: 'Unable to deactivate account' }, 500);
        }
        await revokeAllSessions(user.id, user.accessToken);
        await appendIntakeEvidenceEvent({
          requestId: existing.id,
          userId: user.id,
          requestSource,
        });
        let queued = false;
        if (user.email) {
          const emailResult = await sendRestorationEmail({
            to: user.email,
            requestId: existing.id,
            requestedAt: existing.requested_at ?? nowIso,
            gracePeriodEndsAt: grace,
            restorationUrl: buildRestorationUrl(upgradeToken),
            kind: 'request',
          });
          queued = emailResult.queued;
          if (queued) {
            await rest(`deletion_requests?id=eq.${existing.id}`, {
              method: 'PATCH',
              body: JSON.stringify({
                confirmation_email_sent_at: new Date().toISOString(),
                initial_deletion_notice_verified: true,
                notification_review_required: false,
              }),
            });
          }
        }
        if (user.email && !queued) {
          await deliverLifecycleAlert({
            event: 'USER_DELETION_EMAIL_FAILED',
            deletionRequestId: existing.id,
            lifecycleState: 'deactivated',
            userReference: safeUid,
            severity: 'warning',
          });
        }
        await deliverLifecycleAlert({
          event: 'DELETION_REQUEST_ACCEPTED',
          deletionRequestId: existing.id,
          lifecycleState: 'deactivated',
          userReference: safeUid,
          severity: 'info',
        });
        return json({
          status: 'deactivated',
          deletionRequestId: existing.id,
          correlationId: existing.id,
          requestedAt: existing.requested_at,
          gracePeriodEndsAt: grace,
          restorationEmailQueued: queued,
          alreadyRequested: true,
          upgradedFromLegacy: true,
        });
      }

      logEvent('deletion_request_idempotent', {
        uid: safeUid,
        status: existing.status,
        requestSource,
      });
      await appendIntakeEvidenceEvent({
        requestId: existing.id,
        userId: user.id,
        requestSource,
      });
      await deliverLifecycleAlert({
        event: 'DELETION_REQUEST_ACCEPTED',
        deletionRequestId: existing.id,
        lifecycleState: existing.status,
        userReference: safeUid,
        severity: 'info',
      });
      return json({
        status: existing.status,
        deletionRequestId: existing.id,
        correlationId: existing.id,
        requestedAt: existing.requested_at,
        gracePeriodEndsAt: existing.grace_period_ends_at ?? null,
        restorationEmailQueued: false,
        alreadyRequested: true,
      });
    }

    const now = new Date();
    const requestedAt = now.toISOString();
    const gracePeriodEndsAt = addDaysIso(now, 30);
    const subjectRef = crypto.randomUUID();
    const rawToken = generateRestorationToken();
    const tokenHash = await hashRestorationToken(rawToken);

    const insertBody: Record<string, unknown> = {
      user_id: user.id,
      status: 'deactivated',
      request_source: requestSource,
      notes:
        requestSource === 'external_web'
          ? 'Authenticated user-initiated deletion request from K Scan AI website.'
          : 'User-initiated deletion request from K Scan AI mobile app.',
      subject_ref: subjectRef,
      requested_at: requestedAt,
      deactivated_at: requestedAt,
      grace_period_ends_at: gracePeriodEndsAt,
      restoration_token_hash: tokenHash,
      restoration_token_expires_at: gracePeriodEndsAt,
      restoration_email_count: 0,
      initial_deletion_notice_verified: false,
      notification_review_required: true,
    };

    let insertResponse = await rest('deletion_requests', {
      method: 'POST',
      body: JSON.stringify(insertBody),
    });

    if (!insertResponse.ok) {
      const detail = await insertResponse.text();
      if (isMissingColumn(detail, 'notes')) {
        delete insertBody.notes;
        insertResponse = await rest('deletion_requests', {
          method: 'POST',
          body: JSON.stringify(insertBody),
        });
      } else if (detail.toLowerCase().includes('duplicate') || insertResponse.status === 409) {
        // Race: another request won the unique index.
        const retry = await rest(
          `deletion_requests?user_id=eq.${user.id}&status=in.(${ACTIVE_STATUSES.join(',')})&select=id,status,requested_at,grace_period_ends_at&order=requested_at.desc&limit=1`,
          { method: 'GET' },
        );
        const rows = retry.ok ? await retry.json() : [];
        if (Array.isArray(rows) && rows[0]) {
          await deliverLifecycleAlert({
            event: 'DELETION_REQUEST_ACCEPTED',
            deletionRequestId: rows[0].id,
            lifecycleState: 'deactivated',
            userReference: safeUid,
            severity: 'info',
          });
          return json({
            status: 'deactivated',
            deletionRequestId: rows[0].id,
            correlationId: rows[0].id,
            requestedAt: rows[0].requested_at,
            gracePeriodEndsAt: rows[0].grace_period_ends_at ?? null,
            restorationEmailQueued: false,
            alreadyRequested: true,
          });
        }
        logEvent('deletion_request_insert_conflict', { uid: safeUid });
        return json({ error: 'Unable to create deletion request' }, 500);
      } else {
        logEvent('deletion_request_insert_failed', {
          uid: safeUid,
          status: insertResponse.status,
        });
        return json({ error: 'Unable to create deletion request' }, 500);
      }
    }

    if (!insertResponse.ok) {
      return json({ error: 'Unable to create deletion request' }, 500);
    }

    const [deletionRequest] = await insertResponse.json();

    const profileResponse = await rest(`profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        account_status: 'pending_deletion',
        deletion_requested_at: deletionRequest.requested_at ?? requestedAt,
      }),
    });
    if (!profileResponse.ok) {
      logEvent('profile_pending_update_failed', {
        uid: safeUid,
        status: profileResponse.status,
      });
      // Compensating action: mark request failed so purge cannot proceed without deactivation.
      await rest(`deletion_requests?id=eq.${deletionRequest.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'failed',
          failure_code: 'PROFILE_DEACTIVATION_FAILED',
          failure_message: 'Could not set profiles.account_status=pending_deletion',
          restoration_token_hash: null,
          restoration_token_expires_at: null,
        }),
      });
      return json({ error: 'Unable to deactivate account' }, 500);
    }

    // Ban auth login for the grace window (unbanned on restore). Access JWTs still
    // expire naturally; Edge guards + session revoke cover the data plane.
    try {
      const { createClient } = await import('npm:@supabase/supabase-js@2');
      const admin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      await admin.auth.admin.updateUserById(user.id, { ban_duration: '720h' });
    } catch {
      logEvent('auth_ban_failed', { uid: safeUid });
    }

    await appendTransition({
      requestId: deletionRequest.id,
      subjectRef: deletionRequest.subject_ref ?? subjectRef,
      fromState: null,
      toState: 'deactivated',
      actorType: 'user',
      reasonCode: 'USER_REQUESTED',
      metadata: { request_source: requestSource },
    });

    await appendIntakeEvidenceEvent({
      requestId: deletionRequest.id,
      userId: user.id,
      requestSource,
    });

    const revocation = await revokeAllSessions(user.id, user.accessToken);
    if (!revocation.ok) {
      logEvent('session_revocation_failure_surfaced', {
        uid: safeUid,
        method: revocation.method,
      });
    }

    let restorationEmailQueued = false;
    if (user.email) {
      const emailResult = await sendRestorationEmail({
        to: user.email,
        requestId: deletionRequest.id,
        requestedAt: deletionRequest.requested_at ?? requestedAt,
        gracePeriodEndsAt: deletionRequest.grace_period_ends_at ?? gracePeriodEndsAt,
        restorationUrl: buildRestorationUrl(rawToken),
        kind: 'request',
      });
      restorationEmailQueued = emailResult.queued;
      if (emailResult.queued) {
        await rest(`deletion_requests?id=eq.${deletionRequest.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            restoration_email_sent_at: new Date().toISOString(),
            restoration_email_count: 1,
            confirmation_email_sent_at: new Date().toISOString(),
            initial_deletion_notice_verified: true,
            notification_review_required: false,
          }),
        });
      } else {
        logEvent('restoration_email_failed_request_intact', {
          uid: safeUid,
          provider: emailResult.provider,
        });
      }
    } else {
      logEvent('restoration_email_skipped_no_email', { uid: safeUid });
    }

    if (user.email && !restorationEmailQueued) {
      await deliverLifecycleAlert({
        event: 'USER_DELETION_EMAIL_FAILED',
        deletionRequestId: deletionRequest.id,
        lifecycleState: 'deactivated',
        userReference: safeUid,
        severity: 'warning',
      });
    }
    await deliverLifecycleAlert({
      event: 'DELETION_REQUEST_ACCEPTED',
      deletionRequestId: deletionRequest.id,
      lifecycleState: 'deactivated',
      userReference: safeUid,
      severity: 'info',
    });

    logEvent('deletion_request_accepted', {
      uid: safeUid,
      gracePeriodEndsAt: deletionRequest.grace_period_ends_at ?? gracePeriodEndsAt,
      sessionRevocationOk: revocation.ok,
      restorationEmailQueued,
      requestSource,
    });

    return json({
      status: 'deactivated',
      deletionRequestId: deletionRequest.id,
      correlationId: deletionRequest.id,
      requestedAt: deletionRequest.requested_at ?? requestedAt,
      gracePeriodEndsAt: deletionRequest.grace_period_ends_at ?? gracePeriodEndsAt,
      restorationEmailQueued,
      sessionRevocationOk: revocation.ok,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('deletion_request_unexpected_error', {
      type: error instanceof Error ? error.name : 'unknown',
    });
    return json({ error: 'Unable to process deletion request' }, 500);
  }
});
