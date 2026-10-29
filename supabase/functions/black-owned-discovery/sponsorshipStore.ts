import { rest } from '../_shared/deletion/common.ts';
import type { DiscoveryInput } from './contracts.ts';
import type { SponsorshipSnapshot } from './sponsorshipPolicy.ts';
export async function sponsorshipSnapshot(input: DiscoveryInput, signal: AbortSignal, sandbox = false): Promise<SponsorshipSnapshot> {
  const response = await rest('rpc/discovery_sponsorship_snapshot',{method:'POST',signal,body:JSON.stringify({p_category:input.garment.item_type,p_subtype:input.garment.subtype??'',p_market:input.market,p_sandbox:sandbox})});
  if (!response.ok) throw new Error('sponsorship_store_unavailable');
  const data = await response.json();
  if (!Array.isArray(data?.rows)||data.rows.length>160||!Array.isArray(data?.campaigns)||data.campaigns.length>20||!Array.isArray(data?.partners)||data.partners.length>20) throw new Error('invalid_sponsorship_snapshot');
  return data;
}
