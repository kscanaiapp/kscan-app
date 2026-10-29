import { createDiscoveryHandler } from './handler.ts';
import { evaluateSponsorshipPolicy, SPONSORED_DISCLOSURE, type SponsorshipSnapshot, type SponsoredPreview } from './sponsorshipPolicy.ts';
import type { DiscoveryInput } from './contracts.ts';
export type SandboxResponse = { version: 'sponsorship-sandbox-v1'; sandbox: true; status: 'ready' | 'empty' | 'unavailable'; products: SponsoredPreview[]; disclosureTemplate: typeof SPONSORED_DISCLOSURE; generatedAt: string };
export function sandboxPermitted(env: (key: string) => string | undefined): boolean {
  if (env('SPONSORSHIP_SANDBOX_MODE') !== 'true' || env('SPONSORED_PLACEMENTS_V1_ENABLED') !== 'true') return false;
  const environment = env('KSCAN_ENVIRONMENT');
  try {
    const url = new URL(env('SUPABASE_URL') ?? '');
    if (environment === 'staging') return url.protocol === 'https:' && url.hostname === 'yzqjvdfgefveprobvvyw.supabase.co';
    return ['test','development'].includes(environment ?? '') && ['127.0.0.1','localhost'].includes(url.hostname);
  } catch { return false; }
}
export function createSponsorshipSandboxHandler(deps: {
  env: (key: string) => string | undefined;
  authenticate: (request: Request) => Promise<{ id: string; isAnonymous: boolean }>;
  staff: (id: string) => Promise<boolean>;
  claim: (id: string, signal: AbortSignal) => Promise<boolean>;
  snapshot: (input: DiscoveryInput, signal: AbortSignal) => Promise<SponsorshipSnapshot>;
}) {
  const inner = createDiscoveryHandler<SandboxResponse>({
    flags: () => ({ discovery:sandboxPermitted(deps.env), badges:false, sponsored:false }),
    authenticate: async (request) => {
      const user = await deps.authenticate(request);
      if (user.isAnonymous || !await deps.staff(user.id)) throw new Response(null,{status:401});
      return user;
    },
    claim: deps.claim,
    discover: async (input,_flags,signal) => {
      // Re-evaluate server configuration before access; request data never sets it.
      if (!sandboxPermitted(deps.env)) throw new Error('sandbox_unavailable');
      const snapshot = await deps.snapshot(input,signal);
      const result = evaluateSponsorshipPolicy(input,snapshot.rows,snapshot.partners,snapshot.campaigns,Date.now());
      return { version:'sponsorship-sandbox-v1', sandbox:true, status:result.placements.length?'ready':'empty', products:result.placements, disclosureTemplate:SPONSORED_DISCLOSURE, generatedAt:new Date().toISOString() };
    },
  });
  return async (request: Request): Promise<Response> => {
    const response = await inner(request);
    if (request.method==='OPTIONS') return response;
    const data = await response.json();
    return new Response(JSON.stringify({ ...data, version:'sponsorship-sandbox-v1', sandbox:true, disclosureTemplate:SPONSORED_DISCLOSURE }),{status:response.status,headers:response.headers});
  };
}
