// Reusable K+ capability gate. Every future K+ feature entry point should
// render through this component rather than building a feature-specific
// paywall/gate -- see KPlusEarlyAccessSheet for the one shared upgrade
// surface it opens.
import React, { useEffect, useState } from 'react';
import { useKPlusEntitlement } from '../../hooks/useKPlusEntitlement';
import { KPlusEarlyAccessSheet } from './KPlusEarlyAccessSheet';
import { emitKPlusEvent } from '../../services/kplus/kplusTelemetry';
import {
  isKPlusEntitlementUnresolved,
  type KPlusResolvedState,
} from '../../types/entitlements';
import type { KPlusSource } from '../../types/kplusSource';

export interface KPlusGateRenderArgs {
  state: KPlusResolvedState;
  isActive: boolean;
  /**
   * RESOLVING != FREE. True while the entitlement answer is still UNKNOWN --
   * 'loading' (first read outstanding) or 'error' (the authority could not be
   * read at all). Neither means the actor is on the free tier.
   *
   * Callers must not render the free-tier lock, the "upgrade to K+" copy, or
   * route a tap to openUpgrade() while this is true: doing so tells a
   * complimentary or paying K+ customer they do not have K+ because their
   * network blipped. `isActive` alone cannot express this -- it is false for
   * both unknown states and for a genuine free actor.
   *
   * Computed here, once, so no gate consumer re-derives it. See
   * isKPlusEntitlementUnresolved in types/entitlements.ts and
   * __tests__/kplusResolvingNeverFree.test.js.
   */
  resolving: boolean;
  /** Opens the shared K+ Early Access sheet. */
  openUpgrade: () => void;
}

export interface KPlusGateProps {
  /** Render prop: caller decides UI per state (ACTIVE/ELIGIBLE/EXPIRED/
   *  UNAVAILABLE/LOADING/ERROR all map onto KPlusResolvedState). */
  children: (args: KPlusGateRenderArgs) => React.ReactNode;
  /** Bounded source identifying which surface opened this gate (section 9). */
  source: KPlusSource;
}

export function KPlusGate({ children, source }: KPlusGateProps) {
  const { state, isActive } = useKPlusEntitlement();
  const [sheetVisible, setSheetVisible] = useState(false);

  // Fires once per mount (i.e. once per real presentation of this gate),
  // never on a state/entitlement re-render -- section 17.
  useEffect(() => {
    emitKPlusEvent('kplus_feature_exposed', { source, feature: source });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const openUpgrade = () => {
    emitKPlusEvent('kplus_feature_gate_opened', { source, feature: source, entitlement_state: state });
    setSheetVisible(true);
  };

  return (
    <>
      {children({ state, isActive, resolving: isKPlusEntitlementUnresolved(state), openUpgrade })}
      <KPlusEarlyAccessSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} source={source} />
    </>
  );
}
