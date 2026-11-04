// OC-01 — Elise read-only product results (find / refine / compare / verified
// Black-owned discovery), mobile side of the additive `oc01-products-v1`
// response contract.
//
// The server only sends `commerceResults` to a client that advertises this
// capability, so released builds never receive it. This module is the single
// validation point: an unknown version or malformed payload yields `null` and
// the conversational reply renders exactly as before. Nothing here is trusted
// beyond display: links still pass the shared external-URL guard when opened,
// and an ownership label renders only when the server attached a verified,
// unexpired identity to a verified-catalog record.

import { isSafeCommerceUrl } from '../commerceDestination';
import { hasVerifiedOwnership, type OwnershipIdentity } from '../blackOwnedDiscovery';

export const ELISE_COMMERCE_CONTRACT_VERSION = 'oc01-products-v1' as const;
/** Advertised to stylechat-generate (provider header literal must equal this; tested). */
export const ELISE_COMMERCE_CLIENT_CAPABILITY = ELISE_COMMERCE_CONTRACT_VERSION;
export const ELISE_COMMERCE_BLOCK_TYPE = 'elise_commerce_results' as const;

export type EliseCommerceKind = 'find' | 'refine' | 'compare' | 'black_owned' | 'action';
export type EliseCommerceStatus = 'ready' | 'empty' | 'unavailable' | 'expired' | 'unsupported_action' | 'denied';

export interface EliseCommerceProduct {
  number: number;
  title: string;
  merchant: string;
  productUrl: string;
  imageUrl?: string;
  listedPrice?: string;
  currency?: string;
  source: 'shopping_provider' | 'verified_catalog';
  observedAt: string;
  ownershipIdentity?: OwnershipIdentity;
}

export interface EliseCommerceResults {
  version: typeof ELISE_COMMERCE_CONTRACT_VERSION;
  kind: EliseCommerceKind;
  status: EliseCommerceStatus;
  reasonCode: string | null;
  products: EliseCommerceProduct[];
}

export interface EliseCommerceBlock extends EliseCommerceResults {
  type: typeof ELISE_COMMERCE_BLOCK_TYPE;
}

const KINDS: readonly EliseCommerceKind[] = ['find', 'refine', 'compare', 'black_owned', 'action'];
const STATUSES: readonly EliseCommerceStatus[] = ['ready', 'empty', 'unavailable', 'expired', 'unsupported_action', 'denied'];
const MAX_PRODUCTS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || t.length > max || /[<>\u0000-\u001f]/.test(t)) return null;
  return t;
}

function parseProduct(value: unknown, index: number): EliseCommerceProduct | null {
  if (!isRecord(value)) return null;
  const title = boundedText(value.title, 160);
  const merchant = boundedText(value.merchant, 60);
  const productUrl = isSafeCommerceUrl(value.productUrl);
  if (!title || !merchant || !productUrl) return null;
  if (value.number !== index + 1) return null;
  const source = value.source === 'verified_catalog' ? 'verified_catalog' : value.source === 'shopping_provider' ? 'shopping_provider' : null;
  if (!source) return null;
  const observedAt = typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt)) ? value.observedAt : null;
  if (!observedAt) return null;
  const imageUrl = typeof value.imageUrl === 'string' && /^https:\/\//i.test(value.imageUrl) && value.imageUrl.length <= 2048
    ? value.imageUrl
    : undefined;
  const listedPrice = boundedText(value.listedPrice, 24) ?? undefined;
  const currency = typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) ? value.currency : undefined;
  // Ownership only on a verified-catalog record, and only while verified.
  const identity = source === 'verified_catalog' && isRecord(value.ownershipIdentity)
    ? (value.ownershipIdentity as unknown as OwnershipIdentity)
    : undefined;
  const ownershipIdentity = identity && hasVerifiedOwnership(identity) ? identity : undefined;
  return {
    number: index + 1,
    title,
    merchant,
    productUrl,
    ...(imageUrl ? { imageUrl } : {}),
    ...(listedPrice ? { listedPrice } : {}),
    ...(currency ? { currency } : {}),
    source,
    observedAt,
    ...(ownershipIdentity ? { ownershipIdentity } : {}),
  };
}

/** Validates a wire payload. Any defect in the envelope or any product → null (render nothing, keep the reply). */
export function parseEliseCommerceResults(value: unknown): EliseCommerceResults | null {
  if (!isRecord(value)) return null;
  if (value.version !== ELISE_COMMERCE_CONTRACT_VERSION) return null;
  if (!KINDS.includes(value.kind as EliseCommerceKind)) return null;
  if (!STATUSES.includes(value.status as EliseCommerceStatus)) return null;
  if (!Array.isArray(value.products) || value.products.length > MAX_PRODUCTS) return null;
  const reasonCode = value.reasonCode === null || value.reasonCode === undefined
    ? null
    : boundedText(value.reasonCode, 60);
  if (value.reasonCode != null && reasonCode === null) return null;
  const products: EliseCommerceProduct[] = [];
  for (let i = 0; i < value.products.length; i++) {
    const p = parseProduct(value.products[i], i);
    if (!p) return null;
    products.push(p);
  }
  const status = value.status as EliseCommerceStatus;
  if (status === 'ready' && products.length === 0) return null;
  if (status !== 'ready' && products.length > 0) return null;
  return { version: ELISE_COMMERCE_CONTRACT_VERSION, kind: value.kind as EliseCommerceKind, status, reasonCode, products };
}

export function toEliseCommerceBlock(results: EliseCommerceResults): EliseCommerceBlock {
  return { type: ELISE_COMMERCE_BLOCK_TYPE, ...results };
}

/** Re-validates a stored ui_block on render (persisted blocks are display data, never authority). */
export function parseEliseCommerceBlock(block: unknown): EliseCommerceResults | null {
  if (!isRecord(block) || block.type !== ELISE_COMMERCE_BLOCK_TYPE) return null;
  const { type: _type, ...rest } = block;
  return parseEliseCommerceResults(rest);
}

/** Deterministic, server-independent notice copy for non-ready states. */
export const ELISE_COMMERCE_NOTICE: Record<Exclude<EliseCommerceStatus, 'ready'>, string> = {
  empty: 'No matching products found for this search.',
  unavailable: 'Product search is unavailable right now.',
  denied: 'Product search is unavailable right now.',
  expired: 'Those results expired. Ask Elise to search again.',
  unsupported_action: 'Elise can’t buy, save or add items for you in this release. Open a product to shop on the merchant’s site.',
};

export const ELISE_COMMERCE_BLACK_OWNED_EMPTY = 'No verified Black-owned products are available for this request right now.';
