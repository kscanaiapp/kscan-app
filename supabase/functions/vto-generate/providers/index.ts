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
 */

import type { VtoProvider } from '../vtoContract.ts';
import {
  createMockVtoProvider,
  isMockVtoScenario,
  MOCK_VTO_DEFAULT_LATENCY_MS,
  MOCK_VTO_PROVIDER_ID,
  type MockVtoScenario,
} from './mockProvider.ts';

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
 * There is exactly one provider today and it is the development mock. An
 * unknown provider id is 'provider_unavailable', never a silent fallback to
 * the mock -- a misconfigured production provider must fail visibly rather
 * than quietly serve placeholder art as if it were a generation.
 */
export function resolveVtoProvider(selection: ProviderSelection): ResolveProviderOutcome {
  if (selection.providerId === MOCK_VTO_PROVIDER_ID) {
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
  return { ok: false, reason: 'provider_unavailable' };
}

export { MOCK_VTO_PROVIDER_ID, isMockVtoScenario };
export type { MockVtoScenario };
