/**
 * The live server signals behind the K+ activation catalog's 'live' capabilities.
 *
 * Only Virtual Try-On has one: its server side is switched by a remote feature
 * row the client can already read, and every try-on entry point already obeys it
 * (services/vto/vtoFeatureControl.ts). The activation offer and the early-access
 * sheet must obey the same switch, or they would promise a try-on the rest of the
 * app is hiding while that switch is off.
 *
 * FAILS CLOSED, AND NEVER THROWS. The answer is `true` only when the row was read
 * and says enabled. A read that fails, times out, returns nothing or returns
 * something malformed is `false`, so the capability is simply not advertised until
 * a later read succeeds.
 *
 * This file names no switch and reads no credential; it asks the existing
 * reader one question.
 */

import { getVtoRemoteConfig } from '../vto/vtoFeatureControl';
import type { KPlusCapabilityPromotion, KPlusLiveSignals } from './kplusActivationCatalog';

type VtoConfigReader = () => Promise<
  { enabled?: unknown; awarenessEnabled?: unknown } | null | undefined
>;

export async function readKPlusLiveCapabilitySignals(deps?: {
  /** Injected in tests. */
  readVtoConfig?: VtoConfigReader;
}): Promise<KPlusLiveSignals> {
  const read: VtoConfigReader = deps?.readVtoConfig ?? getVtoRemoteConfig;
  try {
    const config = await read();
    return { virtual_try_on: config?.enabled === true };
  } catch {
    return { virtual_try_on: false };
  }
}

export interface KPlusLiveCapabilityState {
  /** SERVED: the capability works for a member right now. */
  signals: KPlusLiveSignals;
  /** PROMOTED: its benefit line may be shown. Never affects `signals`. */
  promotion: KPlusCapabilityPromotion;
}

/**
 * One read, two answers that must not be collapsed.
 *
 * `signals` is the same served answer `readKPlusLiveCapabilitySignals` gives,
 * and it is what decides whether there is a K+ membership to offer. `promotion`
 * is the row's promotion dimmer, and it decides only whether a benefit LINE is
 * shown. Dimming Try It On promotion therefore hides its line and changes
 * nothing about whether the membership step exists.
 *
 * Only an explicit `false` dims: a reader that does not report the field at all
 * promotes exactly as before. A failed read is served=false, promoted=unknown.
 */
export async function readKPlusLiveCapabilityState(deps?: {
  /** Injected in tests. */
  readVtoConfig?: VtoConfigReader;
}): Promise<KPlusLiveCapabilityState> {
  const read: VtoConfigReader = deps?.readVtoConfig ?? getVtoRemoteConfig;
  try {
    const config = await read();
    const served = config?.enabled === true;
    return {
      signals: { virtual_try_on: served },
      promotion: { virtual_try_on: served ? config?.awarenessEnabled !== false : null },
    };
  } catch {
    return { signals: { virtual_try_on: false }, promotion: {} };
  }
}
