import { isNonPublicHost } from '../_shared/net/publicHost.ts';
import { normalizeCategory } from '../scan-identify/qualityTuneNormalize.ts';
import type { DiscoveryInput, FashionAttributes } from './contracts.ts';

const CATEGORIES = new Set(['outerwear', 'blazer', 'dress', 'pants', 'top', 'footwear', 'bag', 'accessory']);
export function approvedDomain(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 253) return null;
  const host = value.toLowerCase();
  if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  if (isNonPublicHost(host) || /^\d+(\.\d+){3}$/.test(host) || /\.(local|internal|invalid|test|example)$/.test(host)) return null;
  return host;
}
/** Exact, reviewed hosts only. No wildcards, credentials, ports, or redirect parameters. */
export function safeCatalogUrl(value: unknown, domains: string[]): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!approvedDomain(url.hostname) || !domains.some((d) => approvedDomain(d) === url.hostname)) return null;
    if (/\b(redirect|redirect_uri|redirect_url|return|returnto|return_url|next|url|target|destination|continue)\b/i.test([...url.searchParams.keys()].join(' '))) return null;
    if (/\/(redirect|out|go|login|account|checkout|cart)(\/|$)/i.test(url.pathname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
export function text(value: unknown, max = 160): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f<>]/.test(value)) throw new Error('invalid_text');
  return value.trim() || undefined;
}
function singular(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (/(sses|shes|ches|xes)$/.test(token)) return token.slice(0, -2);
  return token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}
/** Canonical catalog subtype: "Chelsea Boots" and "chelsea-boot" both → "chelsea boot". */
export function subtypeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tokens = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);
  return tokens.length && tokens.length <= 8 ? tokens.join(' ') : null;
}
/**
 * Catalog subtypes a scanned subtype may match: the full key and its trailing
 * head-noun phrases ("black leather chelsea boots" → "chelsea boot", "boot").
 * A catalog subtype more specific than the scan never matches, and a different
 * head noun (sandal vs boot) never matches.
 */
export function subtypeMatchKeys(value: unknown): string[] {
  const key = subtypeKey(value);
  if (!key) return [];
  const tokens = key.split(' ');
  const keys = [key];
  for (let size = Math.min(3, tokens.length - 1); size >= 1; size--) keys.push(tokens.slice(-size).join(' '));
  return [...new Set(keys)];
}
export function sanitizeGarment(value: unknown): FashionAttributes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_garment');
  const source = value as Record<string, unknown>;
  const fields = ['item_type', 'subtype', 'primary_color', 'secondary_color', 'material_estimate', 'silhouette', 'pattern', 'distinctive_features'];
  if (Object.keys(source).some((k) => !fields.includes(k))) throw new Error('unsupported_garment_field');
  const category = normalizeCategory(text(source.item_type) ?? '');
  if (!CATEGORIES.has(category)) throw new Error('unsupported_category');
  const out: FashionAttributes = { item_type: category };
  for (const key of fields.slice(1, -1) as (keyof Omit<FashionAttributes, 'item_type' | 'distinctive_features'>)[]) {
    const v = text(source[key]);
    if (v) out[key] = v;
  }
  if (source.distinctive_features !== undefined) {
    if (!Array.isArray(source.distinctive_features) || source.distinctive_features.length > 8) throw new Error('invalid_features');
    out.distinctive_features = source.distinctive_features.map((v) => text(v, 80) ?? '').filter(Boolean);
  }
  return out;
}
export function parseDiscoveryInput(value: unknown): DiscoveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !['garment', 'market', 'primaryProducts'].includes(k))) throw new Error('unsupported_field');
  if (typeof v.market !== 'string' || !/^[A-Z]{2}$/.test(v.market)) throw new Error('invalid_market');
  if (!Array.isArray(v.primaryProducts) || v.primaryProducts.length > 30) throw new Error('invalid_primary_products');
  return { garment: sanitizeGarment(v.garment), market: v.market, primaryProducts: v.primaryProducts.map((p) => {
    if (!p || typeof p !== 'object' || Object.keys(p).some((k) => !['id', 'productUrl'].includes(k))) throw new Error('invalid_primary_product');
    const id = text(p.id, 160);
    if (!id || (p.productUrl !== undefined && (typeof p.productUrl !== 'string' || p.productUrl.length > 2048))) throw new Error('invalid_primary_product');
    return { id, ...(p.productUrl ? { productUrl: p.productUrl } : {}) };
  }) };
}
