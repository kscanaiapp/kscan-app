/**
 * The CUSTOMER-facing mount point for the Live VTO native runtime.
 *
 * WHY THIS FILE EXISTS. Until now the native view existed only on
 * `app/dev-n1-diagnostic.tsx`, and `VtoLivePanel`'s own header said so
 * plainly: "NO CAMERA VIEW IS MOUNTED HERE ... Until the native view exists,
 * the panel shows the session's state honestly rather than faking a
 * viewfinder." That was the correct posture while the runtime was being
 * built; it is not a shippable product surface, and mission section 35
 * forbids completion resting on the diagnostic screen for start, tracking
 * feedback, garment switching, capture, Photoreal, retry, fallback or exit.
 * This component is what moves the camera onto the customer's screen.
 *
 * SAFE ABSENCE, SAME AS THE MODULE ADAPTER. `requireNativeViewManager`
 * THROWS for a module that is not in the binary, and every build before this
 * lane's is such a build. The lookup is therefore lazy (nothing native is
 * touched at import time, so a resolution problem cannot participate in app
 * startup) and wrapped, and a failure renders NOTHING rather than crashing
 * the sheet -- the same "a Live problem may cost the customer Live; it may
 * never cost them the sheet" rule `hooks/useVtoLiveSession.ts` states.
 *
 * IT SETS `live`, NOT `camera`. `camera`/`perception`/`replay`/`active` are
 * the runtime's DIAGNOSTIC props. `live` is the product entry point, declared
 * separately on both platforms so the pinned native bridge surface records
 * that a customer-reachable path exists. Same pipeline, honest labelling.
 *
 * NOTHING PIXEL-SHAPED CROSSES THIS BOUNDARY. The view has no props but the
 * boolean, and no callbacks: every fact the app learns about the session
 * arrives through the module-level `liveVtoEvent` contract, which
 * `services/vto/liveVtoNativeModule.ts` already screens for forbidden raw
 * live data. A component that received frames would defeat that in one line.
 */

import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { LIVE_VTO_NATIVE_MODULE_NAME } from '../../constants/featureFlags';
import { RADIUS } from '../../constants/theme';

type NativeLiveViewComponent = React.ComponentType<{
  live?: boolean;
  style?: StyleProp<ViewStyle>;
}>;

/** `undefined` = not looked up yet; `null` = looked up, and there is none. */
let cachedNativeView: NativeLiveViewComponent | null | undefined;

/** Exported for tests, which need each case to start from a clean lookup. */
export function resetVtoLiveNativeViewCache(): void {
  cachedNativeView = undefined;
}

function resolveNativeView(): NativeLiveViewComponent | null {
  if (cachedNativeView !== undefined) return cachedNativeView;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core') as {
      requireNativeViewManager?: (name: string) => NativeLiveViewComponent;
    };
    cachedNativeView =
      typeof core?.requireNativeViewManager === 'function'
        ? core.requireNativeViewManager(LIVE_VTO_NATIVE_MODULE_NAME) ?? null
        : null;
  } catch {
    // Indistinguishable from absence for our purposes, and both mean the
    // same thing: no viewfinder. The session's own bounded error state is
    // what tells the customer, not a crash here.
    cachedNativeView = null;
  }
  return cachedNativeView;
}

export interface VtoLiveNativeViewProps {
  /** Drives the native runtime's product entry point. False (or unmounting)
   *  releases the camera -- nothing invisible may hold it. */
  live: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function VtoLiveNativeView({ live, style, testID }: VtoLiveNativeViewProps) {
  const NativeView = useMemo(() => resolveNativeView(), []);
  if (!NativeView) return null;
  return (
    <View style={[styles.frame, style]} testID={testID ?? 'vto-live-native-view'}>
      <NativeView live={live} style={StyleSheet.absoluteFill} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
  },
});
