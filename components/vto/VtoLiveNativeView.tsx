/**
 * The mount point for the Live VTO native view.
 *
 * WHY THIS EXISTS. The native module registers a view (`LiveVtoTestRenderView`
 * on Android, `LiveVtoRenderView` on iOS) and EVERY session command --
 * start, pause, resume, stop, loadGarment, switchGarment, capture -- resolves
 * "the one mounted Live view" natively and throws NO_ACTIVE_SESSION when there
 * is none. Nothing in the application mounted it, so on a build that included
 * the module a customer could reach Live and `start()` could only fail.
 *
 * WHAT THIS DOES AND DOES NOT DO.
 *   - It mounts the existing native view. It adds no camera, no renderer and no
 *     second session authority; commands still go through the session
 *     controller (services/vto/vtoLiveSession.ts) exactly as before.
 *   - Mounting is inert: the view starts no camera until `start()`. It exists
 *     only so there is something for the commands to address, and so the view
 *     is torn down (and its camera released) with the panel that owns it.
 *   - It passes NO props that carry data: no frame, landmark, mask or pose value
 *     can enter or leave through here, and it exposes no per-frame callback.
 *   - Absent safely. If the module or its view manager is missing the lookup
 *     returns null and nothing renders (the dev harness, a build without the
 *     module, web). The router already refuses Live in those cases; this is the
 *     backstop that keeps an import problem from becoming a render crash.
 *
 * ONE VIEW AT A TIME. The native side keys on a single current instance, so the
 * Live panel must be the only place this is mounted. See
 * __tests__/vtoLiveNativeViewMount.test.js.
 */

import React, { useMemo } from 'react';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';

import { LIVE_VTO_NATIVE_MODULE_NAME } from '../../constants/featureFlags';

type NativeLiveView = React.ComponentType<{
  style?: StyleProp<ViewStyle>;
  collapsable?: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
}>;

/** `undefined` = not looked up yet, `null` = looked up, nothing to mount. */
let cachedView: NativeLiveView | null | undefined;

export function resetLiveVtoNativeViewCache(): void {
  cachedView = undefined;
}

/**
 * Lazily resolves the native view component. The `require` is inside the
 * function so this file can be imported with no native environment, and a
 * failure is indistinguishable from absence: both mean "nothing to mount".
 */
export function resolveLiveVtoNativeView(
  deps?: { requireNativeViewManager?: (name: string) => NativeLiveView },
): NativeLiveView | null {
  if (deps === undefined && cachedView !== undefined) return cachedView;
  let resolved: NativeLiveView | null = null;
  try {
    const lookup = deps?.requireNativeViewManager
      ?? (require('expo-modules-core') as { requireNativeViewManager?: (name: string) => NativeLiveView })
        .requireNativeViewManager;
    resolved = typeof lookup === 'function' ? lookup(LIVE_VTO_NATIVE_MODULE_NAME) ?? null : null;
  } catch {
    resolved = null;
  }
  if (deps === undefined) cachedView = resolved;
  return resolved;
}

export interface VtoLiveNativeViewProps {
  style?: StyleProp<ViewStyle>;
  /** Fired once the native view has a layout, i.e. is attached and addressable. */
  onMounted?: () => void;
  testID?: string;
}

export function VtoLiveNativeView({ style, onMounted, testID }: VtoLiveNativeViewProps) {
  const NativeView = useMemo(() => resolveLiveVtoNativeView(), []);
  if (!NativeView) return null;
  return (
    <NativeView
      style={style}
      // The native view is the camera/render surface: never let the layout
      // optimizer flatten it away.
      collapsable={false}
      onLayout={() => onMounted?.()}
      testID={testID ?? 'vto-live-native-view'}
    />
  );
}
