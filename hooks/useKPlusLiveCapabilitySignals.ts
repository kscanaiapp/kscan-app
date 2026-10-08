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
import type {
  KPlusCapabilityPromotion,
  KPlusLiveSignals,
} from '../services/kplus/kplusActivationCatalog';
import { readKPlusLiveCapabilityState } from '../services/kplus/kplusLiveCapabilitySignals';
import { capabilityProofContext, isProofRecordCurrent } from '../services/kplus/kplusCapabilityProof';

export interface KPlusLiveCapabilitySignalsResult {
  /** SERVED: decides whether a capability is real for a member. */
  signals: KPlusLiveSignals;
  /**
   * PROMOTED: decides only whether a capability's benefit line is shown. Kept
   * apart from `signals` on purpose -- dimming promotion must never read as
   * "this capability is not served". See selectPromotedCapabilities.
   */
  promotion: KPlusCapabilityPromotion;
  settled: boolean;
}

const NO_SIGNALS: KPlusLiveSignals = Object.freeze({});
const NO_PROMOTION: KPlusCapabilityPromotion = Object.freeze({});
const NOTHING_TO_ASK: KPlusLiveCapabilitySignalsResult = Object.freeze({
  signals: NO_SIGNALS,
  promotion: NO_PROMOTION,
  settled: true,
});

export function useKPlusLiveCapabilitySignals(active: boolean = true): KPlusLiveCapabilitySignalsResult {
  const needed = active && VTO_UI_ENABLED;
  const [result, setResult] = useState<KPlusLiveCapabilitySignalsResult>({
    signals: NO_SIGNALS,
    promotion: NO_PROMOTION,
    settled: false,
  });

  useEffect(() => {
    if (!needed) return undefined;
    let alive = true;
    void readKPlusLiveCapabilityState().then(({ signals, promotion }) => {
      if (alive) setResult({ signals, promotion, settled: true });
    });
    return () => {
      alive = false;
    };
  }, [needed]);

  // An open membership screen must remove an expiring proof claim even when
  // no remote VTO read changes. Rotate only the existing presentation signal
  // identity; the catalog remains the sole capability-truth authority.
  useEffect(() => {
    if (!active) return undefined;
    const context = capabilityProofContext();
    const expirations = context.records.filter(record => isProofRecordCurrent(record, context))
      .map(record => Date.parse(record.expiresAt)).filter(at => at > Date.now());
    if (expirations.length === 0) return undefined;
    const timeout = setTimeout(() => {
      setResult(current => ({ ...current, signals: { ...current.signals } }));
    }, Math.min(Math.min(...expirations) - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [active, result.signals]);

  return needed ? result : { ...NOTHING_TO_ASK, signals: result.signals };
}
