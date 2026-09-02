/**
 * Provider registry.
 *
 * The client never chooses a provider. Selection comes from server-side
 * remote config (app_config.vto_generation.provider), so adding a real
 * vendor is a new adapter file plus a config value -- no app release, no
 * change anywhere in K Scan outside this directory.
 *
 * A real adapter added here must:
 *   1. read its credential from Deno.env inside the adapter, never from a
 *      request body and never from a shared module a client can influence;
 *   2. map every provider status/error string into a VtoFailureCode before
 *      returning -- provider text stops at this boundary;
 *   3. return media as a data URI so the orchestrator's validation seam and
 *      the ephemeral-media posture apply uniformly.
 *
 * `ailabtools_tryon_clothes_pro` is registered here and IS REACHABLE AND
 * BILLING. Corrected 2026-09-02 (VTO deep audit): this comment previously said
 * the account "has never been subscribed" and that selecting it "will fail
 * every request with provider_unavailable". Both were true for part of
 * 2026-08-30 and stale by the end of it -- a live submit/poll/result round trip
 * succeeded against this listing with real billed usage
 * (docs/vto-provider-benchmark.md §3). Staging's app_config already names this
 * provider with `enabled: true`, so the next real client call spends money.
 */

import type { VtoProvider } from '../vtoContract.ts';
import {
  createMockVtoProvider,
  isMockVtoScenario,
  MOCK_VTO_DEFAULT_LATENCY_MS,
  MOCK_VTO_PROVIDER_ID,
  type MockVtoScenario,
} from './mockProvider.ts';
import { AILABTOOLS_PROVIDER_ID, createAiLabToolsProvider } from './aiLabToolsProvider.ts';

export interface ProviderSelection {
  providerId: string;
  /** Mock-only. Ignored entirely by any real adapter. */
  scenario?: MockVtoScenario;
  latencyMs?: number;
}

export type ResolveProviderOutcome =
  | { ok: true; provider: VtoProvider }
  | { ok: false; reason: 'provider_unavailable' };

/**
 * The mock and one real (currently credential-blocked) adapter. An unknown
 * provider id -- or a real adapter missing its credential -- is
 * 'provider_unavailable', never a silent fallback to the mock: a
 * misconfigured production provider must fail visibly rather than quietly
 * serve placeholder art as if it were a real generation.
 */
export function resolveVtoProvider(selection: ProviderSelection): ResolveProviderOutcome {
  if (selection.providerId === MOCK_VTO_PROVIDER_ID) {
    // VTO-MOCK-001. The mock needs a DEPLOYMENT PERMISSION, exactly as the real
    // adapter needs a credential.
    //
    // The pre-existing guard was "an operator must name the mock explicitly" --
    // and 20260830160000_vto_feature_control.sql SEEDS `"provider": "mock"` into
    // app_config in every environment it is applied to. So in any environment
    // that had never been retuned, enabling VTO was a ONE-FIELD flip
    // (`enabled: true`) away from serving the placeholder vignette to a real
    // person, labelled "AI VISUALIZATION", against their own K+ quota. "Named
    // explicitly" was satisfied by a default nobody chose.
    //
    // Fails closed: absent or non-'true' means the mock is simply not a
    // provider this deployment has, which resolveVtoProvider already reports as
    // `provider_unavailable` -- a visible 503, never a silent substitution.
    if (Deno.env.get('VTO_ALLOW_MOCK_PROVIDER') !== 'true') {
      return { ok: false, reason: 'provider_unavailable' };
    }
    return {
      ok: true,
      provider: createMockVtoProvider({
        scenario: isMockVtoScenario(selection.scenario) ? selection.scenario : 'success',
        latencyMs: typeof selection.latencyMs === 'number'
          ? selection.latencyMs
          : MOCK_VTO_DEFAULT_LATENCY_MS,
      }),
    };
  }

  if (selection.providerId === AILABTOOLS_PROVIDER_ID) {
    const apiKey = Deno.env.get('RAPIDAPI_KEY');
    if (!apiKey) return { ok: false, reason: 'provider_unavailable' };
    return { ok: true, provider: createAiLabToolsProvider({ apiKey }) };
  }

  return { ok: false, reason: 'provider_unavailable' };
}

export { MOCK_VTO_PROVIDER_ID, isMockVtoScenario, AILABTOOLS_PROVIDER_ID };
export type { MockVtoScenario };
