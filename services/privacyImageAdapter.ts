/**
 * Default (non-platform) privacy image adapter resolution target.
 *
 * Metro resolves `./privacyImageAdapter` to the `.android.ts` / `.ios.ts`
 * platform files on device builds. This default file exists for Node-based
 * tooling and tests, and must stay behaviorally identical to the platform
 * passthrough implementations.
 */
export { preparePrivacyAdaptedImage } from './privacyImageAdapter.android';
export type { PrivacyAdaptedImage, PrivacyAdapterMode } from './privacyImageAdapter.types';
