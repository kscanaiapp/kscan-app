export interface Product {
  id: string;
  name: string;
  retailer: string;
  price: string;
  imageUrl: string | null;
  imageCategory?: string | null;
  productUrl?: string | null;
  purchaseUrl?: string | null;
  affiliateUrl?: string | null;
}

export type VintedSecondhandSearchRequest = {
  query: string;
  category?: string | null;
  color?: string | null;
  brand?: string | null;
  size?: string | null;
  limit?: number;
};

export type SecondhandItem = {
  id: string;
  title: string;
  price?: string;
  currency?: string;
  imageUrl?: string;
  listingUrl: string;
  brand?: string;
  size?: string;
  source: 'vinted';
};

export type VintedSecondhandErrorCode =
  | 'SECONDHAND_RESULTS_UNAVAILABLE'
  | 'FEATURE_DISABLED'
  | 'INVALID_REQUEST'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_SCHEMA_UNEXPECTED';

export type VintedSecondhandSearchResponse = {
  enabled: boolean;
  items: SecondhandItem[];
  error?: VintedSecondhandErrorCode;
  meta?: {
    resultCount: number;
    query?: string;
    source: 'vinted';
  };
};

import type { SneakerReference } from '../services/sneakers/types';
export type { SneakerReference };

export interface AnalysisResult {
  result: string;
  metadata: {
    category: string;
    color: string;
    silhouette: string;
    itemType?: string;
    brand?: string;
    size?: string;
  };
  products: Product[];
  secondhand?: VintedSecondhandSearchResponse;
  sneakerReference?: SneakerReference[] | null;
}
