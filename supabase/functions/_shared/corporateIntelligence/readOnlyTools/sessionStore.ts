/**
 * OC-01 cross-request reference store.
 *
 * Edge Function isolates do not keep memory between HTTP requests, so the
 * broker's per-session record map cannot carry a refine/compare follow-up on
 * its own. This port persists ONLY broker-produced products, server-side,
 * through two service-role RPCs (migration 20261104193023). The mobile client
 * and the model can never write here.
 *
 * Every loaded row is re-validated against the closed `Product` shape and its
 * own expiry before the broker may use it; anything malformed is dropped, so a
 * corrupted row can only ever shrink what a follow-up can reference.
 */
import { normalizeImageUrl, normalizeUrl } from "../../../scan-identify/shoppingProvider.ts";
import type { Product } from "./products.ts";

/** Hard ceiling from the OC-01 contract (Addendum A8). */
export const MAX_REFERENCE_LIFETIME_MS = 30_000;
export const MAX_STORED_REFERENCES = 32;

/** `batchAt` is the store write time shared by one result set; `position` is its card order. */
export type StoredReference = { product: Product; position: number; batchAt: string };

export type ReferenceStore = {
  load: (
    actorId: string,
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<StoredReference[]>;
  save: (
    actorId: string,
    conversationId: string,
    products: readonly Product[],
    signal: AbortSignal,
  ) => Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^p_[a-f0-9-]{36}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[<>]/.test(v) &&
  ![...v].some((c) => c.charCodeAt(0) < 32);

/** Closed re-validation of a stored record. Returns null for anything not exactly a live broker product. */
export function restoreProduct(raw: unknown, now: number): Product | null {
  if (!isRecord(raw)) return null;
  const allowed = [
    "ref",
    "title",
    "merchant",
    "productUrl",
    "imageUrl",
    "price",
    "currency",
    "ownership",
    "provenance",
  ];
  if (Object.keys(raw).some((k) => !allowed.includes(k))) return null;
  if (typeof raw.ref !== "string" || !REF.test(raw.ref)) return null;
  if (!text(raw.title, 160) || !text(raw.merchant, 60)) return null;
  if (typeof raw.productUrl !== "string" || normalizeUrl(raw.productUrl) !== raw.productUrl) return null;
  if (raw.imageUrl !== undefined && (!text(raw.imageUrl, 2048) || normalizeImageUrl(raw.imageUrl) !== raw.imageUrl)) return null;
  if (raw.price !== undefined && !text(raw.price, 24)) return null;
  if (raw.currency !== undefined && (typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency))) return null;
  const p = raw.provenance;
  if (!isRecord(p)) return null;
  if (!["serper", "brave", "eligible_catalog"].includes(String(p.provider))) return null;
  if (!text(p.sourceId, 160)) return null;
  if (typeof p.observedAt !== "number" || typeof p.expiresAt !== "number") return null;
  if (!Number.isFinite(p.observedAt) || !Number.isFinite(p.expiresAt)) return null;
  if (p.expiresAt <= now || p.expiresAt - p.observedAt > MAX_REFERENCE_LIFETIME_MS) return null;
  const trust = p.provider === "eligible_catalog" ? "eligible_server_record" : "provider_record";
  if (p.trust !== trust) return null;
  let ownership: Product["ownership"];
  if (raw.ownership !== undefined) {
    const o = raw.ownership;
    // Ownership is only ever carried by an eligible catalog record.
    if (p.provider !== "eligible_catalog" || !isRecord(o)) return null;
    if (
      o.ownershipVerificationStatus !== "verified" || o.publicOwnershipLabelAllowed !== true ||
      !text(o.brandId, 160) || !text(o.brandName, 160) || typeof o.verifiedUntil !== "string" ||
      !(Date.parse(o.verifiedUntil) > now)
    ) return null;
    ownership = {
      brandId: o.brandId,
      brandName: o.brandName,
      ownershipVerificationStatus: "verified",
      publicOwnershipLabelAllowed: true,
      verifiedUntil: o.verifiedUntil,
    };
  }
  return {
    ref: raw.ref,
    title: raw.title,
    merchant: raw.merchant,
    productUrl: raw.productUrl,
    ...(raw.imageUrl ? { imageUrl: raw.imageUrl as string } : {}),
    ...(raw.price ? { price: raw.price as string } : {}),
    ...(raw.currency ? { currency: raw.currency as string } : {}),
    ...(ownership ? { ownership } : {}),
    provenance: {
      provider: p.provider as Product["provenance"]["provider"],
      sourceId: p.sourceId,
      observedAt: p.observedAt,
      expiresAt: p.expiresAt,
      trust,
    },
  };
}

/** Service-role RPC binding. `rest` is the existing server helper; never a user-scoped client. */
export function createSupabaseReferenceStore(
  rest: (path: string, init?: RequestInit) => Promise<Response>,
  now: () => number = Date.now,
): ReferenceStore {
  return {
    async load(actorId, conversationId, signal) {
      if (!UUID.test(actorId) || !UUID.test(conversationId)) return [];
      const res = await rest("rpc/elise_commerce_refs_load", {
        method: "POST",
        body: JSON.stringify({ p_actor: actorId, p_session: conversationId }),
        signal,
      });
      if (!res.ok) throw new Error("reference_store_unavailable");
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error("reference_store_malformed");
      const out: StoredReference[] = [];
      const t = now();
      for (const row of rows.slice(0, MAX_STORED_REFERENCES)) {
        if (!isRecord(row) || typeof row.ref !== "string") continue;
        if (!(Date.parse(String(row.expires_at)) > t)) continue;
        const product = restoreProduct(row.record, t);
        if (!product || product.ref !== row.ref) continue;
        const position = Number(row.batch_position);
        if (!Number.isInteger(position) || position < 1 || position > 8) continue;
        const batchAt = typeof row.created_at === "string" ? row.created_at : "";
        if (!batchAt) continue;
        out.push({ product, position, batchAt });
      }
      return out;
    },
    async save(actorId, conversationId, products, signal) {
      if (!UUID.test(actorId) || !UUID.test(conversationId) || products.length === 0) return;
      const records = products.slice(0, 16).map((p, i) => ({
        ref: p.ref,
        position: (i % 8) + 1,
        expiresAtMs: Math.min(p.provenance.expiresAt, p.provenance.observedAt + MAX_REFERENCE_LIFETIME_MS),
        record: p,
      }))
        // A record the store (4096 bytes) or restoreProduct would refuse is skipped,
        // never allowed to abort the whole batch (review P3-1). Fail closed: that
        // one card simply cannot be referenced by a follow-up.
        .filter((r) =>
          JSON.stringify(r.record).length <= 3_800 &&
          restoreProduct(r.record, now()) !== null
        );
      if (records.length === 0) return;
      const res = await rest("rpc/elise_commerce_refs_store", {
        method: "POST",
        body: JSON.stringify({ p_actor: actorId, p_session: conversationId, p_records: records }),
        signal,
      });
      if (!res.ok) throw new Error("reference_store_unavailable");
    },
  };
}
