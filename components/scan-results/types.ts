export type ProductMatch = {
  id: string;
  title: string;
  brand?: string;
  retailer?: string;
  imageUrl?: string;
  priceLabel?: string;
  matchPercent?: number;
  productUrl?: string;
};

export type PurchaseOption = {
  id: string;
  retailer: string;
  title?: string;
  priceLabel?: string;
  availabilityLabel?: string;
  productUrl?: string;
};

export type ScanResultV2 = {
  id?: string;
  imageUri?: string;
  imageUrl?: string;
  scannedImage?: string;
  capturedImage?: string;
  thumbnail?: string;
  productImage?: string;
  title?: string;
  category?: string;
  color?: string;
  silhouette?: string;
  material?: string;
  confidence?: number;
  matchLabel?: string;
  styleTags?: string[];
  styleAnalysis?: string;
  analysisText?: string;
  similarFinds?: ProductMatch[];
  purchaseOptions?: PurchaseOption[];
};

export type LegacyAnalysisData = {
  result?: string;
  metadata?: {
    category?: string;
    color?: string;
    silhouette?: string;
    material?: string;
    confidence?: number;
    styleTags?: string[];
  };
  products?: any[];
  secondhand?: any;
  sneakerReference?: any[];
};

/** Maps legacy analysis data into the V2 shape for forward-compat rendering. */
export function mapLegacyToV2(
  legacy: LegacyAnalysisData | null | undefined,
  scanImageUri?: string | null
): ScanResultV2 | null {
  if (!legacy) return null;

  const meta = legacy.metadata ?? {};
  const analysisText = legacy.result ?? '';

  // Build a title from available metadata (no fake brands)
  let title = 'Style Match';
  if (meta.color && meta.category) {
    title = `${meta.color} ${meta.category} Match`;
  } else if (meta.category) {
    title = `${meta.category} Match`;
  }

  return {
    imageUri: scanImageUri ?? undefined,
    title,
    category: meta.category || undefined,
    color: meta.color || undefined,
    silhouette: meta.silhouette || undefined,
    material: meta.material || undefined,
    confidence: typeof meta.confidence === 'number' ? meta.confidence : undefined,
    styleTags: meta.styleTags,
    styleAnalysis: analysisText || undefined,
    analysisText: analysisText || undefined,
    similarFinds: undefined,
    purchaseOptions: undefined,
  };
}
