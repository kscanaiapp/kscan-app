// Reusable K+ capability gate. Every future K+ feature entry point should
// render through this component rather than building a feature-specific
// paywall/gate -- see KPlusEarlyAccessSheet for the one shared upgrade
// surface it opens.
import React, { useState } from 'react';
import { useKPlusEntitlement } from '../../hooks/useKPlusEntitlement';
import { KPlusEarlyAccessSheet } from './KPlusEarlyAccessSheet';
import { emitKPlusEvent } from '../../services/kplus/kplusTelemetry';
import type { KPlusResolvedState } from '../../types/entitlements';

export interface KPlusGateRenderArgs {
  state: KPlusResolvedState;
  isActive: boolean;
  /** Opens the shared K+ Early Access sheet. */
  openUpgrade: () => void;
}

export interface KPlusGateProps {
  /** Render prop: caller decides UI per state (ACTIVE/ELIGIBLE/EXPIRED/
   *  UNAVAILABLE/LOADING/ERROR all map onto KPlusResolvedState). */
  children: (args: KPlusGateRenderArgs) => React.ReactNode;
  /** Telemetry-only label identifying which feature opened this gate. */
  source: string;
}

export function KPlusGate({ children, source }: KPlusGateProps) {
  const { state, isActive } = useKPlusEntitlement();
  const [sheetVisible, setSheetVisible] = useState(false);

  const openUpgrade = () => {
    emitKPlusEvent('kplus_feature_gate_open', { source });
    setSheetVisible(true);
  };

  return (
    <>
      {children({ state, isActive, openUpgrade })}
      <KPlusEarlyAccessSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} source={source} />
    </>
  );
}
