# K Scan AI — Real-Device Scan Checklist v1

## Purpose
Validate signed-in real-device scans against App Staging.
Confirm the CATALOG MATCHES shelf populates from scan-identify v78 TEST rows.

> ⚠️ Code agents / CI cannot perform physical real-device validation. This checklist must be executed by a human tester with an actual phone in hand.

## Required Setup
- [ ] Physical device (iOS or Android).
- [ ] Signed-in staging user (Google/Apple/Email auth against App Staging).
- [ ] App configured with `EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=true`.
  - Local Metro runs: set it in `.env.local` (EAS development profile is not used by `npx expo start`).
  - EAS development builds: verify it is set in `eas.json` under `build.development.env`.
- [ ] App targeting Supabase App Staging project `wyyuqfdxucjksghsmhry`.
  - Verify `EXPO_PUBLIC_SUPABASE_URL=https://wyyuqfdxucjksghsmhry.supabase.co`.
  - Do **not** use Production or the Privacy project `yzqjvdfgefveprobvvyw` for scan testing.
- [ ] No global `mobile_feature_freeze` blocking `priceDiscovery` or `ProductShelf`.
- [ ] Restart Metro after changing any `EXPO_PUBLIC_*` variable.

## Metro / Dev Start
```bash
# Ensure env is loaded (Expo reads .env / .env.local)
# Restart Metro after any EXPO_PUBLIC_* change.
npx expo start
# Or for Android:
npx expo start --android
```

> On a physical device, local Metro uses your computer's LAN IP (e.g. `http://192.168.1.X:8081`), not `localhost`. The device must be on the same Wi-Fi network as the dev machine.

## Test Scans

### 1. Outerwear / Jacket
- [ ] Scan completed or failed
- [ ] Detected category shown
- [ ] displayResult shown (headline/details)
- [ ] CATALOG MATCHES shelf appeared
- [ ] Product cards appeared
- [ ] Image rendered (placeholder acceptable)
- [ ] Retailer shown
- [ ] Title/name shown
- [ ] Product link tappable
- [ ] Any error text
- [ ] Screenshot captured

### 2. Footwear / Sneakers or Boots
- [ ] Scan completed or failed
- [ ] Detected category shown
- [ ] displayResult shown
- [ ] CATALOG MATCHES shelf appeared
- [ ] Product cards appeared
- [ ] Image rendered
- [ ] Retailer shown
- [ ] Title/name shown
- [ ] Product link tappable
- [ ] Any error text
- [ ] Screenshot captured

### 3. Dress
- [ ] Scan completed or failed
- [ ] Detected category shown
- [ ] displayResult shown
- [ ] CATALOG MATCHES shelf appeared
- [ ] Product cards appeared
- [ ] Image rendered
- [ ] Retailer shown
- [ ] Title/name shown
- [ ] Product link tappable
- [ ] Any error text
- [ ] Screenshot captured

### 4. Bag / Handbag
- [ ] Scan completed or failed
- [ ] Detected category shown
- [ ] displayResult shown
- [ ] CATALOG MATCHES shelf appeared
- [ ] Product cards appeared
- [ ] Image rendered
- [ ] Retailer shown
- [ ] Title/name shown
- [ ] Product link tappable
- [ ] Any error text
- [ ] Screenshot captured

### 5. Non-Fashion Object (coffee mug, plant, keyboard)
- [ ] Scan completed or failed
- [ ] "This does not appear to be a fashion item..." message shown
- [ ] No CATALOG MATCHES shelf
- [ ] No crash
- [ ] Screenshot captured

## Dressing Room Save Path
> Requires the `dressingRooms` feature enabled and a signed-in user.
> Policy (verified in code + tests): a product is saveable only when it has a
> title AND a remote (http/https) image. TEST catalog rows use placehold.co
> images, so they are saveable. Image-less product saves are intentionally
> blocked by the service (`buildProductMatchSnapshot` throws
> `UnsupportedStyleObjectItemError`); the DB itself permits a null image only for
> the separate uploaded-scan-image path.
- [ ] Tap a product card's Add to Dressing Room action.
- [ ] Add a product to an existing Dressing Room.
- [ ] Create a new Dressing Room and add the product in the same modal flow.
- [ ] Verify the saved item appears in the target room with title, image, retailer/category, price if present, and product link if present.
- [ ] Test a product with missing price and confirm save/display does not show `$0.00` or "Free".
- [ ] A card showing "Can't Save Yet" (no remote image) opens a modal that explains it can't be saved and does NOT crash.
- [ ] Duplicate behavior: saving the same product twice currently creates two room items (duplicates allowed by design — no unique constraint). Note if this is undesired.
- [ ] Capture screenshots and Metro/device logs for any save failure (look for `UnsupportedStyleObjectItemError`).

## Debug Checklist (if shelf does not appear)
1. Check Metro logs: did `scan-identify` return `recommendedProducts`?
2. Check `analysis.products` is populated in `useKScan` / `app.js`.
3. Check `ProductShelf` received non-empty `products` prop.
4. Check `priceDiscovery` feature is not frozen by `mobile_feature_freeze`.
5. Check `AnalysisCard` logs for empty state vs ProductShelf not rendering.

## Image Debugging (if text appears but images are blank)
1. Check Metro/device logs for image load failures.
2. On Android, use `adb logcat` to identify TLS/network/image loading issues.
3. `placehold.co` placeholder images are expected for staging TEST rows.

## Backend / Model Debugging (if scan fails)
1. Check Metro logs for `gemini_http_error` — if so, verify `SCAN_GEMINI_MODEL` in App Staging.
2. Do not redeploy backend unless a source/config defect is proven.
3. Check auth: is the user signed in? (Edge Function requires authenticated JWT.)

## Expected Success State
- Signed-in real-device scan completes.
- CATALOG MATCHES shelf appears.
- Product cards display placeholder image, retailer, title/name, category, and tappable product link.
- No `$0.00` or "Free" shown for missing prices.
- Out-of-stock items show subtle "Out of stock" label.
