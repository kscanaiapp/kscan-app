# VTO design (spec section 35) - DESIGN ONLY, no runtime change

**QUESTION**: could Canonical Variant identity prevent duplicate garment processing for the same fashion item across VTO requests?

**EVIDENCE**: `authority/sourceMap.json#crossFeatureIdentityAudit` - VTO's `productRef` (`services/vto/vtoCommerceGarment.ts:86-107`) is explicitly documented as "a correlation handle, never an authorization input," derived from Commerce's own per-response `RecommendedProduct.id` - which is provider-synthesized per request (a hash of the raw URL) and NOT durable across sessions or retailers. The paid-generation idempotency key (`supabase/functions/vto-generate/vtoReservation.ts:51-66`) already hashes `userId|productRef|garmentImageUrl|personImageDigest|requestGeneration` - so today, the SAME physical garment reached via two different retailer offers gets two independent (and separately billed) generations.

**FUTURE MODEL**:
```
Canonical Variant -> governed garment asset -> many retailer offers
```
A governed garment asset (a stable, reviewed image/geometry reference tied to a Canonical Variant, not to any one retailer's `imageUrl`) would let the idempotency key hash on `canonicalVariantId` instead of `productRef`, so a second retailer offer for the identical variant reuses the already-paid generation instead of re-billing.

**RISK**: this is a genuine (future) cost lever - VTO generation is the paid boundary in this codebase (`vtoPaidBoundary.test.js`). Any canonical-identity-driven cache MUST inherit the existing paid-boundary safeguards; a false merge here would show a customer the WRONG garment on their own photo, which is a materially worse failure mode than a false merge in Commerce display. If this is ever built, its false-merge tolerance should be stricter than section 25's corpus-level gate, not the same threshold.

**MIGRATION REQUIREMENT**: a `governed_garment_assets` table (canonical_variant_id, image reference, review status) - no SQL migration in V1.

**REVERSIBILITY**: fully reversible as a design - no VTO runtime code touched by this lab.
