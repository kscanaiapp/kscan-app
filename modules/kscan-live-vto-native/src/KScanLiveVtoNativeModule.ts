import { NativeModule, requireNativeModule } from 'expo-modules-core';

/**
 * N1-A surface only: registration + self-check. Commands/events land gate by
 * gate (N1-B..N1-G) to match what the native side actually implements --
 * see modules/kscan-live-vto-native/android's KScanLiveVtoNativeModule.kt.
 *
 * The application's own optional-lookup adapter
 * (services/vto/liveVtoNativeModule.ts) is the safe, "module may not exist"
 * consumption path every real call site uses. This direct/throwing binding is
 * for callers (tests, native-evidence tooling) that already know the module
 * must be present.
 */
export interface KScanLiveVtoSelfCheck {
  capable: boolean;
  runtimeReady: boolean;
  runtimeVersion: string | null;
}

declare class KScanLiveVtoNativeModuleClass extends NativeModule<Record<string, never>> {
  getCapability(): KScanLiveVtoSelfCheck;
}

const KScanLiveVtoNativeModule =
  requireNativeModule<KScanLiveVtoNativeModuleClass>('KScanLiveVto');

export default KScanLiveVtoNativeModule;
