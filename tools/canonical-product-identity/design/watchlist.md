# Watchlist design (spec section 33) - DESIGN ONLY, no code change

**QUESTION**: what should Watchlist eventually monitor - a Canonical Variant, a Canonical Style, or a raw Offer?

**EVIDENCE**: `authority/sourceMap.json#crossFeatureIdentityAudit` - Watchlist's current identity is `(source, canonical_url)`, explicitly retailer-specific, explicitly NOT a product-level key (migration comment rejected a brand/title hash as unstable). `supabase/migrations/20260830150000_user_commerce_watches.sql:31-37`.

**RECOMMENDED MAPPING** (three distinct monitoring intents Watchlist conflates today):

| Customer intent | Future identity target |
|---|---|
| "Watch THIS exact listing" (this size, this retailer, this price) | Offer (today's model - keep as-is) |
| "Watch THIS exact product regardless of which retailer/URL changes" | Canonical Variant |
| "Watch THIS style regardless of color" | Canonical Style |

**RISK**: a Canonical Variant/Style watch is only as good as the resolver's own recall - a missed merge means the customer silently watches only one of several equivalent listings. Given the resolver's conservative default (recall 0.8 on the synthetic corpus, section 26), a variant-level watch would need to re-evaluate ALL retailer offers on every refresh, not just the originally-watched one, to avoid narrowing the customer's price/availability visibility versus today's per-URL watch.

**MIGRATION REQUIREMENT**: additive only - a new `watch_scope: 'offer' | 'variant' | 'style'` column, defaulting to `'offer'` (today's behavior, zero change). No migration in V1.

**REVERSIBILITY**: fully reversible - purely additive schema, no existing watch row's meaning changes.
