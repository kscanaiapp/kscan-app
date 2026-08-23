export { default as KScanMetaWearableModule } from './src/KScanMetaWearableModule';
export type {
  KScanMetaWearableNative,
  MetaAdapterEvent,
  MetaAdapterStatus,
  MetaCameraConfig,
  MetaCameraState,
  MetaCapture,
  MetaDevice,
  MetaDeviceState,
  MetaDisplayPayload,
  MetaInitState,
  MetaLinkState,
  MetaPermissionStatus,
  MetaRegistrationState,
  MetaSessionState,
} from './src/KScanMetaWearable.types';

/** Bumped whenever the native<->JS contract changes shape. */
export const META_WEARABLE_ADAPTER_VERSION = 'kscan.meta.dat.adapter.v1';

/** The DAT release this adapter was written against. */
export const META_WEARABLE_DAT_VERSION = '0.9.0';
