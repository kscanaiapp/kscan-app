// Reusable K+ capability gate. Every future K+ feature entry point should
// render through this component rather than building a feature-specific
// paywall/gate.
//
// WHICH SURFACE IT OPENS is decided per source by
// services/kplus/kplusAcquisitionSurface.ts, not here and not by the caller:
//   'membership'    KPlusMembershipSheet -- the paid K+ membership paywall, the
//                   same orchestrator Welcome Step 6 renders;
//   'early_access'  KPlusEarlyAccessSheet -- the shared K+ status and legacy
//                   complimentary-acquisition surface.
// Exactly one of the two is ever mounted for a given gate.
import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useKPlusEntitlement } from '../../hooks/useKPlusEntitlement';
import { KPlusEarlyAccessSheet } from './KPlusEarlyAccessSheet';
import { KPlusMembershipSheet } from './KPlusMembershipSheet';
import { resolveKPlusAcquisitionSurface } from '../../services/kplus/kplusAcquisitionSurface';
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
  /** Opens this gate's K+ surface: the membership paywall or the shared
   *  status / legacy complimentary-acquisition sheet, by source. */
  openUpgrade: () => void;
  /** Presentation state only, so native feature modals can yield to this sheet. */
  acquisitionVisible: boolean;
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
  const [sheetPresented, setSheetPresented] = useState(false);
  const surface = resolveKPlusAcquisitionSurface(source);

  // Fires once per mount (i.e. once per real presentation of this gate),
  // never on a state/entitlement re-render -- section 17.
  useEffect(() => {
    emitKPlusEvent('kplus_feature_exposed', { source, feature: source });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const openUpgrade = () => {
    emitKPlusEvent('kplus_feature_gate_opened', { source, feature: source, entitlement_state: state });
    setSheetVisible(true);
    setSheetPresented(true);
  };
  const closeSheet = () => {
    setSheetVisible(false);
    if (Platform.OS !== 'ios') setSheetPresented(false);
  };

  return (
    <>
      {children({ state, isActive, resolving: isKPlusEntitlementUnresolved(state), openUpgrade,
        acquisitionVisible: surface === 'membership' ? sheetVisible || sheetPresented : sheetVisible })}
      {surface === 'membership' ? (
        <KPlusMembershipSheet visible={sheetVisible} onClose={closeSheet} onDismiss={() => setSheetPresented(false)} />
      ) : (
        <KPlusEarlyAccessSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} source={source} />
      )}
    </>
  );
}
