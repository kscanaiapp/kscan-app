/**
 * Authenticated client adapter for the server-authoritative offer-code flow.
 * Sends only the entered code; actor identity comes from the verified bearer
 * JWT. A SUCCESS never mutates local K+ state.
 */
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';
import { supabase } from '../supabaseClient';
import { refreshKPlusEntitlement } from './kplusEntitlementStore';
import {
  sanitizeOfferRedemptionResult,
  type KPlusOfferRedemptionPort,
} from './kplusOfferRedemption';

type OfferRedemptionResponse = {
  result?: unknown;
  entitlementRefreshRequired?: unknown;
};

/**
 * On an entitlement-bearing success, wait for the canonical K+ reader before
 * returning the server receipt to the UI. The receipt itself still grants
 * nothing; only the canonical snapshot can render active membership.
 */
export const redeemKPlusOfferCode: KPlusOfferRedemptionPort = async (code) => {
  const session = await resolveAuthenticatedFunctionSession();
  if (!session.ok) return 'UNAVAILABLE';

  try {
    const { data, error } = await supabase.functions.invoke('kplus-offer-redeem', {
      body: { code },
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (error) return 'ERROR';

    const payload = (data ?? {}) as OfferRedemptionResponse;
    const result = sanitizeOfferRedemptionResult(payload.result);
    if (result === 'SUCCESS' && payload.entitlementRefreshRequired === true) {
      await refreshKPlusEntitlement();
    }
    return result;
  } catch {
    return 'ERROR';
  }
};
