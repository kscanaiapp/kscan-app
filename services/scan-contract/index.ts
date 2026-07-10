// Shared scan-analysis contract for K Scan clients.
//
// This module is a logical boundary, not a separate npm package. It is
// intended for tests, fixtures, and future wearable/mobile clients. Existing
// mobile screens and API clients do not import it yet.

export { SCAN_CONTRACT_VERSION } from './version';

export type {
  ScanSource,
  PrivacySanitizerMode,
  DeviceClass,
  ScanImageInput,
  ScanPrivacyContext,
  ScanDeviceContext,
  ScanRequest,
} from './request';
export { createScanRequestId, buildScanRequest } from './request';

export type {
  FashionAttributes,
} from './fashionAttributes';
export {
  FASHION_VOCABULARY_NORMALIZATION,
  normalizeFashionTerm,
  normalizeStyleTags,
  formatAttributeLabel,
} from './fashionAttributes';

export type { ProductMatch } from './productMatch';
export { formatProductPrice } from './productMatch';

export type { ScanErrorCode, ScanError } from './errors';
export { createScanError, defaultErrorMessage } from './errors';

export type { ScanStatus, ScanProcessingMeta, ScanResponse } from './response';
export { buildScanResponse } from './response';

export { normalizeLegacyAttributes, sanitizeUserMessage } from './normalize';

export type { ValidationResult } from './validators';
export {
  validateScanRequest,
  validateScanResponse,
  isScanSource,
  isScanStatus,
} from './validators';

export {
  toSharedScanRequest,
  normalizeLegacyAnalyzeResponse,
  toLegacyCompatibleResult,
} from './adapters';

export { formatWearableScanSummary } from './wearableFormatter';

export {
  FIXTURE_REQUEST_ID,
  createFixtureRequest,
  fixtureBlackLeatherJacket,
  fixtureWhiteRunningSneaker,
  fixtureFloralMidiDress,
  fixtureBlueOversizedDenimJacket,
  fixtureNonFashionObject,
  fixturePartialResponse,
  fixtureProviderTimeout,
  fixtureEmptyProductList,
  fixtureLegacyResponse,
  fixtureWearableMockRequest,
  allFixtureResponses,
} from './fixtures';
