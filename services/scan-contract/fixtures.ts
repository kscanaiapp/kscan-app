import { SCAN_CONTRACT_VERSION } from './version';
import type { ScanRequest, ScanSource, ScanPrivacyContext } from './request';
import type { ScanResponse } from './response';
import type { FashionAttributes } from './fashionAttributes';
import type { ProductMatch } from './productMatch';

/**
 * Synthetic fixture metadata only. No real user photographs, names, emails,
 * GPS coordinates, auth tokens, or production URLs.
 */

function passthroughPrivacy(overrides?: Partial<ScanPrivacyContext>): ScanPrivacyContext {
  return {
    sanitizerVersion: '1.0.0',
    mode: 'passthrough',
    faceDetectionPerformed: false,
    faceMaskApplied: false,
    plateDetectionPerformed: false,
    plateMaskApplied: false,
    ...overrides,
  };
}

function maskedPrivacy(): ScanPrivacyContext {
  return {
    sanitizerVersion: 'mock-1.0.0',
    mode: 'masked',
    faceDetectionPerformed: true,
    faceMaskApplied: true,
    plateDetectionPerformed: true,
    plateMaskApplied: true,
  };
}

export const FIXTURE_REQUEST_ID = 'scan-fixture-00000000-0000';

export function createFixtureRequest(
  source: ScanSource,
  input: { image?: boolean; textQuery?: string; privacy?: ScanPrivacyContext },
): ScanRequest {
  return {
    contractVersion: SCAN_CONTRACT_VERSION,
    requestId: FIXTURE_REQUEST_ID,
    source,
    image: input.image
      ? {
          base64:
            '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAgACADASIAAhEBAxEB/8QAGQAAAgMBAAAAAAAAAAAAAAAABAUAAgMG/8QAKBAAAgIBAwMDBAMBAAAAAAAAAQIDEQAEIQUSMUEGEyJRMmFxgZEU/8QAFwEAAwEAAAAAAAAAAAAAAAAAAQIDAP/EABkRAAMBAQEAAAAAAAAAAAAAAAABAgMRBP/aAAwDAQACEQMRAD8A0C3uG+QlHbbRj4xSsvSkkvY4WflHxQcU2ZJcnkZ2DxXnnmvJUlNpl0eHGS2iOwdL2H0qW1HmTXsV9R6fe6ddLE8U0Tq6nDKwDAj6gilHoA//9k=',
          mimeType: 'image/jpeg',
          width: 32,
          height: 32,
        }
      : undefined,
    textQuery: input.textQuery,
    privacy: input.privacy ?? passthroughPrivacy(),
    device: { deviceClass: source === 'wearable_mock' ? 'wearable_mock' : 'mobile' },
  };
}

export const fixtureBlackLeatherJacket: ScanResponse = {
  contractVersion: SCAN_CONTRACT_VERSION,
  requestId: FIXTURE_REQUEST_ID,
  status: 'success',
  attributes: {
    category: 'Outerwear',
    subcategory: 'Jacket',
    silhouette: 'Oversized',
    fit: 'Relaxed',
    color: 'Black',
    colorPalette: ['Black'],
    materialEstimate: 'Leather',
    styleTags: ['Streetwear', 'Minimalist'],
    confidence: 0.92,
  },
  products: [
    {
      id: 'mock-prod-black-jacket-001',
      title: 'Black Oversized Leather Jacket',
      retailer: 'Mock Retailer',
      price: 299,
      currency: '$',
      similarity: 0.94,
    },
  ],
};

export const fixtureWhiteRunningSneaker: ScanResponse = {
  contractVersion: SCAN_CONTRACT_VERSION,
  requestId: FIXTURE_REQUEST_ID,
  status: 'success',
  attributes: {
    category: 'Footwear',
    subcategory: 'Sneaker',
    silhouette: 'Low-top',
    color: 'White',
    colorPalette: ['White', 'Off-white'],
    materialEstimate: 'Synthetic mesh',
    styleTags: ['Athleisure'],
    confidence: 0.89,
  },
  products: [
    {
      id: 'mock-prod-white-sneaker-001',
      title: 'White Running Sneaker',
      retailer: 'Mock Retailer',
      price: 129,
      currency: '$',
      similarity: 0.91,
    },
  ],
};

export const fixtureFloralMidiDress: ScanResponse = {
  contractVersion: SCAN_CONTRACT_VERSION,
  requestId: FIXTURE_REQUEST_ID,
  status: 'success',
  attributes: {
    category: 'Dresses',
    subcategory: 'Midi dress',
    silhouette: 'Flowy',
    fit: 'Fitted',
    color: 'Floral',
    colorPalette: ['Pink', 'Green'],
    pattern: 'Floral',
    materialEstimate: 'Viscose',
    styleTags: ['Romantic'],
    occasionTags: ['Daytime'],
    confidence: 0.87,
  },
  products: [
    {
      id: 'mock-prod-floral-dress-001',
      title: 'Floral Midi Dress',
      retailer: 'Mock Retailer',
      price: 158,
      currency: '$',
      similarity: 0.88,
    },
  ],
};

export const fixtureBlueOversizedDenimJacket: ScanResponse = {
  contractVersion: SCAN_CONTRACT_VERSION,
  requestId: FIXTURE_REQUEST_ID,
  status: 'success',
  attributes: {
    category: 'Outerwear',
    subcategory: 'Jacket',
    silhouette: 'Oversized',
    fit: 'Relaxed',
    color: 'Blue',
    colorPalette: ['Blue', 'Indigo'],
    materialEstimate: 'Denim',
    styleTags: ['Casual', 'Streetwear'],
    confidence: 0.9,
  },
  products: [
    {
      id: 'mock-prod-denim-jacket-001',
      title: 'Blue Oversized Denim Jacket',
      retailer: 'Mock Retailer',
      price: 110,
      currency: '$',
      similarity: 0.92,
    },
  ],
};

export const fixtureNonFashionObject: ScanResponse = {
  contractVersion: SCAN_CONTRACT_VERSION,
  requestId: FIXTURE_REQUEST_ID,
  status: 'non_fashion',
  message: 'This looks like a wooden chair, not a fashion item.',
};

export const fixturePartialResponse: ScanResponse = {
  contractVersion: SCAN_CONTRACT_VERSION,
  requestId: FIXTURE_REQUEST_ID,
  status: 'partial',
  attributes: {
    category: 'Accessories',
    color: 'Brown',
    confidence: 0.42,
  },
  products: [],
};

export const fixtureProviderTimeout: ScanResponse = {
  contractVersion: SCAN_CONTRACT_VERSION,
  requestId: FIXTURE_REQUEST_ID,
  status: 'error',
  error: {
    code: 'ANALYSIS_TIMEOUT',
    message: 'Analysis took too long. Please try again.',
  },
};

export const fixtureEmptyProductList: ScanResponse = {
  contractVersion: SCAN_CONTRACT_VERSION,
  requestId: FIXTURE_REQUEST_ID,
  status: 'success',
  attributes: {
    category: 'Tops',
    subcategory: 'T-shirt',
    silhouette: 'Relaxed',
    color: 'White',
    confidence: 0.81,
  },
  products: [],
};

export const fixtureLegacyResponse: Record<string, unknown> = {
  type: 'fashion',
  result: 'A crisp white hoodie with a relaxed fit.',
  metadata: {
    category: 'Tops',
    itemType: 'hoodie',
    material: 'cotton-blend',
    style: 'Casual',
    color: 'White',
    silhouette: 'Relaxed',
  },
  products: [
    {
      id: 'legacy-001',
      name: 'White Relaxed Hoodie',
      retailer: 'Mock Retailer',
      price: 78,
      currency: '$',
      // FIX (glasses-foundation-audit): example.com is a live, resolvable
      // domain. Fixtures must use a reserved, guaranteed-non-resolving
      // placeholder (RFC 2606 / RFC 6761 .invalid TLD) so no fixture can
      // ever accidentally cause a real network request.
      imageUrl: 'https://example.invalid/placeholder.jpg',
      productUrl: 'https://example.invalid/product/legacy-001',
    },
  ],
};

export const fixtureWearableMockRequest: ScanRequest = createFixtureRequest('wearable_mock', {
  image: true,
  privacy: maskedPrivacy(),
});

export const allFixtureResponses: ScanResponse[] = [
  fixtureBlackLeatherJacket,
  fixtureWhiteRunningSneaker,
  fixtureFloralMidiDress,
  fixtureBlueOversizedDenimJacket,
  fixtureNonFashionObject,
  fixturePartialResponse,
  fixtureProviderTimeout,
  fixtureEmptyProductList,
];
