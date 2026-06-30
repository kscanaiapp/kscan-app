# Real Image Scan Readiness Build v3 — Test Plan

## Purpose
This document guides the owner/tester through validating real-image scan behavior on App Staging before any release packaging.

## App Staging Target
- **Supabase Project ref:** `wyyuqfdxucjksghsmhry`
- **Supabase URL:** `https://wyyuqfdxucjksghsmhry.supabase.co`
- **scan-identify Edge Function:** `https://wyyuqfdxucjksghsmhry.supabase.co/functions/v1/scan-identify`
- **Environment check:** Verify `EXPO_PUBLIC_SUPABASE_URL` in your `.env` file points to the App Staging URL above.

## Authentication
- The app uses Supabase Auth with AsyncStorage session persistence.
- The scan-identify Edge Function requires an authenticated user (it rejects anonymous calls).
- **How to test:** Sign in via the app using Google/Apple/Email auth against App Staging.
- If scans return `401 Unauthorized`, confirm you are signed in and the session is valid.

## Five Required Real-Device Scans

### 1. Jacket or Coat
- **Expected:** App does not crash. AI returns `outerwear` category. ProductShelf appears with outerwear products. Cards show image, name, retailer, price, and valid link.
- **Fallback:** If no matches, you see "No exact matches found. Try scanning the item from a clearer front angle."

### 2. Sneakers or Shoes
- **Expected:** AI returns `footwear` category. ProductShelf appears with footwear products.
- **Fallback:** Same as above.

### 3. Dress
- **Expected:** AI returns `dress` category. ProductShelf appears with dress products.
- **Fallback:** Same as above.

### 4. Bag or Handbag
- **Expected:** AI returns `bag` category. ProductShelf appears with bag products.
- **Fallback:** Same as above.

### 5. Non-Fashion Object (e.g., coffee mug, plant, keyboard)
- **Expected:** App returns "This does not appear to be a fashion item..." gracefully. No ProductShelf. No crash.

## Low-Confidence Scan Guidance
- If the scan returns `confidenceScore < 0.70` or a `scan_quality_note`, a "Scan tip" box appears with guidance like:
  - "Try a clearer photo with better lighting."
  - "Move closer to the garment."
  - "Try a straight-on front view."

## ProductShelf Behavior Checklist
- [ ] Product image loads (or shows a clean placeholder if broken/missing).
- [ ] Product name is visible and truncated after 2 lines.
- [ ] Retailer or brand is visible when available.
- [ ] Price is formatted correctly (e.g., `$120.00`). No `$0.00` or "Free" unless explicitly zero.
- [ ] Tap opens the product URL in the browser.
- [ ] Missing URL disables tap safely (no crash).
- [ ] Out-of-stock items show a subtle "Out of stock" label.
- [ ] Match scores are NOT displayed in the UI (hidden in data only).

## Failure Reporting Template
If a scan fails, capture:
- Screenshot of the result screen.
- Scan type (jacket, sneaker, dress, bag, non-fashion).
- Expected category.
- Actual category shown.
- Did ProductShelf appear?
- Did images load?
- Did product tap open the browser?
- Safe JSON excerpt (no image base64, no user ID, no tokens):
  ```json
  {
    "status": "completed",
    "attributes": { "category": "..." },
    "recommendedProducts": [ { "id": "...", "name": "..." } ]
  }
  ```

## Known Blockers for This Build
- **Deno not available:** Edge Function source was modified but `deno check` could not be run locally. The deploy step should be done by the owner after verifying Deno/tests pass.
- **DB access not available:** App Staging catalog data could not be audited or fixed directly. The owner must verify the catalog has at least 2 `in_stock` rows per major category (outerwear, footwear, dress, bag, accessory) and that `image_url`/`product_url` values are valid. If the catalog is insufficient, run `scripts/seed-test-catalog.sql` against App Staging or insert rows via the Supabase Dashboard.

## Pre-Test Verification Checklist
- [ ] App `.env` points to App Staging Supabase URL.
- [ ] `scan-identify` Edge Function is deployed to App Staging.
- [ ] You are signed in to the app (valid JWT/session).
- [ ] `priceDiscovery` feature flag is enabled (or `SCAN_IDENTIFY_BACKEND_ENABLED` is true and the app routes to the Edge Function).
- [ ] App Staging catalog has realistic `in_stock` rows with valid image URLs.
