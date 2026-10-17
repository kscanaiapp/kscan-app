import { LIVE_VTO_GOVERNED_ASSETS } from './vtoLiveGarmentRegistry';

// A real, explicitly selected retailer product, not a substitute for a scanned
// garment. The ordinary TryItOnEntry owns permissions, account and K+ gating.
const asset = LIVE_VTO_GOVERNED_ASSETS.find((entry) => entry.assetKey === 'ascolour-5001-black-v1');
export const LIVE_VTO_PILOT_PRODUCT = asset?.productUrl && asset.sourceImageUrl ? {
  id: asset.productUrl,
  productUrl: asset.productUrl,
  imageUrl: asset.sourceImageUrl,
  title: 'Staple Tee 5001 · Black',
  brand: 'AS Colour',
  retailer: 'AS Colour',
  category: 'top',
} : null;
