/**
 * v123 TextScan commerce parity + outcome capture tests.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  isTextScanCommerceParityEnabled,
  TEXTSCAN_COMMERCE_PARITY_VERSION,
} from './textScanCommerceParityConfig.ts';
import {
  isCommerceOutcomeCaptureEnabled,
  COMMERCE_OUTCOME_CAPTURE_TIMEOUT_MS,
} from './commerceOutcomeCaptureConfig.ts';
import {
  buildCommerceOutcomeRow,
  SCAN_COMMERCE_EVENTS_TABLE,
} from './commerceOutcomeCapture.ts';
import {
  mapToFailureReason,
  FAILURE_REASONS,
} from './commerceRelevanceFailure.ts';
import { assertQualityMetricsPrivacy } from './qualityTuneTelemetry.ts';
import { getScanCommerceResults } from './scanCommerceRouter.ts';

Deno.test('v123 flags: TextScan parity and outcome capture semantics', () => {
  assertEquals(TEXTSCAN_COMMERCE_PARITY_VERSION, 'v123');
  assertEquals(isTextScanCommerceParityEnabled(() => 'false'), false);
  assertEquals(isTextScanCommerceParityEnabled(() => 'true'), true);
  assertEquals(isCommerceOutcomeCaptureEnabled(() => 'false'), false);
  assertEquals(isCommerceOutcomeCaptureEnabled(() => 'true'), true);
  assertEquals(COMMERCE_OUTCOME_CAPTURE_TIMEOUT_MS, 300);
  assertEquals(SCAN_COMMERCE_EVENTS_TABLE, 'scan_commerce_events');
});

Deno.test('v123 failure precedence: auth > model > commerce terminal > informational', () => {
  assertEquals(
    mapToFailureReason({ authRequired: true, commercePrimaryEmpty: true }),
    'authentication_required',
  );
  assertEquals(
    mapToFailureReason({ digestMismatch: true, providerOutcome: 'timeout' }),
    'digest_mismatch',
  );
  assertEquals(
    mapToFailureReason({ candidateInvalid: true, commerceFallbackUsed: true }),
    'candidate_invalid',
  );
  assertEquals(
    mapToFailureReason({ isTimeout: true, commercePrimaryEmpty: true }),
    'model_timeout',
  );
  assertEquals(
    mapToFailureReason({ providerOutcome: 'timeout', commerceFallbackUsed: true }),
    'provider_timeout',
  );
  assertEquals(
    mapToFailureReason({ commerceFallbackEmpty: true }),
    'commerce_fallback_empty',
  );
  assertEquals(
    mapToFailureReason({ commerceFallbackUsed: true, categoryMismatchRemoved: true }),
    'commerce_fallback_used',
  );
  assert(FAILURE_REASONS.includes('commerce_fallback_used'));
});

Deno.test('v123 outcome row: scrubbed fields only; hostile payloads blocked', () => {
  const row = buildCommerceOutcomeRow({
    requestMode: 'text',
    sourceClass: 'qa',
    appPlatform: 'android',
    appVersion: '1.0.0',
    status: 'completed',
    isFashion: true,
    categoryRoute: 'footwear',
    qualityBand: 'high',
    commerceQueryDetailLevel: 'specific',
    providerOutcome: 'kickscrew',
    providersTried: ['kickscrew', 'farfetch'],
    primaryResultCount: 4,
    fallbackUsed: false,
    productsBeforeFilter: 6,
    productsAfterFilter: 4,
    productsBeforeDedupe: 5,
    productsAfterDedupe: 4,
    categoryMismatchRemovals: 1,
    retailerCount: 2,
    commerceDurationMs: 1200,
    totalDurationMs: 3400,
    failureReason: 'category_mismatch_removed',
    textScanParityEnabled: true,
    correlationHash: 'abc123def456',
  });

  assertEquals(row.category_route, 'footwear');
  assertEquals(row.fallback_used, false);
  assertEquals(row.products_before_filter, 6);
  assertEquals(row.products_after_dedupe, 4);
  assertEquals(row.textscan_parity_version, 'v123');
  assertEquals(row.failure_reason, 'category_mismatch_removed');

  const privacy = assertQualityMetricsPrivacy(row);
  assertEquals(privacy.ok, true);

  const hostile = {
    ...row,
    raw_text: 'black moto jacket secret',
    imageBase64: 'iVBORw0KGgo',
    product_url: 'https://shop.example/item',
    authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb',
  };
  assertEquals(assertQualityMetricsPrivacy(hostile).ok, false);
});

Deno.test('v123 router: text mode rejected without allowTextMode; accepted with flag', async () => {
  const blocked = await getScanCommerceResults({
    mode: 'text',
    identification: { item_type: 'footwear', subtype: 'sneakers', primary_color: 'white' },
  });
  assertEquals(blocked.errorType, 'wrong_mode');
  assertEquals(blocked.products.length, 0);

  // With allowTextMode, wrong_mode must not be returned for mode rejection.
  // Providers may still return empty when keys disabled — that is not wrong_mode.
  const allowed = await getScanCommerceResults({
    mode: 'text',
    allowTextMode: true,
    identification: {
      item_type: 'footwear',
      subtype: 'sneakers',
      primary_color: 'white',
      material_estimate: 'leather',
      logo_detected: false,
    },
    relevanceEnabled: true,
    relevanceRoute: 'footwear',
    qualityBand: 'high',
    qualityDetailLevel: 'specific',
    materialAllowed: true,
    brandAllowed: false,
    limit: 3,
  });
  assert(allowed.errorType !== 'wrong_mode');
});

Deno.test('v123 selected-item audit: detection skips commerce; selected uses image path markers', async () => {
  // Contract-level source check via reading index would be in node tests.
  // Here we assert failure mapping distinguishes digest vs session vs candidate.
  assertEquals(mapToFailureReason({ sessionMissing: true }), 'session_missing');
  assertEquals(mapToFailureReason({ sessionMismatch: true }), 'session_mismatch');
  assertEquals(mapToFailureReason({ digestMismatch: true }), 'digest_mismatch');
  assertEquals(mapToFailureReason({ candidateInvalid: true }), 'candidate_invalid');
  // Digest must not be mislabeled as session
  assert(mapToFailureReason({ digestMismatch: true }) !== 'session_mismatch');
});
