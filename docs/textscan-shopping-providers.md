# TextScan Shopping Providers — Technical Contract

Real shopping results for **TextScan** (text mode only; camera scan is unchanged).
Provider order: **Serper Shopping** (primary, retail cards) → **Brave Web Search**
(fallback, "similar" web/product links). Backend-driven and cross-platform
(Android + iOS share the same React Native code path; no native/eas/app.json changes).

## Live mobile mapper

The live TextScan mapper is **`services/textScanEdge.ts`**, specifically the
**`mapRecommendedProducts`** function. (Note: `services/textScan.ts`
`normalizeTextScanResult` force-empties products and is *not* the live product path.)

The mapper reads a product's URL from **`url`, `product_url`, or `purchaseUrl`** —
not only `productUrl`. Backend commerce results must therefore expose one of those
URL fields (they are emitted as `url` / `product_url`).

## Backend response contract

Backend TextScan commerce now emits, per recommended product:

- `price` as a **string** (e.g. `"$129.99"`, or a normalized `"From $45"` → `"$45"`),
  rather than a numeric price + currency.
- `type: "similar"` for **Brave fallback** results (Serper results use `type: "retail"`).

The mapper has been patched to accept a string `price` and to honor an explicit
`type: "similar"`, while remaining backward-compatible with the numeric price +
source-derived type behavior.

## Mobile build recommendation

A **new app build is recommended** so that string `price` values and correct
"Similar" labeling/visibility are fully surfaced to users. The two shared-RN
compatibility changes involved are:

1. `services/textScanEdge.ts` — `mapRecommendedProducts` accepts string `price`
   and honors `type: "similar"`.
2. `app/text-scan/index.tsx` — renders the "Similar Finds" section on the default
   **All** filter tab (previously only under the dedicated **Similar** tab).

### Compatibility caveat (not a statement about production)

Behavior on any given build depends on **whether that build includes the mapper /
display compatibility patch above**:

- A build **with** the patch: Serper results show retail cards with string prices;
  Brave fallback results show as tappable **"Similar"** cards (no price/image) and
  are visible on the default **All** tab.
- A build **without** the patch, talking to the new backend: it can still render
  products, but string prices are dropped (no price shown) and Brave `type:"similar"`
  results are classified from the source hostname (typically shown as **"Retail"**)
  and are not surfaced under the Similar tab.

This is a forward/backward compatibility caveat about builds that do or do not carry
the patch — **not** a guaranteed description of current production behavior.

## Status (as of 2026-07-05)

- Static validation complete: `tsc --noEmit` ✅, full node test suite incl.
  `__tests__/shoppingProvider.test.js` ✅, `deno check` on the edge function ✅.
- **Deploy to staging and authenticated staging smoke test are still pending.**

## Committing

This note should be committed **with** the TextScan shopping-provider changes
(`supabase/functions/scan-identify/`, `services/textScanEdge.ts`,
`app/text-scan/index.tsx`, `__tests__/shoppingProvider.test.js`) if the repo is
otherwise clean.
