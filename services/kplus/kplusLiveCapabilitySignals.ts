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
import type { KPlusLiveSignals } from './kplusActivationCatalog';

type VtoConfigReader = () => Promise<{ enabled?: unknown } | null | undefined>;

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
