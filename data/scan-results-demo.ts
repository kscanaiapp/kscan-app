// UI DEMO DATA ONLY.
// Do not use as production product, retailer, price, inventory, or match data.

import type { ProductMatch, PurchaseOption, ScanResultV2 } from '../components/scan-results/types';

export const SCAN_RESULTS_DEMO_ENABLED =
  process.env.EXPO_PUBLIC_SCAN_RESULTS_DEMO_UI === 'true';

// Generic labels only — no real brands or retailers.
const DEMO_PRODUCT_MATCHES: ProductMatch[] = [
  {
    id: 'demo-1',
    title: 'Structured Blue Trench',
    brand: 'Retail Preview',
    retailer: 'Retail Preview',
    priceLabel: 'Price unavailable',
    matchPercent: 92,
    productUrl: undefined,
  },
  {
    id: 'demo-2',
    title: 'Heritage Outerwear',
    brand: 'Retail Preview',
    retailer: 'Retail Preview',
    priceLabel: 'Price unavailable',
    matchPercent: 87,
    productUrl: undefined,
  },
  {
    id: 'demo-3',
    title: 'Classic Tailored Coat',
    brand: 'Resale Preview',
    retailer: 'Resale Preview',
    priceLabel: 'Price unavailable',
    matchPercent: 78,
    productUrl: undefined,
  },
];

const DEMO_PURCHASE_OPTIONS: PurchaseOption[] = [
  {
    id: 'demo-po-1',
    retailer: 'Retail Preview',
    title: 'Structured Blue Trench',
    priceLabel: undefined,
    availabilityLabel: undefined,
    productUrl: undefined,
  },
  {
    id: 'demo-po-2',
    retailer: 'Resale Preview',
    title: 'Heritage Outerwear',
    priceLabel: undefined,
    availabilityLabel: undefined,
    productUrl: undefined,
  },
];

export function getDemoScanResultV2(base?: Partial<ScanResultV2>): ScanResultV2 {
  return {
    id: 'demo-scan-id',
    title: 'Blue Trench Coat',
    category: 'Outerwear',
    color: 'Blue',
    silhouette: 'Trench Coat',
    material: 'Cotton Blend',
    confidence: 0.92,
    matchLabel: '92% MATCH',
    styleTags: ['Tailored', 'Belted', 'Double-Breasted'],
    styleAnalysis:
      'K Scan AI identified a structured outerwear silhouette with classic tailoring details. The garment features a belted waist and double-breasted closure, characteristic of heritage trench styling.',
    similarFinds: DEMO_PRODUCT_MATCHES,
    purchaseOptions: DEMO_PURCHASE_OPTIONS,
    ...base,
  };
}
