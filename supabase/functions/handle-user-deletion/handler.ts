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
 * LINEAGE (RP-06A). This file reconciles two divergent deployed lineages:
 * the staging deployment's testable handler split, and the production
 * deployment's stronger auth/session controls. It is the SUPERSET of both --
 * the structure comes from staging, every security control that production
 * actually enforces is preserved. Specifically retained from production:
 * global session revocation, the grace-length Auth ban, and the compensating
 * `failed` write when deactivation cannot be completed. See
 * docs/staging-rebuild/deletion-lineage-reconciliation-2026-09-08.md.
 *
 * ORDERING INVARIANT (security-critical): the token hash is written as part of
 * the INSERT that creates the row, so the hash is durably persisted before the
 * email containing the raw token can possibly be sent. There is no window in
 * which a delivered restoration link has no stored hash to match.
 *
 * DEACTIVATION IS LOAD-BEARING (production semantics): if the profile cannot
 * be moved to `pending_deletion`, the request is NOT accepted. The row is
 * marked `failed`, its restoration token hash is cleared, and a 500 is
 * returned. Accepting a deletion whose account was never actually deactivated
 * would leave a row that the purge worker will eventually act on for an
 * account that still looks active -- the one failure mode worth failing the
 * whole request over.
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
  revokeAllSessions as revokeAllSessionsImpl,
  sendRestorationEmail as sendRestorationEmailImpl,
  shortUserId,
  type AuthUser,
} from '../_shared/deletion/common.ts';
import {
  generateStatusReceipt,
  hashStatusReceipt,
  isValidStatusReceipt,
} from '../_shared/deletion/statusReceipt.ts';
import {
  rateLimitedResponse,
  reservePrivacyRequestRateLimit as reserveRateLimitImpl,
  type PrivacyRateLimitAction,
} from '../_shared/privacyRequestRateLimit.ts';

/**
 * Approved lifecycle duration. Matches the advertised 30-day window in the
 * store-listing / privacy copy, `preview_pending_deletion_backfill()`, and the
 * restoration email template.
 */
const GRACE_PERIOD_DAYS = 30;

/**
 * Auth ban applied for exactly the grace window, so sign-in cannot outlive the
 * restorable period and cannot expire before it. Derived from
 * GRACE_PERIOD_DAYS rather than hardcoded so the two can never drift apart --
 * the deployed production value ('720h') is what this evaluates to today.
 * `restore-account` reverses it with `ban_duration: 'none'`.
 */
const AUTH_BAN_DURATION = `${GRACE_PERIOD_DAYS * 24}h`;

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

/**
 * Pre-Build-29 statuses. The retired intake wrote `pending` rows that carry no
 * grace window and no restoration token, so a user holding one can neither
 * restore nor be purged correctly. Production upgrades them in place on the
 * user's next request; that behaviour is preserved here.
 */
const LEGACY_UPGRADEABLE_STATUSES = ['pending', 'processing'];

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
  'id,subject_ref,status,requested_at,deactivated_at,grace_period_ends_at,' +
  'restoration_email_sent_at,restoration_email_count';

type ActiveRequestRow = {
  id: string;
  subject_ref: string | null;
  status: string;
  requested_at: string | null;
  deactivated_at: string | null;
  grace_period_ends_at: string | null;
  restoration_email_sent_at: string | null;
  restoration_email_count: number | null;
};

/**
 * Seams for test. Every one of them is a network or crypto boundary, and the
 * invariants this function must hold -- token hash persisted BEFORE the email
 * is sent, no raw token in any persisted payload or log line, no duplicate
 * lifecycle, sessions revoked and Auth banned on acceptance -- are only
 * provable if a test can observe the real call order. Production passes
 * nothing and gets the real implementations.
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
  /** Mints a deletion-status capability when the client supplied none. */
  generateStatusReceipt: () => string;
  /** Global session revocation (production control). Best-effort by design. */
  revokeSessions: (
    userId: string,
    accessToken?: string | null,
  ) => Promise<{ ok: boolean; method: string; detail?: string }>;
  /** Grace-length Auth ban (production control). Best-effort by design. */
  banAuthUser: (userId: string, duration: string) => Promise<boolean>;
  now: () => Date;
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

/**
 * Default Auth ban. Isolated here rather than in `_shared/deletion/common.ts`
 * so this reconciliation cannot alter any other deletion function's behaviour;
 * `restore-account` performs the matching unban with its own inline client.
 */
async function banAuthUserImpl(userId: string, duration: string): Promise<boolean> {
  try {
    const { createClient } = await import('npm:@supabase/supabase-js@2');
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: duration,
    });
    return !error;
  } catch {
    return false;
  }
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
 *
 * `subject_ref` is deliberately NOT sent: the column defaults to
 * `gen_random_uuid()`, so letting the database mint it keeps one source of
 * truth and removes any chance of the client and the ledger disagreeing.
 */
async function insertDeactivatedRequest(params: {
  deps: HandlerDeps;
  userId: string;
  tokenHash: string;
  requestedAt: string;
  gracePeriodEndsAt: string;
  /** SHA-256 of the deletion-status capability, or null when there is none. */
  statusReceiptHash: string | null;
  /**
   * Out-parameter: set true only if the row was actually written WITH the
   * status-receipt hash. The caller must not hand a receipt back to a client
   * whose hash never reached the database — a receipt that resolves to nothing
   * is worse than no receipt, because the client would poll it forever.
   */
  binding: { receiptBound: boolean };
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

  /**
   * The status-receipt hash is bound in the SAME insert as the lifecycle row,
   * for the same reason the restoration token hash is: the capability must be
   * durable before the request can be reported as accepted.
   *
   * It degrades instead of failing. `deletion_requests.status_receipt_hash` is
   * introduced by a source-only migration that this lane is not authorised to
   * apply, so every currently deployed environment still lacks the column. An
   * unconditional write would turn every live account deletion into a 500 the
   * moment this function shipped ahead of its migration. Losing the capability
   * costs the client a status lookup; losing the deletion costs the user their
   * ability to delete their account at all.
   */
  const receiptVariants: Array<{ bound: boolean; body: Record<string, unknown> }> =
    params.statusReceiptHash
      ? [
          { bound: true, body: { status_receipt_hash: params.statusReceiptHash } },
          { bound: false, body: {} },
        ]
      : [{ bound: false, body: {} }];

  // `notes` is the release schema; some lineages expose `internal_notes` or
  // neither. The note is operator context only -- never lifecycle state -- so
  // dropping it is always preferable to failing an accepted deletion.
  const noteVariants = [
    { label: 'notes', body: { notes: DELETION_REQUEST_NOTE } },
    { label: 'internal_notes', body: { internal_notes: DELETION_REQUEST_NOTE } },
    { label: null, body: {} },
  ];

  sourceLoop:
  for (const requestSource of REQUEST_SOURCES) {
    let sourceRejected = false;

    receiptLoop:
    for (const receiptVariant of receiptVariants) {
      for (const variant of noteVariants) {
        const response = await params.deps.rest('deletion_requests', {
          method: 'POST',
          body: JSON.stringify({
            ...base,
            request_source: requestSource,
            ...receiptVariant.body,
            ...variant.body,
          }),
        });

        if (response.ok) {
          params.binding.receiptBound = receiptVariant.bound;
          const rows = await response.json();
          return Array.isArray(rows) && rows[0] ? (rows[0] as ActiveRequestRow) : null;
        }

        const detail = await response.text();

        // The Repair 06 column is absent on this project. Drop the receipt and
        // retry; never fail an otherwise-valid deletion over it.
        if (receiptVariant.bound && isMissingColumn(detail, 'status_receipt_hash')) {
          logEvent('deletion_status_receipt_column_unavailable', { uid: safeUserId });
          continue receiptLoop;
        }

        // A collision on the receipt's own unique index means the supplied
        // capability is already bound to some OTHER lifecycle. That is a
        // receipt conflict, NOT a duplicate deletion request, and must not be
        // reported as one: retry without the receipt so the deletion still
        // succeeds. Nothing about the conflicting row is disclosed.
        if (
          receiptVariant.bound
          && isUniqueViolation(response.status, detail)
          && detail.includes('deletion_requests_status_receipt_hash_uidx')
        ) {
          logEvent('deletion_status_receipt_conflict', { uid: safeUserId });
          continue receiptLoop;
        }

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
          break receiptLoop;
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
    }

    if (!sourceRejected) return null;
    continue sourceLoop;
  }

  logEvent('deletion_request_no_accepted_source', { uid: safeUserId });
  return null;
}

/**
 * Binds a status receipt to a lifecycle that already exists.
 *
 * A user who re-requests deletion during an open lifecycle gets the existing
 * row back rather than a second one, so without this an already-deleting
 * account could never acquire a capability — including the exact case Repair 07
 * needs most, a client that lost the acceptance response and is retrying.
 *
 * Rules, all fail-safe:
 *   - no hash stored yet  -> bind the supplied one
 *   - stored hash equals the supplied one -> idempotent success
 *   - stored hash differs -> refuse; never rotate, never disclose
 *
 * Deliberately best-effort and isolated from `findActiveLifecycle`: the
 * `status_receipt_hash` column does not exist on any deployed project yet, and
 * adding it to ACTIVE_SELECT would make PostgREST reject the primary lifecycle
 * lookup outright — turning a missing column into a total deletion outage.
 * Every failure here returns false and changes nothing else.
 */
/**
 * Reads the optional `statusReceipt` field from the request body.
 *
 * Returns the receipt, `null` when the caller supplied none (the released-client
 * case: no body at all), or `'invalid'` when a receipt was supplied but is not
 * a well-formed capability.
 *
 * Bounded before parsing: the body is read only if its declared length is
 * plausible, so a hostile caller cannot make an authenticated endpoint buffer
 * an arbitrary payload.
 */
const MAX_INTAKE_BODY_BYTES = 4096;

async function readSuppliedStatusReceipt(
  req: Request,
): Promise<string | null | 'invalid'> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_INTAKE_BODY_BYTES) return 'invalid';

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (!raw) return null;
  if (raw.length > MAX_INTAKE_BODY_BYTES) return 'invalid';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Released clients are not required to send JSON. An unparseable body is
    // treated as "no receipt", never as an error.
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const value = (parsed as { statusReceipt?: unknown }).statusReceipt;
  if (value === undefined || value === null) return null;
  return isValidStatusReceipt(value) ? value : 'invalid';
}

async function bindReceiptToExistingLifecycle(params: {
  deps: HandlerDeps;
  requestId: string;
  statusReceiptHash: string;
  userId: string;
}): Promise<boolean> {
  const safeUserId = shortUserId(params.userId);
  try {
    const existing = await params.deps.rest(
      `deletion_requests?id=eq.${params.requestId}&select=status_receipt_hash&limit=1`,
      { method: 'GET' },
    );
    if (!existing.ok) return false;

    const rows = await existing.json();
    const stored = Array.isArray(rows) && rows[0]
      ? (rows[0] as { status_receipt_hash?: string | null }).status_receipt_hash ?? null
      : null;

    if (stored) {
      // Same capability presented again (a retry): idempotent, already bound.
      // A different one: the lifecycle keeps the receipt it has. Rotation is
      // deliberately not implemented — it would let anyone who can reach this
      // authenticated path invalidate a capability the real client is holding.
      if (stored === params.statusReceiptHash) return true;
      logEvent('deletion_status_receipt_already_bound', { uid: safeUserId });
      return false;
    }

    const patch = await params.deps.rest(
      `deletion_requests?id=eq.${params.requestId}&status_receipt_hash=is.null`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status_receipt_hash: params.statusReceiptHash }),
      },
    );
    return patch.ok;
  } catch {
    return false;
  }
}

/**
 * Compensating write for a deactivation that could not be completed
 * (production semantics). Marks the row `failed` and clears the restoration
 * token hash, so neither the purge worker nor a delivered restoration link can
 * act on a lifecycle whose account was never actually deactivated.
 */
async function markDeactivationFailed(
  deps: HandlerDeps,
  requestId: string,
): Promise<void> {
  const response = await deps.rest(`deletion_requests?id=eq.${requestId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'failed',
      failure_code: 'PROFILE_DEACTIVATION_FAILED',
      failure_message: 'Could not set profiles.account_status=pending_deletion',
      restoration_token_hash: null,
      restoration_token_expires_at: null,
    }),
  });
  if (!response.ok) {
    // Alertable: the row still claims an active lifecycle for an account that
    // was never deactivated, and no further automatic path corrects it.
    logEvent('ALERT_deletion_failed_marker_write_failed', {
      requestIdPrefix: requestId.slice(0, 8),
      status: response.status,
    });
  }
}

/** Truthful "a lifecycle is already running" payload. Never claims an email. */
function alreadyRequestedResponse(
  row: ActiveRequestRow,
  statusReceipt?: StatusReceiptResult,
) {
  return json({
    status: row.status,
    alreadyRequested: true,
    requestId: row.id,
    requestedAt: row.requested_at,
    gracePeriodEndsAt: row.grace_period_ends_at,
    ...statusReceiptFields(statusReceipt),
  });
}

/**
 * The receipt half of a deletion response.
 *
 * `statusReceipt` is returned ONLY when the server minted it, and only when its
 * hash actually reached the database — a receipt the server invented but did
 * not persist would resolve to nothing forever. A client-supplied receipt is
 * never echoed: the client already has it, and echoing a secret back adds a
 * second copy to every log and proxy on the return path for no benefit.
 *
 * `statusReceiptBound` is always reported truthfully, including false, so a
 * client can tell the difference between "you can poll this" and "this
 * deployment cannot answer status yet".
 */
type StatusReceiptResult = {
  bound: boolean;
  /** Present only for a server-generated receipt that was durably bound. */
  issued?: string;
};

function statusReceiptFields(result?: StatusReceiptResult) {
  if (!result) return {};
  return {
    statusReceiptBound: result.bound,
    ...(result.bound && result.issued ? { statusReceipt: result.issued } : {}),
  };
}

/**
 * Sends the restoration email and records delivery bookkeeping. Returns
 * whether the provider actually queued it -- never asserts success on the
 * caller's behalf.
 */
async function deliverRestorationEmail(params: {
  deps: HandlerDeps;
  email: string | undefined;
  requestId: string;
  requestedAt: string;
  gracePeriodEndsAt: string;
  rawToken: string;
  recordBookkeeping: boolean;
}): Promise<boolean> {
  const { deps, requestId } = params;

  if (!params.email) {
    logEvent('restoration_email_skipped_no_address', {
      requestIdPrefix: requestId.slice(0, 8),
    });
    return false;
  }

  const emailResult = await deps.sendRestorationEmail({
    to: params.email,
    requestId,
    requestedAt: params.requestedAt,
    gracePeriodEndsAt: params.gracePeriodEndsAt,
    restorationUrl: buildRestorationUrl(params.rawToken),
    kind: 'request',
  });
  const queued = emailResult.queued === true;

  if (!queued) {
    // Alertable: the account IS deactivated but the user holds no restoration
    // link. Recovery is the signed-out resend surface.
    logEvent('ALERT_request_restoration_email_not_queued', {
      requestIdPrefix: requestId.slice(0, 8),
    });
    return false;
  }

  if (params.recordBookkeeping) {
    // Bookkeeping only, and only when delivery actually succeeded, so the
    // resend rate-limit window in rotate_restoration_token_by_email counts
    // real sends. A failure to record this is not worth failing the request.
    const bookkeeping = await deps.rest(`deletion_requests?id=eq.${requestId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        restoration_email_sent_at: new Date().toISOString(),
        restoration_email_count: 1,
      }),
    });
    if (!bookkeeping.ok) {
      logEvent('restoration_email_bookkeeping_failed', {
        requestIdPrefix: requestId.slice(0, 8),
        status: bookkeeping.status,
      });
    }
  }

  return true;
}

/**
 * Moves the account out of normal use. Returns false when the profile could
 * not be deactivated, which the caller must treat as a rejected request.
 */
async function deactivateProfile(
  deps: HandlerDeps,
  userId: string,
  requestedAt: string,
): Promise<boolean> {
  const response = await deps.rest(`profiles?id=eq.${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      account_status: 'pending_deletion',
      deletion_requested_at: requestedAt,
    }),
  });
  if (!response.ok) {
    logEvent('deletion_profile_update_failed', {
      uid: shortUserId(userId),
      status: response.status,
    });
    return false;
  }
  return true;
}

/**
 * Upgrades a pre-Build-29 `pending`/`processing` row into the restorable
 * `deactivated` lifecycle, minting the restoration token it never had.
 * Preserves the production upgrade path.
 */
async function upgradeLegacyLifecycle(params: {
  deps: HandlerDeps;
  user: AuthUser;
  existing: ActiveRequestRow;
}): Promise<Response> {
  const { deps, user, existing } = params;
  const now = deps.now();
  const nowIso = now.toISOString();
  const gracePeriodEndsAt = existing.grace_period_ends_at ?? addDaysIso(now, GRACE_PERIOD_DAYS);

  const rawToken = deps.generateRestorationToken();
  const tokenHash = await hashRestorationToken(rawToken);

  // Hash persisted before any email can carry the raw token -- same ordering
  // invariant as the fresh-request path.
  const upgrade = await deps.rest(`deletion_requests?id=eq.${existing.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'deactivated',
      deactivated_at: existing.deactivated_at ?? nowIso,
      grace_period_ends_at: gracePeriodEndsAt,
      restoration_token_hash: tokenHash,
      restoration_token_expires_at: gracePeriodEndsAt,
    }),
  });
  if (!upgrade.ok) {
    logEvent('legacy_pending_upgrade_failed', { uid: shortUserId(user.id) });
    return json({ error: 'Unable to process deletion request' }, 500);
  }

  const requestedAt = existing.requested_at ?? nowIso;
  if (!(await deactivateProfile(deps, user.id, requestedAt))) {
    await markDeactivationFailed(deps, existing.id);
    return json({ error: 'Unable to deactivate account' }, 500);
  }

  const revocation = await deps.revokeSessions(user.id, user.accessToken);
  if (!revocation.ok) {
    logEvent('session_revocation_failure_surfaced', {
      uid: shortUserId(user.id),
      method: revocation.method,
    });
  }

  const restorationEmailQueued = await deliverRestorationEmail({
    deps,
    email: user.email,
    requestId: existing.id,
    requestedAt,
    gracePeriodEndsAt,
    rawToken,
    recordBookkeeping: false,
  });

  return json({
    status: 'deactivated',
    alreadyRequested: true,
    upgradedFromLegacy: true,
    requestId: existing.id,
    requestedAt,
    gracePeriodEndsAt,
    restorationEmailQueued,
    sessionRevocationOk: revocation.ok,
  });
}

const DEFAULT_DEPS: HandlerDeps = {
  requireUser: requireUserImpl,
  rest: restImpl,
  sendRestorationEmail: sendRestorationEmailImpl,
  appendTransition: appendTransitionImpl,
  reserveRateLimit: (userId, action) => reserveRateLimitImpl(userId, action),
  generateRestorationToken: generateRestorationTokenImpl,
  generateStatusReceipt,
  revokeSessions: revokeAllSessionsImpl,
  banAuthUser: banAuthUserImpl,
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

      // Optional, and parsed defensively. Released clients send no body at all
      // and this handler has never read one, so an absent, empty, non-JSON or
      // non-object body must remain exactly as valid as it is today. A
      // malformed *receipt*, however, is an explicit client error and is
      // rejected rather than silently ignored, so a client that believes it
      // holds a capability is never told its deletion succeeded without one.
      const suppliedReceipt = await readSuppliedStatusReceipt(req);
      if (suppliedReceipt === 'invalid') {
        return json({ error: 'Invalid status receipt' }, 400);
      }

      // Existing lifecycle short-circuits BEFORE rate limiting so a user can
      // always observe their own active deletion state even after exhausting
      // the abuse window that guards NEW request creation.
      const existing = await findActiveLifecycle(deps, user.id);
      if (existing) {
        if (LEGACY_UPGRADEABLE_STATUSES.includes(existing.status)) {
          return await upgradeLegacyLifecycle({ deps, user, existing });
        }
        // A retry that carries a capability can still bind it to the lifecycle
        // it already owns — this is the lost-response recovery path.
        let receiptResult: StatusReceiptResult | undefined;
        if (suppliedReceipt) {
          const bound = await bindReceiptToExistingLifecycle({
            deps,
            requestId: existing.id,
            statusReceiptHash: await hashStatusReceipt(suppliedReceipt),
            userId: user.id,
          });
          receiptResult = { bound };
        }
        return alreadyRequestedResponse(existing, receiptResult);
      }

      const rate = await deps.reserveRateLimit(user.id, 'account_deletion');
      if (!rate.allowed) {
        return rateLimitedResponse(corsHeaders, rate.retry_after_seconds ?? 60);
      }

      const now = deps.now();
      const requestedAt = now.toISOString();
      const gracePeriodEndsAt = addDaysIso(now, GRACE_PERIOD_DAYS);

      // Generated in memory and never persisted or logged in raw form. Only
      // the SHA-256 hash reaches the database; only the email carries the raw
      // value.
      const rawToken = deps.generateRestorationToken();
      const tokenHash = await hashRestorationToken(rawToken);

      // A client that supplied its own capability keeps it; otherwise the
      // server mints one so old clients gain status support without shipping.
      // Only the hash is persisted either way.
      const serverGenerated = suppliedReceipt ? null : deps.generateStatusReceipt();
      const rawStatusReceipt = suppliedReceipt ?? serverGenerated;
      const statusReceiptHash = rawStatusReceipt
        ? await hashStatusReceipt(rawStatusReceipt)
        : null;
      const binding = { receiptBound: false };

      const inserted = await insertDeactivatedRequest({
        deps,
        userId: user.id,
        tokenHash,
        requestedAt,
        gracePeriodEndsAt,
        statusReceiptHash,
        binding,
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

      // Deactivation is load-bearing: a request whose account could not be
      // deactivated must NOT be accepted (production semantics).
      const effectiveRequestedAt = inserted.requested_at ?? requestedAt;
      if (!(await deactivateProfile(deps, user.id, effectiveRequestedAt))) {
        await markDeactivationFailed(deps, inserted.id);
        return json({ error: 'Unable to deactivate account' }, 500);
      }

      // Ban sign-in for exactly the grace window (reversed by restore-account).
      // Best-effort: the data plane is already fail-closed via
      // `pending_deletion` + assertAccountActive, so this is defence in depth
      // and must not fail an otherwise-accepted deletion.
      const banned = await deps.banAuthUser(user.id, AUTH_BAN_DURATION);
      if (!banned) {
        logEvent('auth_ban_failed', { uid: shortUserId(user.id) });
      }

      await deps.appendTransition({
        requestId: inserted.id,
        // The row's own subject_ref -- the pseudonymous handle the ledger and
        // the restore/purge paths all key on. Using the request id here
        // instead would desynchronise this entry from every later transition
        // for the same subject.
        subjectRef: inserted.subject_ref ?? inserted.id,
        fromState: null,
        toState: 'deactivated',
        actorType: 'user',
        reasonCode: 'USER_REQUEST',
      });

      // Global session revocation (production control). Best-effort, but the
      // outcome is reported truthfully rather than assumed.
      const revocation = await deps.revokeSessions(user.id, user.accessToken);
      if (!revocation.ok) {
        logEvent('session_revocation_failure_surfaced', {
          uid: shortUserId(user.id),
          method: revocation.method,
        });
      }

      // --- Email: strictly after the hash is durably persisted. ------------
      const restorationEmailQueued = await deliverRestorationEmail({
        deps,
        email: user.email,
        requestId: inserted.id,
        requestedAt: effectiveRequestedAt,
        gracePeriodEndsAt: inserted.grace_period_ends_at ?? gracePeriodEndsAt,
        rawToken,
        recordBookkeeping: true,
      });

      return json({
        status: 'deactivated',
        alreadyRequested: false,
        requestId: inserted.id,
        requestedAt: effectiveRequestedAt,
        gracePeriodEndsAt: inserted.grace_period_ends_at ?? gracePeriodEndsAt,
        restorationEmailQueued,
        sessionRevocationOk: revocation.ok,
        ...statusReceiptFields({
          bound: binding.receiptBound,
          // Only a server-minted receipt is handed back. A client-supplied one
          // is never echoed.
          ...(serverGenerated ? { issued: serverGenerated } : {}),
        }),
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
