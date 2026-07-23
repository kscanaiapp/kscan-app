import {
  addDaysIso,
  appendTransition,
  corsHeaders,
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

const deletionRequestNote = 'User-initiated deletion request from K Scan AI mobile app.';
const ACTIVE_STATUSES = ['pending', 'processing', 'deactivated', 'purging', 'legal_hold'];

function isMissingColumn(detail: string, column: string) {
  return detail.includes('PGRST204') && detail.includes(`'${column}' column`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const user = await requireUser(req);
    const safeUid = shortUserId(user.id);

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
      logEvent('deletion_request_idempotent', {
        uid: safeUid,
        status: existing.status,
      });
      return json({
        status: existing.status === 'pending' ? 'deactivated' : existing.status,
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
      request_source: 'mobile_app',
      notes: deletionRequestNote,
      subject_ref: subjectRef,
      requested_at: requestedAt,
      deactivated_at: requestedAt,
      grace_period_ends_at: gracePeriodEndsAt,
      restoration_token_hash: tokenHash,
      restoration_token_expires_at: gracePeriodEndsAt,
      restoration_email_count: 0,
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
          return json({
            status: 'deactivated',
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
      // Request row is durable; surface soft failure but do not erase the request.
    }

    await appendTransition({
      requestId: deletionRequest.id,
      subjectRef: deletionRequest.subject_ref ?? subjectRef,
      fromState: null,
      toState: 'deactivated',
      actorType: 'user',
      reasonCode: 'USER_REQUESTED',
      metadata: { request_source: 'mobile_app' },
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

    logEvent('deletion_request_accepted', {
      uid: safeUid,
      gracePeriodEndsAt: deletionRequest.grace_period_ends_at ?? gracePeriodEndsAt,
      sessionRevocationOk: revocation.ok,
      restorationEmailQueued,
    });

    return json({
      status: 'deactivated',
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
