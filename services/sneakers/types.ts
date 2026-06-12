export interface SneakerReference {
  source: string;
  confidence: number;
  name: string;
  brand: string | null;
  model: string | null;
  sku: string | null;
  colorway: string | null;
  retailPrice: number | null;
  estimatedMarketValue: number | null;
  lowestAsk: number | null;
  lastSale: number | null;
  releaseDate: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  marketplaceLinks: {
    stockx?: string | null;
    goat?: string | null;
    flightClub?: string | null;
    stadiumGoods?: string | null;
    kickscrew?: string | null;
    other?: string | null;
  } | null;
  raw: unknown;
}

export interface SneakerSearchInput {
  rawText?: string;
  category?: string;
  categoryConfidence?: number;
  brand?: string;
  model?: string;
  sku?: string;
  colorway?: string;
  /** Product page URL — when present and a KicksCrew URL, the KicksCrew provider is called. */
  productUrl?: string;
}

export interface SneakerSearchOptions {
  maxResults?: number;
}
