import { requireUser, rest } from '../_shared/deletion/common.ts';
import { createSponsorshipSandboxHandler } from '../black-owned-discovery/sponsorshipSandbox.ts';
import { sponsorshipSnapshot } from '../black-owned-discovery/sponsorshipStore.ts';
async function rpc(name:string,body:unknown,signal:AbortSignal) {
  const response=await rest(`rpc/${name}`,{method:'POST',body:JSON.stringify(body),signal});
  if(!response.ok)throw new Error('sandbox_authority_unavailable');return await response.json();
}
Deno.serve(createSponsorshipSandboxHandler({
  env:(key)=>Deno.env.get(key), authenticate:requireUser,
  staff:async(id)=>(await rpc('discovery_staff_authority',{p_actor:id},AbortSignal.timeout(800)))===true,
  claim:async(id,signal)=>(await rpc('discovery_claim_request',{p_actor:id},signal))===true,
  snapshot:(input,signal)=>sponsorshipSnapshot(input,signal,true),
}));
