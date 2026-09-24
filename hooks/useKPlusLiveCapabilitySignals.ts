/**
 * React binding for the K+ catalog's live capability signals.
 *
 * `settled` is what keeps "still asking" from being mistaken for "nothing to
 * offer": until the read finishes the answer is unknown, the catalog fails closed
 * for the capabilities that depend on it, and the caller must not treat a
 * momentarily short list as final (the onboarding step would otherwise skip
 * itself before the answer arrived).
 *
 * The read is skipped, and `settled` is immediately true, when there is nothing
 * to ask: a build without the try-on UI has no capability that depends on the
 * signal, and a caller that is not showing anything (`active` false) does not
 * need one.
 */

import { useEffect, useState } from 'react';

import { VTO_UI_ENABLED } from '../constants/featureFlags';
import type { KPlusLiveSignals } from '../services/kplus/kplusActivationCatalog';
import { readKPlusLiveCapabilitySignals } from '../services/kplus/kplusLiveCapabilitySignals';

export interface KPlusLiveCapabilitySignalsResult {
  signals: KPlusLiveSignals;
  settled: boolean;
}

const NO_SIGNALS: KPlusLiveSignals = Object.freeze({});
const NOTHING_TO_ASK: KPlusLiveCapabilitySignalsResult = Object.freeze({
  signals: NO_SIGNALS,
  settled: true,
});

export function useKPlusLiveCapabilitySignals(active: boolean = true): KPlusLiveCapabilitySignalsResult {
  const needed = active && VTO_UI_ENABLED;
  const [result, setResult] = useState<KPlusLiveCapabilitySignalsResult>({
    signals: NO_SIGNALS,
    settled: false,
  });

  useEffect(() => {
    if (!needed) return undefined;
    let alive = true;
    void readKPlusLiveCapabilitySignals().then((signals) => {
      if (alive) setResult({ signals, settled: true });
    });
    return () => {
      alive = false;
    };
  }, [needed]);

  return needed ? result : NOTHING_TO_ASK;
}
