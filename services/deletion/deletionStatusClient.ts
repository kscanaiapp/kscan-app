/**
 * deletion-status client — the post-auth lifecycle lookup.
 *
 * NOT A SECOND NETWORKING STACK. Transport is `supabase.functions.invoke`, the
 * same path every other Edge Function in this app uses, for the same reason
 * services/privateDressingRoomEliseClient.ts gives: one place decides base URL,
 * headers and error shape.
 *
 * WHY IT WORKS WITHOUT A SESSION. The backend function declares
 * `verify_jwt = false` because by the time a terminal answer exists there is no
 * Auth user left to authenticate as. `functions.invoke` attaches an
 * Authorization header only when a session exists and otherwise falls back to
 * the anon key, and this endpoint reads neither — it resolves exactly one
 * lifecycle from the SHA-256 of the capability in the body and consults no
 * caller identity at all. So the same call is correct signed out, signed in as
 * the departed actor, or signed in as a completely different actor.
 *
 * THE CAPABILITY RIDES IN THE BODY, NEVER THE URL. `functions.invoke` builds
 * the URL from the function name alone; this module passes no query string and
 * appends nothing. That is asserted by test, because a query string reaches
 * access logs, proxy telemetry and caches.
 *
 * EVERY UNCERTAIN OUTCOME IS NON-TERMINAL. This module never invents a
 * lifecycle state. A malformed body, an unexpected status, a transport failure
 * and a missing function all resolve to outcomes that authorise nothing.
 */

import { supabase } from '../supabaseClient';
import { isValidStatusReceipt } from './statusReceipt';

export const DELETION_STATUS_FUNCTION = 'deletion-status';

/** The public vocabulary, mirroring PublicDeletionState in the backend source. */
export const PUBLIC_DELETION_STATES = Object.freeze([
  'pending',
  'restored',
  'failed',
  'purged',
] as const);

export type PublicDeletionState = (typeof PUBLIC_DELETION_STATES)[number];

export type DeletionStatusOutcome =
  /** A lifecycle was resolved. `purgeAuthorized` is the backend's own boolean. */
  | {
      kind: 'lifecycle';
      state: PublicDeletionState;
      purgeAuthorized: boolean;
      purgedAt: string | null;
      restoredAt: string | null;
    }
  /** Well-formed capability, no matching lifecycle. Retryable; authorises nothing. */
  | { kind: 'not_found' }
  /** The backend rejected the request shape. Never retried as-is. */
  | { kind: 'invalid_request' }
  /** Backend could not answer (503). Explicitly NOT a terminal answer. */
  | { kind: 'unavailable' }
  /** The endpoint is not deployed on this project — a backend without Repair 06. */
  | { kind: 'endpoint_unavailable' }
  /** Transport failed. Indistinguishable from "no answer", and treated as one. */
  | { kind: 'network_error' }
  /** A 2xx whose body this contract cannot interpret. Fails closed. */
  | { kind: 'malformed' };

type InvokeResult = { data: unknown; error: unknown };
type Invoker = (name: string, options: { body: unknown }) => Promise<InvokeResult>;

function defaultInvoker(name: string, options: { body: unknown }): Promise<InvokeResult> {
  return supabase.functions.invoke(name, options) as Promise<InvokeResult>;
}

/**
 * Reads the HTTP status and the generic error string out of a failed invoke.
 *
 * Mirrors services/scanIdentification.ts#readContractError: supabase-js reports
 * a non-2xx as a `FunctionsHttpError` carrying the raw `Response` on
 * `.context`. Only the status and the short enum string are read — never the
 * message, never the full body.
 */
async function readErrorContext(
  error: unknown,
): Promise<{ status: number; code: string | null } | null> {
  try {
    const context = (error as { context?: unknown })?.context as
      | { status?: unknown; json?: () => Promise<unknown> }
      | undefined;
    if (!context || typeof context.status !== 'number') return null;
    let code: string | null = null;
    if (typeof context.json === 'function') {
      try {
        const body = await context.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const raw = (body as Record<string, unknown>).error;
          if (typeof raw === 'string' && raw.trim()) code = raw.trim();
        }
      } catch {
        code = null;
      }
    }
    return { status: context.status, code };
  } catch {
    return null;
  }
}

function readIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

/**
 * Strict normalization of a 2xx body.
 *
 * `purgeAuthorized` must be a literal boolean `true` to survive: a truthy
 * string, a 1, or a missing field all normalize to false. Nothing about this
 * response is inferred — an unrecognised `state` makes the whole body
 * malformed rather than silently becoming `pending`, because a state this
 * client does not understand is a contract change, not a lifecycle value.
 */
export function normalizeDeletionStatusResponse(data: unknown): DeletionStatusOutcome {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'malformed' };
  const body = data as Record<string, unknown>;

  const state = body.state;
  if (typeof state !== 'string') return { kind: 'malformed' };
  if (!(PUBLIC_DELETION_STATES as readonly string[]).includes(state)) {
    return { kind: 'malformed' };
  }

  if (typeof body.purgeAuthorized !== 'boolean') return { kind: 'malformed' };

  return {
    kind: 'lifecycle',
    state: state as PublicDeletionState,
    purgeAuthorized: body.purgeAuthorized === true,
    purgedAt: readIsoOrNull(body.purgedAt),
    restoredAt: readIsoOrNull(body.restoredAt),
  };
}

/**
 * Asks the backend about ONE lifecycle.
 *
 * The capability is validated locally first: a stored marker that no longer
 * matches the Repair 06 format is a corrupt record, and sending it would only
 * earn a 400. It never reaches the network.
 */
export async function fetchDeletionStatus(
  receipt: string,
  deps: { invoke?: Invoker } = {},
): Promise<DeletionStatusOutcome> {
  if (!isValidStatusReceipt(receipt)) return { kind: 'invalid_request' };

  const invoke = deps.invoke ?? defaultInvoker;

  let result: InvokeResult;
  try {
    // The capability appears in the BODY and nowhere else. No query string, no
    // path segment, no header, no user id, no email.
    result = await invoke(DELETION_STATUS_FUNCTION, { body: { receipt } });
  } catch {
    return { kind: 'network_error' };
  }

  if (result?.error) {
    const context = await readErrorContext(result.error);
    if (!context) return { kind: 'network_error' };
    if (context.status === 400) return { kind: 'invalid_request' };
    if (context.status === 404) {
      // The endpoint's own generic miss, versus the gateway's "no such
      // function" on a project without Repair 06. Only the former is a real
      // lookup answer, and neither authorises anything.
      return context.code === 'not_found' ? { kind: 'not_found' } : { kind: 'endpoint_unavailable' };
    }
    if (context.status === 405) return { kind: 'endpoint_unavailable' };
    if (context.status === 503) return { kind: 'unavailable' };
    return { kind: 'network_error' };
  }

  return normalizeDeletionStatusResponse(result?.data);
}
