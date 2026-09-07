# Future transaction contract (spec section 36) - DESIGN ONLY, no checkout implementation

**REQUIREMENT**: canonical identity must remain transactional - compatible with a future headless/API-first checkout, without this lab implementing checkout.

**FUTURE MODEL**:
```
Canonical Variant
      |
Retail Offers[]  (retailer, external_product_id, url, price, currency, availability, size)
      |
availability / price / retailer selection
      |
transaction path (existing retailer checkout today; headless/API-first later)
```

**WHY THIS SHAPE ALREADY FITS**: `lib/offerFactory.js`'s RetailOffer shape (this lab's own data model, not invented for this memo) already separates every transactional field (`price`, `currency`, `availability`, `sizeAvailable`, `sellerType`) from identity fields (`gtin`, `brand`, `color`, `material`). A canonical layer built on top of THIS shape never needs to touch transaction fields to determine identity, and never needs identity fields to execute a transaction - the two concerns are already structurally independent in the resolver's own input, which is exactly the property a future checkout integration needs (it can select an Offer by price/availability without re-deriving identity, and identity resolution never needs to know how checkout works).

**RISK**: the offer-selection step (which Offer becomes "the" transaction target for a given Canonical Variant) is a DISPLAY/COMMERCE decision (see `simulate/displayPolicy.js` D1's "best offer" tie-break), not a resolver decision - conflating the two would let identity resolution silently pick a retailer, which section 19 (retailer neutrality) forbids.

**REVERSIBILITY**: N/A - this section describes a compatibility property of the existing data model, not a new artifact.
