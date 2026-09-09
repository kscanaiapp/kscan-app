/**
 * deletion-status — post-auth terminal deletion-status lookup.
 *
 * Answers exactly one question, for exactly one lifecycle, to whoever holds
 * that lifecycle's opaque capability: has this account deletion reached a
 * terminal outcome, and is the client authorised to purge its local copy?
 *
 * WHY verify_jwt = false. This endpoint exists precisely because normal
 * authentication is gone. Deletion intake revokes sessions and bans the Auth
 * user for the 30-day grace window, and the purge worker deletes the Auth
 * identity outright — so at the moment the terminal answer finally exists,
 * there is no session, no Auth user, and no identity provider left to
 * authenticate against. Requiring a JWT would make the endpoint answerable
 * only in the window where its answer is never yet interesting. The capability
 * IS the credential: 256 bits of opaque bearer secret, matched by hash against
 * a unique index.
 *
 * READ-ONLY BY CONSTRUCTION. This function performs exactly one SELECT. It
 * cannot restore an account, cannot purge one, cannot alter lifecycle state,
 * cannot extend a grace period, cannot send mail, cannot rotate the receipt,
 * and calls no provider. Its service-role credential exists only because the
 * row it must read is not readable by an anonymous caller under RLS — the
 * caller is, by definition, no longer any user at all.
 *
 * POST, NOT GET, for a read. The capability is a secret, and GET would put it
 * in a URL: access logs, proxy telemetry, browser history and caches all
 * capture query strings. The operation is read-only; the transport choice is
 * about where the secret ends up, not about semantics.
 */

import {
  hashStatusReceipt,
  isValidStatusReceipt,
  STATUS_RECEIPT_LENGTH,
} from '../_shared/deletion/statusReceipt.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Bounded body. A capability is a fixed-width string, so anything beyond a
 * small JSON envelope around one is hostile or broken. Rejecting on the
 * declared length avoids reading an unbounded stream at all.
 */
const MAX_BODY_BYTES = 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      // Capability-derived lifecycle state must never be cached by anything
      // between this function and the caller.
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

/**
 * Deliberately identical bodies for "you sent nonsense" and "that capability
 * matches nothing". Distinguishing them would turn this endpoint into an
 * oracle for whether a given lifecycle exists.
 */
const INVALID_REQUEST = { error: 'invalid_request' };
const NOT_FOUND = { error: 'not_found' };

/** Public lifecycle vocabulary. Deliberately narrower than the internal one. */
export type PublicDeletionState = 'pending' | 'restored' | 'failed' | 'purged';

/**
 * Internal → public state mapping, derived from the actual status vocabulary
 * in deletion_requests_status_check (20260722191013_account_deletion_lifecycle)
 * rather than from an assumed list.
 *
 * `completed` maps to `pending`, not to a terminal state: canonical treats it
 * as a BLOCKING deletion state (see BLOCKING_DELETION_STATES in
 * _shared/deletion/common.ts, "this account is being deleted, or was left
 * mid-deletion"), and such rows carry no purged_at, so they must never
 * authorise a local purge.
 *
 * `cancelled` and `rejected` map to `restored`: common.ts groups them with
 * `restored` as the non-blocking terminal states in which the account remains
 * usable. The client's action is identical in all three — clear the pending
 * local-deletion marker and keep local data — and inventing a fourth outcome
 * for "the deletion is not going to happen" would give Repair 07 a distinction
 * it has no different response to.
 */
const PUBLIC_STATE_BY_INTERNAL: Record<string, PublicDeletionState> = {
  pending: 'pending',
  processing: 'pending',
  deactivated: 'pending',
  purging: 'pending',
  legal_hold: 'pending',
  completed: 'pending',
  restored: 'restored',
  cancelled: 'restored',
  rejected: 'restored',
  failed: 'failed',
  purged: 'purged',
};

type LifecycleRow = {
  status: string | null;
  purged_at: string | null;
  restored_at: string | null;
};

export type StatusResult = {
  state: PublicDeletionState;
  purgeAuthorized: boolean;
  purgedAt?: string;
  restoredAt?: string;
};

/**
 * THE TERMINAL RULE. Local purge is authorised if and only if the lifecycle
 * says BOTH that it purged and when it purged.
 *
 * Every other combination is unauthorised, including the two inconsistent
 * ones. Those two are currently unreachable through the database — the
 * deletion_requests_purged_at_status_check constraint enforces
 * `(purged_at is null and status <> 'purged') or (purged_at is not null and
 * status = 'purged')` — but this function does not rely on that. A constraint
 * can be dropped by a later migration, a replica can serve a row written
 * before it existed, and this decision authorises irreversible local data
 * destruction on a device. It is checked here as well.
 *
 * An unrecognised status also fails closed, to `pending`: the honest answer to
 * a state this contract does not know is "not terminal, keep waiting", which
 * costs the client nothing but a retained copy of its own data.
 */
export function evaluateLifecycle(row: LifecycleRow): StatusResult {
  const status = typeof row.status === 'string' ? row.status : '';
  const purgedAt = row.purged_at;
  const restoredAt = row.restored_at;

  const mapped = PUBLIC_STATE_BY_INTERNAL[status];

  // purged_at present under any status other than 'purged' is an inconsistent
  // row. Report it as non-terminal rather than trusting either half.
  if (purgedAt && status !== 'purged') {
    return { state: 'pending', purgeAuthorized: false };
  }

  if (status === 'purged') {
    if (!purgedAt) {
      // Claims terminal, cannot say when. Not terminal.
      return { state: 'purged', purgeAuthorized: false };
    }
    return { state: 'purged', purgeAuthorized: true, purgedAt };
  }

  if (mapped === 'restored') {
    return {
      state: 'restored',
      purgeAuthorized: false,
      ...(restoredAt ? { restoredAt } : {}),
    };
  }

  if (mapped === 'failed') {
    return { state: 'failed', purgeAuthorized: false };
  }

  return { state: mapped ?? 'pending', purgeAuthorized: false };
}

async function readBody(req: Request): Promise<unknown | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createHandler(
  overrides: {
    lookup?: (hash: string) => Promise<LifecycleRow | null | 'error'>;
  } = {},
): (req: Request) => Promise<Response> {
  const lookup = overrides.lookup ?? defaultLookup;

  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return json(INVALID_REQUEST, 400);
    }

    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(INVALID_REQUEST, 400);

    const receipt = (body as { receipt?: unknown }).receipt;
    if (!isValidStatusReceipt(receipt)) {
      // Never echoes the supplied value, its length, or which check failed.
      return json(INVALID_REQUEST, 400);
    }

    const hash = await hashStatusReceipt(receipt);
    const row = await lookup(hash);

    if (row === 'error') {
      // Fail closed. A lookup that did not succeed can never be reported as a
      // terminal outcome, because the caller would delete its data on it.
      return json({ error: 'unavailable' }, 503);
    }
    if (!row) return json(NOT_FOUND, 404);

    return json(evaluateLifecycle(row));
  };
}

async function defaultLookup(hash: string): Promise<LifecycleRow | null | 'error'> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return 'error';

  // Single indexed equality probe against the partial unique index on
  // status_receipt_hash. The hash is the whole predicate: there is no
  // caller-supplied user id, so a caller cannot aim this at another subject.
  const endpoint =
    `${url.replace(/\/$/, '')}/rest/v1/deletion_requests` +
    `?status_receipt_hash=eq.${encodeURIComponent(hash)}` +
    `&select=status,purged_at,restored_at&limit=1`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return 'error';
  }

  if (!response.ok) return 'error';

  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    return 'error';
  }

  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] as LifecycleRow;
}

Deno.serve(createHandler());

// Referenced so the shared constant is part of this module's contract surface
// and a format change cannot silently desynchronise the two.
export { STATUS_RECEIPT_LENGTH };
