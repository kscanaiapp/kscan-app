import {
  deriveWatchCapability,
  watchProviderForUrl,
} from "../../../scan-identify/watchlistCapability.ts";
import {
  normalizeImageUrl,
  normalizeUrl,
} from "../../../scan-identify/shoppingProvider.ts";
import { parseOfferPrice } from "../../../scan-identify/canonicalCommerce.ts";
import { formatOfferPrice } from "../../../scan-identify/offerCurrency.ts";
import { resolveObservedCurrency } from "../../../commerce-watch-refresh/watchCurrency.ts";
import { MAX_ACTIVE_WATCHES_PER_ACTOR } from "../../../commerce-watch-refresh/watchRefreshConfig.ts";
import type { Sql } from "../customerAuthorization/repository.ts";
import {
  ensure,
  EXECUTION_VERSION,
  type VerifiedProduct,
  type WatchRow,
  type WatchSpec,
} from "./contracts.ts";

/** Only an authoritative record resolver can supply this input; no client listing argument exists. */
export function watchSpec(product: VerifiedProduct): WatchSpec {
  const listing = product.listing;
  ensure(
    deriveWatchCapability(listing) === "refreshable_listing",
    "unsupported_listing",
  );
  const url = normalizeUrl(listing.productUrl);
  const source = watchProviderForUrl(url);
  ensure(
    url && (source === "farfetch" || source === "kickscrew"),
    "unsupported_listing",
  );
  const price = parseOfferPrice(listing.price);
  const currency = resolveObservedCurrency(listing.price);
  ensure(
    typeof listing.title === "string" && listing.title.trim().length > 0 &&
      listing.title.length <= 200,
    "unsupported_listing",
  );
  ensure(
    price.value !== null && Number.isFinite(price.value) && price.value > 0 &&
      currency && listing.currency === currency &&
      formatOfferPrice(price.value, currency) === listing.price,
    "unsupported_listing",
  );
  ensure(
    typeof product.target.provenance.sourceId === "string" &&
      product.target.provenance.sourceId.length > 0 &&
      product.target.provenance.sourceId.length <= 200,
    "unsupported_listing",
  );
  return {
    version: EXECUTION_VERSION,
    source,
    canonicalUrl: url,
    providerListingId: product.target.provenance.sourceId,
    title: listing.title,
    imageUrl: normalizeImageUrl(listing.imageUrl) ?? null,
    initialPrice: price.value,
    currency,
    watchIntent: "just_watching",
    targetPrice: null,
  };
}
export function matchesWatch(
  row: WatchRow,
  spec: WatchSpec,
  actorId: string,
): boolean {
  return row.user_id === actorId && row.source === spec.source &&
    row.canonical_url === spec.canonicalUrl &&
    row.watch_intent === spec.watchIntent &&
    row.target_price_amount === null && row.currency === spec.currency &&
    row.deleted_at === null && row.status === "active";
}
export async function findWatch(
  sql: Sql,
  actorId: string,
  url: string,
): Promise<WatchRow | null> {
  return (await sql.query<WatchRow>(
    "select * from public.user_commerce_watches where user_id=$1 and canonical_url=$2 and deleted_at is null for update",
    [actorId, url],
  )).rows[0] ?? null;
}
export async function applyWatch(
  sql: Sql,
  actorId: string,
  spec: WatchSpec,
): Promise<{ watch: WatchRow; effect: "created" | "already_watched" }> {
  const existing = await findWatch(sql, actorId, spec.canonicalUrl);
  if (existing) {
    ensure(
      matchesWatch(existing, spec, actorId),
      "existing_watch_change_requires_approval",
    );
    return { watch: existing, effect: "already_watched" };
  }
  const count = (await sql.query<{ count: number }>(
    "select count(*)::int as count from public.user_commerce_watches where user_id=$1 and deleted_at is null",
    [actorId],
  )).rows[0].count;
  ensure(
    Number.isSafeInteger(count) && count < MAX_ACTIVE_WATCHES_PER_ACTOR,
    "watch_limit",
  );
  // This is the existing governed RPC, not a new watch table or entitlement implementation.
  await sql.query(
    "select * from public.create_user_commerce_watch($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      actorId,
      spec.source,
      spec.canonicalUrl,
      spec.providerListingId,
      spec.title,
      spec.imageUrl,
      spec.initialPrice,
      spec.currency,
      spec.watchIntent,
      spec.targetPrice,
    ],
  );
  const watch = await findWatch(sql, actorId, spec.canonicalUrl);
  ensure(watch && matchesWatch(watch, spec, actorId), "mutation_unverified");
  return { watch, effect: "created" };
}
