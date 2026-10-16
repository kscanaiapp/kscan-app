import KScanLiveVtoNativeModule from './KScanLiveVtoNativeModule';
import type { KScanLiveVtoSelfCheck } from './KScanLiveVtoNativeModule';

export type { KScanLiveVtoSelfCheck };
export { KScanLiveVtoNativeModule };

export function getKScanLiveVtoCapability(): KScanLiveVtoSelfCheck {
  return KScanLiveVtoNativeModule.getCapability();
}
