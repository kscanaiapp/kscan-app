import {
  normalizeImageUrl,
  normalizeUrl,
  type RecommendedProduct,
} from "../../../scan-identify/shoppingProvider.ts";
import { canonicalizeUrlForIdentity } from "../../../scan-identify/qualityTuneCommerce.ts";
import type { OwnershipIdentity } from "../../../black-owned-discovery/contracts.ts";
import type { Provider } from "./adapters.ts";

/**
 * Maximum lifetime of a session product reference. Owner decision 2026-11-04
 * (Build 35): 2 minutes, raised from 30 s so a customer can read the cards and
 * then ask to refine/compare. Catalog eligibility horizons still shorten it.
 */
export const RECORD_TTL_MS = 120_000;

export type Product = {
  ref: string;
  title: string;
  merchant: string;
  productUrl: string;
  imageUrl?: string;
  price?: string;
  currency?: string;
  ownership?: OwnershipIdentity;
  provenance: {
    provider: Provider;
    sourceId: string;
    observedAt: number;
    expiresAt: number;
    trust: "provider_record" | "eligible_server_record";
  };
};
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max &&
  !/[<>]/.test(v) && ![...v].some((char) => char.charCodeAt(0) < 32);
/** Closed projection: provider prose/unknown fields never become instructions, stock or ownership facts. */
export function normalizeProduct(
  value: unknown,
  provider: Provider,
  now: number,
): Product | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (!text(p.id, 160) || !text(p.title, 160) || !text(p.source, 60)) {
    return null;
  }
  const productUrl = normalizeUrl(p.productUrl);
  if (!productUrl) return null;
  let ownership: OwnershipIdentity | undefined;
  let expiresAt = now + RECORD_TTL_MS;
  if (provider === "eligible_catalog") {
    const o = p.ownershipIdentity as OwnershipIdentity | undefined;
    const verified = Date.parse(o?.verifiedUntil ?? "");
    const synced = Date.parse(
      typeof p.inventoryVerifiedAt === "string" ? p.inventoryVerifiedAt : "",
    );
    if (
      !o || o.ownershipVerificationStatus !== "verified" ||
      o.publicOwnershipLabelAllowed !== true ||
      !text(o.brandId, 160) || !text(o.brandName, 160) ||
      o.brandId !== p.brandId || o.brandName !== p.source ||
      !text(p.merchantId, 160) || !Number.isFinite(verified) ||
      verified <= now ||
      typeof p.eligibleUntil !== "number" ||
      !Number.isFinite(p.eligibleUntil) || p.eligibleUntil <= now ||
      !Number.isFinite(synced) || synced > now || now - synced >= 86_400_000
    ) return null;
    expiresAt = Math.min(
      expiresAt,
      verified,
      synced + 86_400_000,
      p.eligibleUntil,
    );
    ownership = {
      brandId: o.brandId,
      brandName: o.brandName,
      ownershipVerificationStatus: "verified",
      publicOwnershipLabelAllowed: true,
      verifiedUntil: o.verifiedUntil,
    };
  }
  return {
    ref: `p_${crypto.randomUUID()}`,
    title: p.title,
    merchant: p.source,
    productUrl,
    ...(normalizeImageUrl(p.imageUrl)
      ? { imageUrl: normalizeImageUrl(p.imageUrl) }
      : {}),
    ...(text(p.price, 24) ? { price: p.price } : {}),
    ...(typeof p.currency === "string" && /^[A-Z]{3}$/.test(p.currency)
      ? { currency: p.currency }
      : {}),
    ...(ownership ? { ownership } : {}),
    provenance: {
      provider,
      sourceId: p.id,
      observedAt: now,
      expiresAt,
      trust: provider === "eligible_catalog"
        ? "eligible_server_record"
        : "provider_record",
    },
  };
}
export const identity = (p: Product): string =>
  canonicalizeUrlForIdentity(p.productUrl) ?? p.productUrl;
export function asRecommended(p: Product): RecommendedProduct {
  return {
    id: p.provenance.sourceId,
    title: p.title,
    source: p.merchant,
    type: "similar",
    productUrl: p.productUrl,
    imageUrl: p.imageUrl,
    price: p.price,
  };
}
/** Accept only our existing en-US price renderer, with an explicitly supplied currency. Ambiguous strings fail closed. */
export function amount(p: Product): number | null {
  if (!p.currency || !p.price) return null;
  const matches = p.price.match(/\d[\d,]*(?:\.\d{1,2})?/g);
  if (matches?.length !== 1) return null;
  const n = Number(matches[0].replaceAll(",", ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const rendered = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: p.currency,
  }).format(n);
  return rendered === p.price || `${p.currency} ${n.toFixed(2)}` === p.price
    ? n
    : null;
}
