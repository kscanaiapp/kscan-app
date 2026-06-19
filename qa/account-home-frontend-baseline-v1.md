# K Scan AI — Account Setup + Home Frontend Baseline V1

## 1. Purpose

This QA baseline captures the new visual direction for the K Scan AI account setup, landing, permissions, and Home surfaces.

These mockups are the source-of-truth visual reference for the next frontend implementation pass.

This is not a backend task and not a production verification report.

**Disclaimer:** This document is a QA/design reference only. It is not an implementation instruction by itself. Future implementation work must be separately scoped and approved. Do not infer approval to build bottom navigation, commerce cards, feature flags, backend wiring, retailer integrations, fake inventory, fake pricing, or fake recommendations from this baseline document.

## 2. Mockup Inventory

| Mockup | Repo Path | Purpose |
|---|---|---|
| Home Page | qa/mockups/account-home-v1/home-page-v1.png | Home dashboard / navigation hub direction |
| Login | qa/mockups/account-home-v1/account-login-v1.png | Account entry / sign-up method selection |
| Permissions | qa/mockups/account-home-v1/permissions-v1.png | Camera, photos, microphone, notifications permission education |
| Landing Page | qa/mockups/account-home-v1/landing-page-v1.png | First-run landing / value proposition / get started |

## 3. Design Baseline

The new frontend direction is bright luxury technology, not tan/beige and not dark mode.

Visual principles:

- Luminous pearl / ivory / white background
- Deep plum for primary CTAs and selected navigation
- Champagne / brushed gold accents
- Editorial serif headline styling
- High-letter-spacing uppercase action labels
- Soft luxury cards with light shadows
- Fashion editorial product imagery
- Privacy-first trust language
- Clear mobile safe-area spacing
- Premium but readable interface contrast

Do not revert to a dark Obsidian/Chrome theme for this phase.

Do not make the background too tan or muted.

The target feeling is:

- vibrant luxury tech
- bright editorial fashion
- private AI styling
- visual shopping intelligence

## 4. Screen-by-Screen Notes

### Landing Page

Reference:

```text
qa/mockups/account-home-v1/landing-page-v1.png
```

Purpose:

First-run entry screen that introduces K Scan AI before account setup.

Key elements:

* K Scan logo and AI Stylist / Visual Shopping subtitle
* Premium fashion/product collage
* Headline: "See it. Scan it. Style it."
* Primary CTA: "Get Started"
* Secondary CTA: "I Already Have an Account"
* Step indicator showing Step 1 of 6

Frontend implication:

This should become the first onboarding/account setup entry surface, not a generic auth form.

### Account Login / Sign-Up

Reference:

```text
qa/mockups/account-home-v1/account-login-v1.png
```

Purpose:

Account creation and login method selection.

Key elements:

* K Scan branding
* Visual shopping hero collage
* Welcome copy
* Email sign-up
* Continue with Apple
* Continue with Google
* Existing member login link
* Step indicator showing Step 2 of 6

Frontend implication:

This is the new account setup direction. It should replace plain sign-up UI when the auth frontend pass begins.

Important compliance note:

If Google login remains available for iOS, Sign in with Apple must remain available as an equivalent option.

### Permissions

Reference:

```text
qa/mockups/account-home-v1/permissions-v1.png
```

Purpose:

Permission education and onboarding before entering the full app.

Key elements:

* Camera permission card
* Photos permission card
* Microphone optional card
* Notifications optional card
* Continue to Home CTA
* Not now link
* Step indicator showing Step 5 of 6

Frontend implication:

Camera and Photos are essential to core scan/upload flows. Microphone and Notifications should remain optional unless/until those features are production-backed.

Do not request microphone permission in production unless voice input is actually implemented and privacy copy/config are updated.

### Home Page

Reference:

```text
qa/mockups/account-home-v1/home-page-v1.png
```

Purpose:

New Home dashboard / routing hub.

Key elements:

* K Scan logo
* Profile/avatar access
* Hero card with "Scan it. Find it. Love it."
* Primary Start Scan CTA
* Recent scans carousel
* Style picks section
* Feature explanation row
* Bottom navigation: Home, Scan, StyleChat, Closet, Profile

Frontend implication:

Home should become a polished control center and routing hub. It should not become a fake commerce feed.

Important restriction:

Do not add fake prices, fake retailer partnerships, fake inventory, fake match percentages, or fake personalized recommendations unless clearly marked as static mockup/demo-only and blocked from production.

## 5. Required Frontend Build Direction

The next frontend build should use these mockups to guide:

* First-run landing flow
* Account setup/sign-in surface
* Permission education screen
* Home V2 / dashboard direction
* Bottom navigation exploration
* Bright luxury-tech design system refinement

The frontend implementation should remain feature-flagged where appropriate.

Recommended future branch:

```text
feature/account-home-ux-v1
```

Recommended feature flags if needed:

```text
ACCOUNT_SETUP_V2_ENABLED
HOME_LUXURY_TECH_V2_ENABLED
PERMISSIONS_ONBOARDING_V1_ENABLED
BOTTOM_NAV_EXPERIMENT_ENABLED
```

Do not enable backend-dependent features by default.

## 6. Explicit Non-Goals

This QA task does not implement:

* Auth provider logic
* Apple login
* Google login
* Supabase auth changes
* Backend legal acceptance persistence
* Permission request code
* Push notifications
* Microphone/voice input
* Scan backend changes
* Product recommendation backend
* Retailer integrations
* Checkout
* Real inventory
* Real prices
* Real match percentages

## 7. Implementation Risks

Risks to manage in the next frontend build:

1. Fake commerce risk
   The Home mockup includes style picks, prices, and match percentages. These must not be represented as real live commerce unless backend/product data is verified.

2. App Store compliance risk
   If third-party login is available on iOS, Sign in with Apple must remain available.

3. Permission timing risk
   Permission education should not request optional permissions before functionality exists.

4. Privacy copy risk
   Privacy promises must match actual backend behavior. Do not overstate on-device masking until implemented.

5. Navigation risk
   Bottom navigation should not be added unless it is intentionally approved for the app architecture.

6. Design drift risk
   The background should be brighter and more luminous than the previous tan/cream direction.

## 8. Recommended Next Step

After this QA mockup baseline is committed, start a separate frontend implementation branch:

```text
feature/account-home-ux-v1
```

The next implementation prompt should build these screens in a frontend-only pass, with backend wiring deferred unless explicitly approved.
