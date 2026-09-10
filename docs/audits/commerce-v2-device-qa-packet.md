# Commerce V2 — Device QA Run Packet

**DEVICE QA: PENDING-RUNTIME.** No device or simulator is available in the
lane that wrote this. Nothing in this document has been visually verified —
it is the script for whoever runs it on hardware.

Run on a small phone first (375 pt width, e.g. iPhone SE) and then one
standard phone. Capture a screenshot for every case marked **SHOT**.

Test-data note: the seeded corpus at `__tests__/fixtures/commerce/offers.js`
carries a matching case for nearly every row below (`caseId` given in
parentheses); use those shapes when stubbing a scan result.

---

## Surface 1 — ProductShelf (legacy "SIMILAR ITEMS" shelf)

**SETUP:** open a scan result that renders `ProductShelf` (Dressing Room
"Add to Room" flow, or the fallback surface).

| # | Case | Expected retailer | Logo / monogram | Expected price | Retail/Resale badge | Shop | Watch | Accessibility | SHOT |
|---|---|---|---|---|---|---|---|---|---|
| 1.1 | Known registered retailer (`retail_farfetch_declared`) | `FARFETCH` | Monogram-free text row (text-only mode) | `$425.00` | `RETAIL` | Card tap opens farfetch.com in browser | Shown only if `watchCapability === 'refreshable_listing'` | Card announces product title; Watch button announces "Watch {product title}" | ✅ |
| 1.2 | Unregistered but real retailer (`{retailer:'Not In Registry Boutique'}`) | `NOT IN REGISTRY BOUTIQUE` verbatim | No monogram (unregistered ⇒ none) | as provided | none unless offer declared one | opens its URL | per capability | name announced verbatim | ✅ |
| 1.3 | Unknown retailer (`unknown_retailer_no_url`) | **no retailer line at all** | none | as provided | none | **absent/disabled** — no URL | absent | nothing announced for retailer | ✅ |
| 1.4 | **brand ≠ retailer** (`{brand:"Levi's", retailer:'Farfetch'}`) | `FARFETCH` — **never `LEVI'S`** | — | — | `RETAIL` | — | — | — | ✅ |
| 1.5 | Resale (`resale_poshmark_declared`) | `POSHMARK` | — | `$210.00` | `RESALE` | opens poshmark.com | — | — | ✅ |
| 1.6 | Unknown currency (`unknown_currency_no_fabrication`) | `FARFETCH` | — | **`310.00` — bare, no `$`** | `RETAIL` | — | — | — | ✅ |
| 1.7 | Missing image (`missing_image`) | `FARFETCH` | category placeholder art + "Image pending" | `$690.00` | `RETAIL` | — | — | placeholder announces "Catalog image unavailable for {title}" | ✅ |
| 1.8 | Legacy persisted row (reopen a Saved Scan whose stored retailer is a brand and whose URL is `shop.nordstrom.com`) | `NORDSTROM` — corrected from the URL, not the stored brand | — | — | — | opens the stored URL unchanged | — | — | ✅ |

**FAIL CONDITIONS:** a brand name appears in the retailer line; a `$` appears
on an undeclared-currency price; a Shop control appears with no destination;
the Watch control appears on a listing without `refreshable_listing`; the
retailer line renders "Unknown"/"Retailer" placeholder text instead of being
absent.

---

## Surface 2 — PurchaseOptionsPanel (shipped ScanResultV2)

**SETUP:** run a normal single-item scan with V2 UI enabled.

| # | Case | Expected | SHOT |
|---|---|---|---|
| 2.1 | Registered retailer row | retailer line, then title, then `RETAIL`/`RESALE`; price and availability right-aligned | ✅ |
| 2.2 | Retailer that resolves to nothing | row still renders; retailer shows the panel's own `'Retailer'` default rather than a fabricated name | ✅ |
| 2.3 | Safe destination present | "View Options" pill; tapping opens the browser at the exact offer URL | ✅ |
| 2.4 | No safe destination | **"Unavailable"** label, no tappable control | ✅ |
| 2.5 | Watch-capable offer (`watchable_offer`) | "Watch" pill beside View Options; K+ gate opens upgrade when inactive | ✅ |
| 2.6 | Non-watchable (`non_watchable_offer`) | **no Watch control at all** | ✅ |
| 2.7 | 2+ offers | **WHERE TO BUY** block below the rows, one line per retailer with an exact count | ✅ |
| 2.8 | Exactly 1 offer | **no** Where to Buy block | ✅ |
| 2.9 | Multi-item scan | one block per detected garment; jacket actions act on jacket offers only | ✅ |

**ACCESSIBILITY:** each row's link announces "View options for {title or
retailer}" with hint "Opens this listing in your browser"; Watch announces
"Watch {title}"; each Where to Buy row announces "{retailer}, N offer(s)".

**FAIL CONDITIONS:** a Shop tap opens a different row's URL; Where to Buy
shows a retailer not present in the rows above; counts disagree with the
visible rows; any "Best Deal"/"Cheapest" wording.

---

## Surface 3 — SecondhandShelf (Vinted)

| # | Case | Expected | SHOT |
|---|---|---|---|
| 3.1 | Any listing | retailer line reads `VINTED`; brand and size still shown in the meta row | ✅ |
| 3.2 | Price string pair | rendered as provided; never a fabricated symbol | ✅ |
| 3.3 | Tap card | opens the Vinted listing through the existing guarded opener | ✅ |
| 3.4 | Rejected URL | "LINK UNAVAILABLE" notice, no navigation | ✅ |
| 3.5 | Image fails to load | `VINTED` placeholder block | ✅ |

**FAIL CONDITION:** brand shown where `VINTED` belongs; size/condition data
lost.

---

## Surface 4 — Watchlist list

| # | Case | Expected | SHOT |
|---|---|---|---|
| 4.1 | Watch at a registered retailer | retailer line uppercase (`FARFETCH`) via the shared component | ✅ |
| 4.2 | Row a11y | announces "{title}, {price or 'price unavailable'}, {status pill}" | ✅ |
| 4.3 | Target reached | "Target reached" pill visible **and** announced | ✅ |
| 4.4 | Never checked | "Not checked yet" | ✅ |

---

## Surface 5 — Watchlist detail

| # | Case | Expected | SHOT |
|---|---|---|---|
| 5.1 | Header | title, then retailer via shared component, then current price | ✅ |
| 5.2 | Price with unknown currency | bare amount, no `$` | ✅ |
| 5.3 | "VIEW ON RETAILER" | opens the exact stored `canonicalUrl`; never a reconstructed search | ✅ |
| 5.4 | Stored URL now unsafe | control does nothing; no crash | ✅ |
| 5.5 | Controls | REFRESH / PAUSE (or RESUME) / DELETE all labelled, not icon-only | ✅ |
| 5.6 | Staleness | "Last checked …" always visible; never hidden | ✅ |

---

## Surface 6 — Where to Buy

| # | Case | Expected | SHOT |
|---|---|---|---|
| 6.1 | 3 retailers, 1 offer each | three rows, each "1 offer", in first-appearance order | ✅ |
| 6.2 | Resale-only retailer | "1 resale offer" | ✅ |
| 6.3 | **Concentration** — 8 offers at one retailer, 2 at another | shows "8 offers" / "2 offers" truthfully; **no artificial balancing** | ✅ |
| 6.4 | Unknown retailer among offers | its own "Unknown retailer" row; never merged into a named retailer | ✅ |
| 6.5 | Ordering | matches the order retailers first appear in the rows above; **not** alphabetical, **not** price-sorted | ✅ |

---

## Cross-cutting

| # | Case | Expected | SHOT |
|---|---|---|---|
| X.1 | **375 pt width density** | no clipped retailer line, no overlapping badge/price, no horizontal body scroll on any surface | ✅ |
| X.2 | Long retailer name at 375 pt | truncates on one line; layout does not reflow | ✅ |
| X.3 | Monogram fallback | **currently unreachable** — zero rights-cleared logos ship, so every registered retailer renders text/monogram. Re-run this row only after a logo is added | ✅ |
| X.4 | Screen reader sweep | no duplicate retailer announcement anywhere (logo images are marked decorative) | ✅ |
| X.5 | Ranking | offer order identical to pre-Commerce-V2 build for the same scan | ✅ |

---

## Reporting

For each failure record: surface, case #, device, OS version, screenshot,
and the exact on-screen text. A retailer-name or currency defect is **P0** —
those are the two truths this whole lane exists to protect.
