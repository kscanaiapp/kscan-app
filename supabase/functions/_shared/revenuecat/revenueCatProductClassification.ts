/**
 * K+ provider product classification (Build 35 Phase C).
 *
 * The typed boundary that says which STORE PRODUCT is which K+ product class.
 *
 *   MONTHLY_SUBSCRIPTION -> the store_subscription grant model
 *   LIFETIME             -> the store_lifetime grant model
 *
 * Owner product ids are still pending, so THIS FILE NAMES NONE. The mapping is
 * server configuration (Edge Function secret `KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION`,
 * a JSON document), read at request time:
 *
 *   {
 *     "version": 1,
 *     "products": [
 *       { "store": "apple",  "productId": "<store product id>", "class": "MONTHLY_SUBSCRIPTION" },
 *       { "store": "google", "productId": "<store product id>", "class": "LIFETIME" }
 *     ]
 *   }
 *
 * Rules (all fail closed -- an unclassified product is never granted K+):
 *   - Matching is EXACT on (store, productId). There is no substring, prefix or
 *     naming-convention inference ("monthly", "lifetime", ...) anywhere.
 *   - Apple and Google ids are configured separately: the same K+ product has
 *     different ids in each store.
 *   - The same (store, productId) listed twice is AMBIGUOUS, even if both rows
 *     agree: the whole document is rejected, because a mapping nobody can read
 *     unambiguously is a mapping nobody reviewed.
 *   - A missing, unparseable or malformed document classifies nothing.
 */
import { KPLUS_STORES, type KPlusStore } from '../kplus/kplusEntitlementContract.ts';

export const KPLUS_PRODUCT_CLASSES = ['MONTHLY_SUBSCRIPTION', 'LIFETIME'] as const;
export type KPlusProductClass = (typeof KPLUS_PRODUCT_CLASSES)[number];

export const KPLUS_PRODUCT_CLASSIFICATION_ENV = 'KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION' as const;

export type KPlusProductClassificationConfig =
  | { status: 'configured'; entries: ReadonlyMap<string, KPlusProductClass> }
  | { status: 'not_configured' }
  | { status: 'invalid'; reason: 'unparseable' | 'malformed' | 'ambiguous' };

export type KPlusProductClassification =
  | { status: 'classified'; productClass: KPlusProductClass }
  | { status: 'unknown_product' }
  | { status: 'configuration_error'; reason: 'not_configured' | 'unparseable' | 'malformed' | 'ambiguous' };

const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function key(store: KPlusStore, productId: string): string {
  return `${store}\u0000${productId}`;
}

export function parseKPlusProductClassification(raw: string | null | undefined): KPlusProductClassificationConfig {
  if (raw === null || raw === undefined || raw.trim() === '') return { status: 'not_configured' };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'unparseable' };
  }
  if (!doc || typeof doc !== 'object' || (doc as { version?: unknown }).version !== 1) {
    return { status: 'invalid', reason: 'malformed' };
  }
  const products = (doc as { products?: unknown }).products;
  if (!Array.isArray(products) || products.length === 0) return { status: 'invalid', reason: 'malformed' };

  const entries = new Map<string, KPlusProductClass>();
  for (const row of products) {
    if (!row || typeof row !== 'object') return { status: 'invalid', reason: 'malformed' };
    const { store, productId, class: productClass } = row as Record<string, unknown>;
    if (
      typeof store !== 'string' || !(KPLUS_STORES as readonly string[]).includes(store)
      || typeof productId !== 'string' || !PRODUCT_ID.test(productId)
      || typeof productClass !== 'string' || !(KPLUS_PRODUCT_CLASSES as readonly string[]).includes(productClass)
    ) {
      return { status: 'invalid', reason: 'malformed' };
    }
    const k = key(store as KPlusStore, productId);
    if (entries.has(k)) return { status: 'invalid', reason: 'ambiguous' };
    entries.set(k, productClass as KPlusProductClass);
  }
  return { status: 'configured', entries };
}

/** Exact lookup. Never infers a class from the shape of an id. */
export function classifyKPlusProduct(
  config: KPlusProductClassificationConfig,
  store: KPlusStore,
  productId: string,
): KPlusProductClassification {
  if (config.status === 'not_configured') return { status: 'configuration_error', reason: 'not_configured' };
  if (config.status === 'invalid') return { status: 'configuration_error', reason: config.reason };
  const productClass = config.entries.get(key(store, productId));
  return productClass ? { status: 'classified', productClass } : { status: 'unknown_product' };
}
