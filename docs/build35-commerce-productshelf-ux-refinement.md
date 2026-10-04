# Build 35 Commerce / ProductShelf convergence

The historical #457 branch was rebuilt on the current Build 35 integration authority.

Preserved:
- explicit purchase-path truth instead of a decorative link marker;
- declared-currency display and Watch price handoff;
- 2–3 item local comparison using only listing facts already present;
- current Save, Watch and VTO actions remain authoritative.

Deliberately not restored:
- the removed StyleChat `commerce_products` block;
- historical transaction-readiness or rationale modules that are absent from current authority;
- any client ranking, retailer preference, model call, provider call, retrieval, schema or backend change.

Because current ProductShelf has no transaction-readiness authority, a verified destination is labeled **VIEW AT RETAILER**, not **SHOP**. This is intentional truth preservation.

No deployment or production/staging configuration change.
