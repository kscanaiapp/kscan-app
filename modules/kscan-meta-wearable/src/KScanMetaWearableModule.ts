import { requireOptionalNativeModule } from 'expo-modules-core';
import type { KScanMetaWearableNative } from './KScanMetaWearable.types';

/**
 * The native adapter, or `null` when it was not built into this binary.
 *
 * `requireOptionalNativeModule` (not `requireNativeModule`) is deliberate. The
 * Meta DAT dependency is opt-in at build time — see the module's
 * `android/build.gradle` — and it is absent on iOS entirely. Throwing on
 * import would take down the whole JS bundle on every build that does not
 * carry the SDK, which is currently every build. Returning `null` lets the
 * capability layer answer "no glasses here" and fall back cleanly.
 */
const KScanMetaWearableModule = requireOptionalNativeModule<KScanMetaWearableNative>('KScanMetaWearable');

export default KScanMetaWearableModule;
