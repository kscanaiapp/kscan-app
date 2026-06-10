/**
 * Bridge test fixtures (Phase 16 alpha).
 *
 * Safe, deterministic payload fixtures for validation tests and dev
 * tooling. No real photos, no user data.
 */

import { DEV_CAPTURE_FIXTURE_DATA_URL } from './devCaptureProvider.ts';

export const bridgeFixtures = {
  /** Valid JPEG data URL (tiny deterministic 1x1 pixel fixture). */
  validJpegDataUrl: DEV_CAPTURE_FIXTURE_DATA_URL,

  /** Empty string — must be rejected. */
  emptyString: '',

  /** Raw base64 without the data URL prefix — must be rejected. */
  rawBase64WithoutPrefix: '/9j/4AAQSkZJRgABAQEAYABgAAD=',

  /** Wrong MIME prefix (PNG) — must be rejected. */
  wrongMimePrefix: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=',

  /** Wrong MIME prefix (text) — must be rejected. */
  textPlainPrefix: 'data:text/plain;base64,aGVsbG8=',

  /** Prefix present but no payload after the comma — must be rejected. */
  prefixOnlyNoPayload: 'data:image/jpeg;base64,',

  /** Non-string payload — must be rejected. */
  nonStringPayload: 12345 as unknown,

  /**
   * Syntactically valid JPEG data URL whose bytes are NOT a real JPEG.
   * This passes bridge syntax validation by design and may fail later in
   * downstream image decode/sanitizer stages.
   */
  malformedJpegPrefixedPayload: 'data:image/jpeg;base64,bm90LWEtcmVhbC1qcGVn',
} as const;
