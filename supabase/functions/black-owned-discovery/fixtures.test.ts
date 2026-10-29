// Isolated synthetic inventory. No live merchant, campaign, credential or request.
import type { CatalogRow, DiscoveryInput } from './contracts.ts';
export const NOW = Date.parse('2026-10-29T12:00:00Z');
export const input: DiscoveryInput = { garment: { item_type: 'outerwear', subtype: 'bomber', primary_color: 'black', material_estimate: 'leather', silhouette: 'cropped' }, market: 'US', primaryProducts: [] };
export const row: CatalogRow = {
  id: 'fixture-product', brand_id: 'fixture-brand', merchant_id: 'fixture-merchant', source_product_id: 'fixture-source', variant_id: '',
  title: 'Synthetic black leather cropped bomber', category: 'outerwear', subtype: 'bomber', attributes: { primary_color: 'black', material_estimate: 'leather', silhouette: 'cropped' },
  image_url: 'https://images.fixture-fashion.com/bomber.jpg', product_url: 'https://fixture-fashion.com/products/bomber', price_amount: '120', currency: null,
  availability: 'in_stock', sizes: ['M'], markets: ['US'], synced_at: new Date(NOW-1000).toISOString(), expires_at: new Date(NOW+3_600_000).toISOString(),
  brand_name: 'Synthetic Fixture Brand', verified_until: new Date(NOW+86_400_000).toISOString(), approved_domains: ['fixture-fashion.com'], image_domains: ['images.fixture-fashion.com'],
};
