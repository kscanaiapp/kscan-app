# Retailer Logo Assets (Commerce V2)

This directory holds retailer wordmark/logo assets for `RetailerIdentity`
presentation (Commerce V2, Build 35). It is empty by default and stays empty
for any retailer without a proven rights basis.

## Rights gate — read before adding a file here

A logo is committed to this directory only when its rights basis is known
and documented in the retailer registry entry (`logoRightsBasis`). Acceptable
bases:

- an asset already shipped and approved elsewhere in this app
- an asset the product owner explicitly provided/approved for this use
- explicit merchant or affiliate-network authorization on file

No web search, scraping, hotlinking, or third-party logo API is used to
source a logo. If no rights basis is documented, the registry entry sets
`logoAsset: null` and the retailer renders with the monogram fallback
(`RetailerIdentity`) instead — never a placeholder image file.

## Naming

`<retailerKey>.png` (or the source format actually provided), where
`retailerKey` is the exact key used in
`services/commerce/retailerRegistry.ts`. One file per retailer. Do not add
multiple sizes/variants unless a real caller needs them.

## Registry mapping

Every file here must be referenced by exactly one entry in
`services/commerce/retailerRegistry.ts` via that entry's `logoAsset`. A file
with no registry entry pointing to it, or a registry entry pointing to a
missing file, is a bug — `RetailerIdentity` and its tests treat a missing
asset the same as `logoAsset: null` (monogram fallback), never as a crash.

## Fallback behavior

`RetailerIdentity` always works without a logo. Retailer identity
(`retailerKey` + `displayName`) is resolved independently of whether a logo
asset exists; presence or absence of a logo file has no effect on retailer
resolution, ranking, or offer ordering (Commerce V2 retailer neutrality —
see Build 35 Commerce V2 plan §5).

## Adding a future logo

1. Confirm and record the rights basis (see gate above).
2. Add the asset file here, named by `retailerKey`.
3. Add or update the matching entry in
   `services/commerce/retailerRegistry.ts`, setting `logoAsset` and
   `logoRightsBasis`.
4. Add/update the registry test coverage that asserts retailer A never
   renders logo B.
