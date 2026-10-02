/**
 * K+ canonical mobile entitlement reader (Build 35 Phase A).
 *
 * The ONE place the mobile app asks the server "does this actor have K+".
 * It calls get_my_kplus_entitlement_summary() -- identity comes from the
 * caller's JWT on the server, never from an argument -- and strictly parses
 * the answer against types/kplusEntitlementContract.ts.
 *
 * It replaces the Build 34 direct read of the caller's user_entitlements row.
 * That read could only see the legacy complimentary row, so a store
 * subscription or a lifetime purchase (which live in kplus_entitlement_grants)
 * would have been invisible to the device.
 *
 * Invariants:
 *   - This module never grants, extends or invents access. It only reports what
 *     the server said, or that it could not be told.
 *   - RESOLVING != FREE. Every failure is 'unavailable' or 'signed_out'; none is
 *     ever reported as a free answer. Only a server answer that parses and says
 *     access 'free' is a free answer.
 *   - A malformed or inconsistent answer is 'unavailable' (malformed_response),
 *     never a guess.
 *   - It performs no caching. Presentation caching is the store's job, under the
 *     freshness rules in types/kplusEntitlementContract.ts.
 */
import { supabase } from '../supabaseClient';
import {
  KPLUS_CLIENT_SUMMARY_RPC,
  parseKPlusEntitlementSummary,
  type KPlusEntitlementSummary,
} from '../../types/kplusEntitlementContract';

export type KPlusSummaryReadResult =
  | { status: 'resolved'; summary: KPlusEntitlementSummary }
  | { status: 'unavailable'; reason: 'network' | 'server_error' | 'malformed_response' }
  | { status: 'signed_out' };

/** The slice of the Supabase client this reader needs (a test seam). */
export interface KPlusSummaryReadClient {
  auth: {
    getSession(): Promise<{ data: { session: { user?: { id?: string | null } | null } | null } }>;
  };
  rpc(fn: string): PromiseLike<{
    data: unknown;
    error: { message?: string; code?: string; status?: number } | null;
  }>;
}

/**
 * A response that carries an error with a code or HTTP status came from the
 * server (it answered, and refused). One that carries neither is a transport
 * failure: offline, DNS, timeout.
 */
function classifyError(error: { message?: string; code?: string; status?: number }): 'network' | 'server_error' {
  if (typeof error.code === 'string' && error.code.length > 0) return 'server_error';
  if (typeof error.status === 'number' && error.status > 0) return 'server_error';
  return 'network';
}

export async function readKPlusEntitlementSummary(
  client: KPlusSummaryReadClient = supabase as unknown as KPlusSummaryReadClient,
): Promise<KPlusSummaryReadResult> {
  let userId: string | null | undefined;
  try {
    const {
      data: { session },
    } = await client.auth.getSession();
    userId = session?.user?.id;
  } catch {
    return { status: 'unavailable', reason: 'network' };
  }
  if (!userId) {
    return { status: 'signed_out' };
  }

  let response: Awaited<ReturnType<KPlusSummaryReadClient['rpc']>>;
  try {
    response = await client.rpc(KPLUS_CLIENT_SUMMARY_RPC);
  } catch {
    return { status: 'unavailable', reason: 'network' };
  }

  if (response.error) {
    return { status: 'unavailable', reason: classifyError(response.error) };
  }

  const summary = parseKPlusEntitlementSummary(response.data);
  if (!summary) {
    return { status: 'unavailable', reason: 'malformed_response' };
  }
  return { status: 'resolved', summary };
}
