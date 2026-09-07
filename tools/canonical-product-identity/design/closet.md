# Closet design (spec section 34) - DESIGN ONLY, no code change

**QUESTION**: can canonical identity prevent duplicate owned/saved products originating from different retailer metadata?

**EVIDENCE**: `authority/sourceMap.json#crossFeatureIdentityAudit` - Closet items carry a client-generated `client_id` and, by explicit design (`services/closetLibrary.js:172-180`, "COMMERCE EXCLUSION BOUNDARY"), NO product_url/external_product_id/retailer field at all - pure fashion taxonomy, no commerce identity today. Saved Scans store an opaque `products` jsonb snapshot with no dedup.

**FINDING**: Closet's commerce-exclusion boundary is intentional and predates this lab; canonical identity cannot plug into a field that was deliberately removed. The realistic opportunity is narrower than "prevent duplicate Closet items" - it is **Saved Scans**, where the same physical garment scanned twice (or added from two different retailer result sets) currently produces two unrelated, undeduplicated `products` snapshots.

**RECOMMENDED DIRECTION**: at Saved-Scan-write time, resolve the scan's top candidate against the customer's own existing saved products (Canonical Variant match) and surface "you already saved something like this" as a suggestion, never an automatic merge - consistent with the resolver's own conservative-by-default posture (section 7).

**RISK**: any write-path change to Closet must not cross the COMMERCE EXCLUSION BOUNDARY the codebase already established - a canonical-identity suggestion belongs at the Saved-Scans layer, not inside Closet's taxonomy-only item shape.

**PERSISTENCE**: would require Saved Scans to carry a `canonicalVariantId` reference - out of scope for V1 (no persistent canonical registry exists at all yet; see `persistence.md`).

**REVERSIBILITY**: fully reversible - a suggestion-only UX affordance with no schema change to Closet itself.
