# General Shopping API Evaluation

Date reviewed: 2026-07-05

This document evaluates the Google Shopping-powered general product-offer API currently referenced in this repo as `product-search-deals` against the existing Serper Shopping fallback used by `scan-identify`.

Scope of this document:

- Evaluation only.
- No provider integration.
- No production logic changes.
- No secret changes.
- No deploy.

Important note:

- The repo already contains a backend-only spike at [supabase/functions/product-search-deals/index.ts](/C:/Users/jsmit/KScan/supabase/functions/product-search-deals/index.ts) pointing at `real-time-product-search.p.rapidapi.com`.
- That spike targets the `/deals` path.
- For scan-commerce replacement or backup work, the more relevant provider capability appears to be the provider's keyword product-search endpoint rather than the deals-only endpoint.
- This distinction matters because `scanCommerceRouter` needs real keyword product search, not a generic discounts/deals feed.

## 1. API Summary

API name:

- Real-Time Product Search

RapidAPI host:

- `real-time-product-search.p.rapidapi.com`

Relevant endpoint(s):

- Repo spike currently uses `GET /deals`
- Provider docs indicate a general keyword product-search capability via a search endpoint
- For K Scan scan-commerce evaluation, the relevant future candidate is the provider's keyword search capability, not the deals feed

Required params:

- `q`

Common optional params confirmed in the repo spike:

- `limit`
- `offset`
- `country`
- `language`
- `sort_by`
- `product_condition`

Additional optional filtering documented by the provider, but not yet verified against the RapidAPI playground in this repo:

- price-range filters
- store filters
- free-shipping filters
- free-returns filters

Authentication method:

- RapidAPI header auth
- `x-rapidapi-key`
- `x-rapidapi-host`

Free-tier / quota:

- RapidAPI pricing currently shows `Basic` at `100 requests / month` with a hard limit
- Free-plan rate limit appears to be `1000 requests per hour`

Timeout expectation:

- Provider docs say typical response time is about `1s to 5s`
- For scan use, any future integration should still use a tighter backend timeout cap around the current scan-commerce envelope, not the older `20s` spike timeout

Does it support real keyword product search:

- Yes, according to the provider's product-search docs
- However, the repo's current spike is `/deals`, so real keyword-search behavior is not yet proven in this codebase

## 2. API Role

Classification:

- general shopping fallback

Why:

- It is not a specialized fashion catalog
- It is not a sneaker-specific source
- It is not a detail-by-URL enrichment provider
- It is a broad Google Shopping-backed offer search across many merchants

## 3. Comparison to Serper

### Product title quality

- Serper: already good enough for the current `shoppingProvider.ts` mapping and ranking flow
- New API: likely richer and more commerce-native because the provider is product-specific, but this is still an inference until live samples are reviewed

### Product URL quality

- Serper: current repo mapping already treats Serper product URLs as usable primary commerce links
- New API: public samples show mixed URL quality
- Some samples show direct merchant offer pages
- Some public samples show Google ad/click redirect URLs
- This is the biggest risk for K Scan because ProductShelf needs stable, user-safe merchant links

### Image URL quality

- Serper: current mapping is already straightforward
- New API: public samples show Google-hosted shopping image URLs and photo arrays
- This is usable in principle, but would require validation for shelf stability and anti-hotlink behavior

### Price availability

- Serper: usually has a display price when Google Shopping exposes one
- New API: likely stronger here
- Provider docs show price, original price, sale signals, shipping, and offer-level metadata

### Retailer / source availability

- Serper: already provides enough source labeling for the current shelf
- New API: likely stronger because store and merchant fields are central to the offer model

### Availability / stock support

- Serper: limited in the current repo integration
- New API: potentially stronger because the provider is offer-oriented
- That said, explicit stock semantics are not confirmed from the public samples reviewed for this evaluation

### Response consistency

- Serper: simpler and already normalized in this repo
- New API: probably broader but more complex
- Expect more branching between product listings, merchant offers, deals, and possibly sponsored results

### Latency

- Serper official guidance is roughly `1s to 2s`, with occasional `2s to 4s`
- New API provider guidance is roughly `1s to 5s`
- Serper is the safer low-latency fit for scan UX today

### Quota / free-tier limits

- Serper: official site currently advertises `2,500 free queries`
- New API: `100 requests / month` on the Basic free tier
- Serper is much friendlier for experimentation and higher-volume fallback traffic

### Cost

- Serper: official site currently advertises pricing starting around `$0.30 per 1000 queries`
- New API: current public pricing is materially higher
- Pro tier math is about `$2.50 per 1000 requests`
- Pay-as-you-go is about `$5.00 per 1000 requests`
- For a fallback provider, this is a significant disadvantage unless result quality is measurably better

### Rate limits

- Serper: official site currently describes very high concurrency on paid usage
- New API: free plan appears capped at `1000/hour`; paid tiers show much lower RPS than Serper

### Affiliate / link usefulness

- Serper: current integration already treats the resulting URLs as directly useful retail links
- New API: link usefulness is not yet proven
- Mixed direct-offer vs Google-redirect behavior would make it less attractive for checkout intent

### Field mapping difficulty

- Serper: already integrated, low mapping cost, low risk
- New API: moderate mapping cost
- Future integration would need:
  - endpoint choice validation
  - product-vs-offer selection rules
  - Google redirect filtering
  - image array normalization
  - merchant/source extraction
  - price formatting
  - strict URL validation

## 4. Required Response Contract

K Scan `recommendedProducts` / ProductShelf minimum contract:

- `title` or `name`
- `productUrl` or `url`
- `imageUrl` if available
- `price` if available
- `retailer` / `source` if available
- `type = retail`

Evaluation:

- The provider appears capable of returning title-like fields
- The provider appears capable of returning image and price fields
- The provider appears capable of returning merchant/source fields
- The unresolved question is whether the provider can reliably return merchant-direct product URLs instead of Google redirect or tracking links

Conclusion on contract readiness:

- Not proven yet
- Do not add it until at least one live keyword-search sample is reviewed and mapped

If the future live sample set does not reliably provide:

- a usable title
- a valid merchant product URL

then the recommendation should remain: do not add it

## 5. Test Query Plan

Future comparison queries:

Fashion / apparel:

- red Lacoste polo shirt
- black Chanel handbag
- tan Burberry trench coat
- white linen dress
- black leather jacket

Sneakers:

- Nike Air Force 1 white
- Jordan 1 Chicago
- Adidas Samba black gum
- New Balance 990 grey

General products:

- Apple AirPods Pro
- Dyson hair dryer
- Stanley tumbler

For each future query, compare:

- Serper top 5
- new API top 5
- Brave fallback top 5 if useful

Review criteria for each top 5:

- direct merchant URL or redirect URL
- valid product image
- price present
- merchant/source present
- obvious relevance to query
- duplicate rate
- fashion usefulness vs general noise

## 6. Recommendation

Recommendation:

- A. Do not add.

Reason:

- Serper is already integrated and working
- Serper is faster on paper
- Serper is much cheaper on paper
- Serper has a much better free-tier envelope
- The new API's URL quality is not yet trustworthy enough for a direct shelf integration
- The repo's current spike points to `/deals`, not a proven scan-commerce keyword-search path

Conservative next step:

- Do not integrate until at least one live keyword-search response sample is reviewed and mapped
- If later samples show clearly better merchant coverage and stable direct URLs, reevaluate as:
  - B. Add as Serper backup
  - or D. Add as A/B-tested general-shopping provider

## 7. Future Integration Requirements

If approved later, require all of the following:

- backend-only provider file
- feature flag
- provider-specific API key
- safe timeout
- no raw payload logging
- no API key exposure
- normalized product mapping
- URL validation
- image URL validation
- price formatting
- dedupe against Farfetch / Serper / Brave / catalog
- tests for failure / fallback
- scan intelligence source capture
- no ProductShelf changes

Additional requirement specific to this provider:

- explicit filtering or rejection of Google redirect / ad-click URLs when merchant-direct URLs are unavailable

## 8. Placement if Added Later

If added later, likely provider placement would be:

For non-sneaker fashion:

- Farfetch -> Serper OR new API -> Brave -> catalog

For sneaker scans:

- KicksCrew -> Farfetch -> Serper OR new API -> Brave -> catalog

Possible future ordering options:

Option 1:

- Farfetch -> Serper -> new API -> Brave -> catalog

Option 2:

- Farfetch -> new API -> Serper -> Brave -> catalog

Option 3:

- Farfetch -> best-performing general-shopping provider -> Brave -> catalog

Decision:

- Do not choose a final order until live comparison is complete

## 9. App Build Impact

- No app build is needed if the provider returns the existing `recommendedProducts` shape
- An app update is only needed if ProductShelf UI, request shape, response contract, or native/mobile behavior changes

## Sources

Primary sources reviewed:

- OpenWeb Ninja Real-Time Product Search docs: [openwebninja.com/api/real-time-product-search](https://www.openwebninja.com/api/real-time-product-search)
- RapidAPI listing: [rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-product-search](https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-product-search)
- RapidAPI pricing page: [rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-product-search/pricing](https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-product-search/pricing)
- Serper official site: [serper.dev](https://serper.dev/)

Repo-local context reviewed:

- [supabase/functions/product-search-deals/index.ts](/C:/Users/jsmit/KScan/supabase/functions/product-search-deals/index.ts)
- [supabase/functions/scan-identify/shoppingProvider.ts](/C:/Users/jsmit/KScan/supabase/functions/scan-identify/shoppingProvider.ts)
