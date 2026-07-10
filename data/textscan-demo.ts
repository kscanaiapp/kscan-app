// UI DEMO DATA ONLY.
// Do not use as production retailer, product, price, or inventory data.
// These records exist purely to exercise the TextScan results layout during
// local smoke tests when TEXTSCAN_DEMO_RESULTS_ENABLED is true.

export interface TextScanDemoProduct {
  id: string;
  title: string;
  price?: string;
  source: string;
  type: 'retail' | 'resale' | 'similar';
  imageUrl?: string;
  productUrl?: string;
}

export interface TextScanDemoAttributes {
  category: string;
  silhouette: string;
  color: string;
  material: string;
  style: string;
  budget: string;
}

export const TEXTSCAN_DEMO_SUGGESTIONS = [
  'Linen wide-leg pants',
  'Black leather tote bag',
  'Silk slip dress, midi',
  'Dad sneakers, neutral',
];

export const TEXTSCAN_DEMO_ATTRIBUTES: TextScanDemoAttributes = {
  category: 'Jacket',
  silhouette: 'Oversized',
  color: 'Forest Green',
  material: 'Corduroy',
  style: 'Vintage, 90s',
  budget: 'Under $200',
};

export const TEXTSCAN_DEMO_PRODUCTS: TextScanDemoProduct[] = [
  {
    id: 'demo-retail-1',
    title: 'Heritage Corduroy Jacket',
    price: '$185',
    source: 'Retail Preview',
    type: 'retail',
  },
  {
    id: 'demo-retail-2',
    title: 'Oversized Utility Jacket',
    price: '$145',
    source: 'Retail Preview',
    type: 'retail',
  },
  {
    id: 'demo-resale-1',
    title: 'Vintage-Inspired Cardigan',
    price: '$78',
    source: 'Resale Preview',
    type: 'resale',
  },
  {
    id: 'demo-resale-2',
    title: 'Structured Penny Loafer',
    price: '$112',
    source: 'Marketplace Preview',
    type: 'resale',
  },
  {
    id: 'demo-retail-3',
    title: 'Soft Tailored Blazer',
    price: '$198',
    source: 'Retail Preview',
    type: 'retail',
  },
  {
    id: 'demo-resale-3',
    title: 'Washed Canvas Chore Coat',
    price: '$64',
    source: 'Resale Preview',
    type: 'resale',
  },
];
