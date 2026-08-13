/**
 * Account-deletion request intake (Build 29 restorable lifecycle).
 *
 * Served by `index.ts`; kept separate so tests can exercise the request path
 * directly. See `handler.test.ts`.
 *
 * CONTRACT: this endpoint does NOT delete anything. It opens a restorable
 * lifecycle:
 *
 *   active -> deactivated -> (restored | eligible permanent purge)
 *
 * A new request creates exactly one `deactivated` deletion_requests row with a
 * 30-day grace window and a single-use restoration token whose SHA-256 hash is
 * persisted with the row. The raw token leaves this function only inside the
 * restoration email link -- it is never stored, never logged, and never
 * returned to the caller. Permanent erasure happens later in
 * process-account-deletions, and is terminal only when
 * `status = 'purged' AND purged_at IS NOT NULL`.
 *
 * ORDERING INVARIANT (security-critical): the token hash is written as part of
 * the INSERT that creates the row, so the hash is durably persisted before the
 * email containing the raw token can possibly be sent. There is no window in
 * which a delivered restoration link has no stored hash to match.
 *
 * EMAIL FAILURE SEMANTICS: acceptance of the deletion request and delivery of
 * the restoration email are separate facts. If the row is created but the mail
 * provider fails, the deletion stays ACCEPTED and the response reports
 * `restorationEmailQueued: false`. The request is never rolled back because
 * mail failed, and success is never claimed on the caller's behalf. The user's
 * recovery path is the signed-out resend surface
 * (supabase/functions/resend-restoration-email).
 */

import {
  addDaysIso,
  appendTransition as appendTransitionImpl,
  buildRestorationUrl,
  corsHeaders,
  generateRestorationToken as generateRestorationTokenImpl,
  hashRestorationToken,
  json,
  logEvent,
  requireUser as requireUserImpl,
  rest as restImpl,
  sendRestorationEmail as sendRestorationEmailImpl,
  shortUserId,
  type AuthUser,
} from '../_shared/deletion/common.ts';
import {
  rateLimitedResponse,
  reservePrivacyRequestRateLimit as reserveRateLimitImpl,
  type PrivacyRateLimitAction,
} from '../_shared/privacyRequestRateLimit.ts';

/**
 * Seams for test. Every one of them is a network or crypto boundary, and the
 * invariants this function must hold -- token hash persisted BEFORE the email
 * is sent, no raw token in any persisted payload or log line, no duplicate
 * lifecycle -- are only provable if a test can observe the real call order.
 * Production passes nothing and gets the real implementations.
 */
export type HandlerDeps = {
  requireUser: (req: Request) => Promise<AuthUser>;
  rest: (path: string, init?: RequestInit) => Promise<Response>;
  sendRestorationEmail: typeof sendRestorationEmailImpl;
  appendTransition: typeof appendTransitionImpl;
  reserveRateLimit: (
    userId: string,
    action: PrivacyRateLimitAction,
  ) => Promise<{ allowed: boolean; retry_after_seconds?: number }>;
  generateRestorationToken: () => string;
  now: () => Date;
};

/**
 * Approved lifecycle duration. Matches the advertised 30-day window in the
 * store-listing / privacy copy, `preview_pending_deletion_backfill()`, and the
 * restoration email template.
 */
const GRACE_PERIOD_DAYS = 30;

/**
 * Statuses that mean "an account-deletion lifecycle is already running".
 * MUST stay in sync with the partial unique index
 * `deletion_requests_one_active_per_user_idx` -- if this list is narrower than
 * the index, intake tries to insert a duplicate and fails with a 409 instead of
 * truthfully reporting the existing lifecycle.
 */
const ACTIVE_LIFECYCLE_STATUSES = [
  'pending',
  'processing',
  'deactivated',
  'purging',
  'legal_hold',
];

const DELETION_REQUEST_NOTE = 'User-initiated deletion request from K Scan AI mobile app.';

/**
 * `request_source` vocabularies differ by lineage and this is REAL, LIVE drift,
 * not a hypothetical: the repository migration declares
 * ('mobile_app','web_dashboard','support_ticket'), while the staging project's
 * `deletion_requests_request_source_check` actually allows
 * ('app','website','support','admin') and every existing staging row is 'app'.
 *
 * Sending only the release value would make intake fail closed on staging with
 * a 500 on every deletion request. The release value is tried FIRST so a
 * correctly-migrated project stays canonical and pays no extra round trip; the
 * fallback is attempted only when the database rejects that exact constraint.
 */
const REQUEST_SOURCES = ['mobile_app', 'app'];

const ACTIVE_SELECT =
  'id,subject_ref,status,requested_at,grace_period_ends_at,restoration_email_sent_at,restoration_email_count';

type ActiveRequestRow = {
  id: string;
  subject_ref: string | null;
  status: string;
  requested_at: string | null;
  grace_period_ends_at: string | null;
  restoration_email_sent_at: string | null;
  restoration_email_count: number | null;
};

function isMissingColumn(detail: string, column: string): boolean {
  return detail.includes('PGRST204') && detail.includes(`'${column}' column`);
}

/** PostgREST surfaces a partial-unique-index collision as SQLSTATE 23505. */
function isUniqueViolation(status: number, detail: string): boolean {
  return status === 409 || detail.includes('23505');
}

/**
 * A CHECK violation (23514) naming the request_source constraint. Deliberately
 * narrow: any OTHER check violation is a real defect and must surface as a
 * failure rather than be retried into a second confusing error.
 */
function isRequestSourceViolation(detail: string): boolean {
  return detail.includes('deletion_requests_request_source_check');
}

async function findActiveLifecycle(
  deps: HandlerDeps,
  userId: string,
): Promise<ActiveRequestRow | null> {
  const response = await deps.rest(
    `deletion_requests?user_id=eq.${userId}&status=in.(${ACTIVE_LIFECYCLE_STATUSES.join(',')})` +
      `&select=${ACTIVE_SELECT}&order=requested_at.desc&limit=1`,
    { method: 'GET' },
  );

  if (!response.ok) {
    throw json({ error: 'Unable to check existing deletion requests' }, 500);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? (rows[0] as ActiveRequestRow) : null;
}

/**
 * Creates the `deactivated` lifecycle row WITH its restoration token hash in a
 * single write. Returns the created row, or the string 'duplicate' when a
 * concurrent request already opened a lifecycle for this user.
 */
async function insertDeactivatedRequest(params: {
  deps: HandlerDeps;
  userId: string;
  tokenHash: string;
  requestedAt: string;
  gracePeriodEndsAt: string;
}): Promise<ActiveRequestRow | 'duplicate' | null> {
  const safeUserId = shortUserId(params.userId);
  const base: Record<string, unknown> = {
    user_id: params.userId,
    status: 'deactivated',
    requested_at: params.requestedAt,
    deactivated_at: params.requestedAt,
    grace_period_ends_at: params.gracePeriodEndsAt,
    // Token hash is written here, atomically with the row, so it is durable
    // before any email carrying the raw token can be sent.
    restoration_token_hash: params.tokenHash,
    restoration_token_expires_at: params.gracePeriodEndsAt,
  };

  // `notes` is the release schema; some lineages expose `internal_notes` or
  // neither. The note is operator context only -- never lifecycle state -- so
  // dropping it is always preferable to failing an accepted deletion.
  const noteVariants = [
    { label: 'notes', body: { notes: DELETION_REQUEST_NOTE } },
    { label: 'internal_notes', body: { internal_notes: DELETION_REQUEST_NOTE } },
    { label: null, body: {} },
  ];

  for (const requestSource of REQUEST_SOURCES) {
    let sourceRejected = false;

    for (const variant of noteVariants) {
      const response = await params.deps.rest('deletion_requests', {
        method: 'POST',
        body: JSON.stringify({ ...base, request_source: requestSource, ...variant.body }),
      });

      if (response.ok) {
        const rows = await response.json();
        return Array.isArray(rows) && rows[0] ? (rows[0] as ActiveRequestRow) : null;
      }

      const detail = await response.text();

      // A concurrent request already opened the lifecycle. Never retry.
      if (isUniqueViolation(response.status, detail)) {
        logEvent('deletion_request_insert_duplicate', { uid: safeUserId });
        return 'duplicate';
      }

      // Wrong vocabulary for this project: no note variant will help, so stop
      // this source immediately and try the next one.
      if (isRequestSourceViolation(detail)) {
        logEvent('deletion_request_source_rejected', {
          uid: safeUserId,
          requestSource,
        });
        sourceRejected = true;
        break;
      }

      if (variant.label && isMissingColumn(detail, variant.label)) {
        logEvent('deletion_request_note_column_unavailable', {
          uid: safeUserId,
          column: variant.label,
        });
        continue;
      }

      logEvent('deletion_request_insert_failed', {
        uid: safeUserId,
        note: variant.label ?? 'none',
        status: response.status,
      });
      return null;
    }

    if (!sourceRejected) return null;
  }

  logEvent('deletion_request_no_accepted_source', { uid: safeUserId });
  return null;
}

/** Truthful "a lifecycle is already running" payload. Never claims an email. */
function alreadyRequestedResponse(row: ActiveRequestRow) {
  return json({
    status: row.status,
    alreadyRequested: true,
    requestId: row.id,
    requestedAt: row.requested_at,
    gracePeriodEndsAt: row.grace_period_ends_at,
  });
}

const DEFAULT_DEPS: HandlerDeps = {
  requireUser: requireUserImpl,
  rest: restImpl,
  sendRestorationEmail: sendRestorationEmailImpl,
  appendTransition: appendTransitionImpl,
  reserveRateLimit: (userId, action) => reserveRateLimitImpl(userId, action),
  generateRestorationToken: generateRestorationTokenImpl,
  now: () => new Date(),
};

export function createHandler(
  overrides: Partial<HandlerDeps> = {},
): (req: Request) => Promise<Response> {
  const deps: HandlerDeps = { ...DEFAULT_DEPS, ...overrides };

  return async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const user = await deps.requireUser(req);

    // Existing lifecycle short-circuits BEFORE rate limiting so a user can
    // always observe their own active deletion state even after exhausting the
    // abuse window that guards NEW request creation.
    const existing = await findActiveLifecycle(deps, user.id);
    if (existing) {
      return alreadyRequestedResponse(existing);
    }

    const rate = await deps.reserveRateLimit(user.id, 'account_deletion');
    if (!rate.allowed) {
      return rateLimitedResponse(corsHeaders, rate.retry_after_seconds ?? 60);
    }

    const now = deps.now();
    const requestedAt = now.toISOString();
    const gracePeriodEndsAt = addDaysIso(now, GRACE_PERIOD_DAYS);

    // Generated in memory and never persisted or logged in raw form. Only the
    // SHA-256 hash reaches the database; only the email carries the raw value.
    const rawToken = deps.generateRestorationToken();
    const tokenHash = await hashRestorationToken(rawToken);

    const inserted = await insertDeactivatedRequest({
      deps,
      userId: user.id,
      tokenHash,
      requestedAt,
      gracePeriodEndsAt,
    });

    if (inserted === 'duplicate') {
      // Lost a race against a concurrent request. Report the winner's row
      // rather than inventing a second lifecycle.
      const winner = await findActiveLifecycle(deps, user.id);
      if (winner) return alreadyRequestedResponse(winner);
      return json({ error: 'Unable to create deletion request' }, 500);
    }

    if (!inserted?.id) {
      return json({ error: 'Unable to create deletion request' }, 500);
    }

    // Lock the account out of normal app use. `pending_deletion` is the only
    // non-active vocabulary `profiles.account_status` accepts, and it is what
    // routingGuard + assertAccountActive already enforce; restoration flips it
    // back to 'active'. A failure here is logged but must not fail an accepted
    // request -- the deletion_requests row is the authoritative lifecycle
    // record, and the account guard falls back to it.
    const profileResponse = await deps.rest(`profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        account_status: 'pending_deletion',
        deletion_requested_at: inserted.requested_at ?? requestedAt,
      }),
    });
    if (!profileResponse.ok) {
      logEvent('deletion_profile_update_failed', {
        uid: shortUserId(user.id),
        status: profileResponse.status,
      });
    }

    await deps.appendTransition({
      requestId: inserted.id,
      // The row's own subject_ref -- the pseudonymous handle the ledger and the
      // restore/purge paths all key on. Using the request id here instead would
      // desynchronise this entry from every later transition for the same
      // subject.
      subjectRef: inserted.subject_ref ?? inserted.id,
      fromState: null,
      toState: 'deactivated',
      actorType: 'user',
      reasonCode: 'USER_REQUEST',
    });

    // --- Email: strictly after the hash is durably persisted. ---------------
    let restorationEmailQueued = false;
    if (user.email) {
      const emailResult = await deps.sendRestorationEmail({
        to: user.email,
        requestId: inserted.id,
        requestedAt: inserted.requested_at ?? requestedAt,
        gracePeriodEndsAt: inserted.grace_period_ends_at ?? gracePeriodEndsAt,
        restorationUrl: buildRestorationUrl(rawToken),
        kind: 'request',
      });
      restorationEmailQueued = emailResult.queued === true;

      if (restorationEmailQueued) {
        // Bookkeeping only, and only when delivery actually succeeded, so the
        // resend rate-limit window in rotate_restoration_token_by_email counts
        // real sends. A failure to record this is not worth failing the
        // request over.
        const bookkeeping = await deps.rest(`deletion_requests?id=eq.${inserted.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            restoration_email_sent_at: new Date().toISOString(),
            restoration_email_count: 1,
          }),
        });
        if (!bookkeeping.ok) {
          logEvent('restoration_email_bookkeeping_failed', {
            requestIdPrefix: inserted.id.slice(0, 8),
            status: bookkeeping.status,
          });
        }
      } else {
        // Alertable: the account IS deactivated but the user holds no
        // restoration link. Recovery is the signed-out resend surface.
        logEvent('ALERT_request_restoration_email_not_queued', {
          requestIdPrefix: inserted.id.slice(0, 8),
        });
      }
    } else {
      logEvent('restoration_email_skipped_no_address', {
        requestIdPrefix: inserted.id.slice(0, 8),
      });
    }

    return json({
      status: 'deactivated',
      alreadyRequested: false,
      requestId: inserted.id,
      requestedAt: inserted.requested_at ?? requestedAt,
      gracePeriodEndsAt: inserted.grace_period_ends_at ?? gracePeriodEndsAt,
      restorationEmailQueued,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('deletion_unexpected_error', {
      type: error instanceof Error ? error.name : 'unknown',
    });
    return json({ error: 'Unable to process deletion request' }, 500);
  }
  };
}
