# Phase 2 persistence design (spec section 37) - DESIGN ONLY, no SQL migration in V1

**QUESTION**: does persistent canonical identity eventually need `canonical_products` / `canonical_variants` / `retailer_offers` / `identity_evidence` tables?

**BENEFITS**:
- Cross-session/cross-scan reuse of resolver decisions (avoids re-resolving the same retailer pair on every request - the resolver is cheap per call, section 30, but a persistent registry avoids re-fetching evidence at all).
- A stable `canonicalVariantId` other surfaces (Watchlist, VTO) could reference, per `watchlist.md`/`vto.md`.
- Enables `identity_evidence` as an audit trail - explainability (section 16) surviving beyond one request/response cycle.

**RISKS**:
- **False-merge persistence risk**: an in-request false merge is visible in one response and gone; a PERSISTED false merge silently and durably corrupts a canonical product's identity across every future customer who sees it, until someone notices and reconciles it. This raises the bar for what "safe to persist" means well above what section 25's per-request gate already enforces - a persistent registry needs its OWN, stricter promotion gate (e.g. only Tier 1 validated-identifier merges ever get persisted automatically; everything else requires human review before being written).
- **Staleness**: retailer offers (price/availability) change constantly; a `retailer_offers` table needs its own refresh/TTL story, independent of canonical identity, or it becomes a second source of truth that drifts from the live provider response.
- **Reconciliation**: if the resolver version changes (a new normalization rule, a new signal), previously-persisted canonical groupings may become wrong under the new logic. A persisted registry needs a re-resolution/reconciliation job, not just a one-time migration.

**MIGRATION REQUIREMENTS** (future, not V1): `canonical_products` (style), `canonical_variants` (variant, FK to style), `retailer_offers` (offer, FK to variant, unique on (retailer, external_product_id)), `identity_evidence` (append-only, FK to variant pair, resolver_version + decision + evidence snapshot).

**CACHE REQUIREMENTS**: `retailer_offers` price/availability needs a short TTL and a refresh path independent of the canonical grouping itself (the pattern already exists for Watchlist - `commerce-watch-refresh/`).

**ROLLBACK**: any auto-merge-driven write must be reversible - a `canonical_variants.superseded_by` self-reference (never a destructive delete) so an incorrect persisted merge can be undone without losing the offers that were attached to it.

**REVERSIBILITY**: N/A - no migration exists in V1; this is evaluation only.
