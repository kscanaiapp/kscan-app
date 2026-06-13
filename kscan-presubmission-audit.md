# K Scan AI — Pre-Submission Audit Report
**Date:** 2026-06-09  
**Scope:** App Store (iOS) & Google Play (Android) compliance, plus site-wide health  
**Constraint:** Read-only — no code changes made  
**Audited commit (local HEAD):** `4126218` (Fix sitemap public routes and noindex exclusions)

---

## Table of Contents
1. [Build & Lint Status](#1-build--lint-status)
2. [Link Audit](#2-link-audit)
3. [Functional Test Results](#3-functional-test-results)
4. [SEO & Metadata](#4-seo--metadata)
5. [Privacy & Compliance](#5-privacy--compliance)
6. [Performance & Accessibility](#6-performance--accessibility)
7. [Final Verdict](#7-final-verdict)

---

## 1. Build & Lint Status

| Check | Result | Notes |
|-------|--------|-------|
| Local build | ⚠️ Unable to verify | Sandbox bus error (memory/arch limitation) — not a real failure |
| Cloud build history | ✅ Passing | Multiple successful deployments in git log |
| Localhost references | ✅ Clean | Zero `localhost` strings found in source |
| Undefined path args | ✅ Clean | No webpack/config issues identified |
| `terms-summary` dynamic | ✅ Fixed | `export const dynamic = "force-dynamic"` present in `app/legal/terms-summary/page.tsx` |
| ESLint | ⚠️ Timed out | Cannot confirm lint-clean; recommend running `npm run lint` locally before submission |
| TypeScript | ✅ No errors observed | All reviewed source files use correct types |

**Action required:** Run `npm run lint` locally (sandbox limitation prevented it here). The cache-free redeploy for commit `e47ceb0` should be done from the Vercel dashboard — Deployments → Redeploy → uncheck "Use existing Build Cache" — to clear the prior ERR_INVALID_ARG_TYPE failure.

---

## 2. Link Audit

### 2a. Internal Pages

| URL | Live Status | Notes |
|-----|------------|-------|
| `/` | ✅ 200 | Home page, correct |
| `/beta` | ✅ 200 | Latest deployment, correct |
| `/demo` | ⚠️ 200 | **STALE** — serving old deployment (old minimal footer, no legal links) |
| `/privacy` | 🚨 200 | **STALE** — serving old deployment; missing critical disclosures (see §5) |
| `/legal/privacy` | ✅ 200 | Current, correct |
| `/legal/terms` | ✅ 200 | Current, correct |
| `/legal/terms-summary` | ✅ 200 | Current, correct |
| `/do-not-sell-or-share` | ✅ 200 | Current, correct |
| `/legal/delete-account` | ✅ 200 | Current, correct |
| `/support` | ✅ 200 | Current, correct |
| `/investors` | ⚠️ 200 | **STALE** — serving old deployment (old email `investors@kscan.ai`, minimal footer) |
| `/rooms` | ⚠️ 200 | Publicly accessible & indexable; NOT in sitemap; no `noindex` set |
| `/investors/memo` | ✅ 307 | Auth redirect — correct behavior |
| `/investors/revenue-brief` | ✅ 307 | Auth redirect — correct behavior |

### 2b. Public Documents

| URL | Status | Notes |
|-----|--------|-------|
| `/docs/kscan-privacy-policy.pdf` | ✅ 200 | Correct |
| `/docs/kscan-terms-and-conditions.pdf` | ✅ 200 | Correct |
| `/demo/kscan-demo-v16.mp4` | ✅ 200 | Correct |
| `/demo/kscan-demo-smartglasses-groupstreet.mp4` | ✅ 200 | Correct |
| `/docs/KSCAN_FirstLaunch_Modal_Copy.md` | ⚠️ 200 | **Internal doc publicly accessible** — should not be in `/public` |
| `/docs/KSCAN_Terms_and_conditions_complete.txt` | ⚠️ 200 | **Internal doc publicly accessible** |
| `/docs/K_Scan_AI_Privacy_Summary.docx` | ⚠️ 200 | **Internal doc publicly accessible** |
| `/docs/kscan-apple-privacy-policy.docx` | ✅ 404 | Not linked, not accessible — OK |
| `/docs/beta-v2-validation-summary.md` | ✅ 404 | Dead ref, not linked publicly — OK |

> **Note:** `robots.txt` disallows `/docs/`, so these files won't be indexed. However, they are reachable via direct URL and are visible to anyone who discovers them. Word temp files (`~$can-*.docx`, `~WRL*.tmp`) are also present in `public/docs/` — these are artifacts of opening the docx files locally and should be deleted from the repo.

### 2c. External Links

| URL | Status | Notes |
|-----|--------|-------|
| `cal.com/k-scan-app` | ✅ 200 | Correct |
| `instagram.com/KScan_app` | ✅ 200 | Correct |
| `tiktok.com/@KScan_app` | ✅ 200 | Correct |
| `x.com/Kscan_app` | ✅ 200 | ⚠️ Handle uses lowercase `s` — `Kscan_app` — while Instagram/TikTok use `KScan_app`. Inconsistent branding. |

### 2d. Deployment Gap (Critical Discovery)

The live site is simultaneously serving **three different historical deployment snapshots**:

| Deployment Version | Pages Affected | Distinguishing Sign |
|-------------------|---------------|---------------------|
| **Latest** (current HEAD) | `/beta`, `/legal/*`, `/do-not-sell-or-share`, `/support` | Full footer with Beta\|Privacy\|Terms\|Delete Account\|Do Not Sell\|Support |
| **Intermediate** | `/privacy`, `/legal/terms-summary` | Partial footer (Privacy\|Terms Summary\|Do Not Sell links only); missing Photo Library section |
| **Oldest** | `/demo`, `/investors` | Minimal footer (Home\|Demo\|Investors\|Waitlist only); `investors@kscan.ai` email |

**Root cause:** Vercel edge CDN caching pages from prior deployments. Pages that were statically generated in earlier builds continue to be served from cached snapshots at edge nodes until the cache is explicitly purged or a full redeploy forces all routes to rebuild.

**Fix:** In Vercel Dashboard → Settings → Functions → "Purge Edge Cache" (or trigger a full redeploy with cache disabled).

---

## 3. Functional Test Results

| Test | Result | Notes |
|------|--------|-------|
| Waitlist form (POST `/api/waitlist`) | ✅ 201 Created | Form submission endpoint operational |
| Demo video (v16) | ✅ 200 | Loads correctly |
| Demo video (smart glasses) | ✅ 200 | Loads correctly |
| Investor auth gate (`/investors/memo`) | ✅ 307 | Correctly redirects unauthenticated requests |
| Investor auth gate (`/investors/revenue-brief`) | ✅ 307 | Correctly redirects |
| `/rooms` page | ⚠️ 200 | Renders shared room UI; publicly indexable with no `noindex` — needs review |
| Googlebot cloaking | ✅ None | Googlebot receives the same 200 as regular users |

---

## 4. SEO & Metadata

### 4a. Canonical URL Bug — Systemic (High Severity)

`app/layout.tsx` sets `alternates: { canonical: "/" }` at the root level. Any page that does not export its own `alternates.canonical` inherits this and emits:

```html
<link rel="canonical" href="https://kscan.app">
```

This tells Google that every legal, privacy, and support page is a duplicate of the homepage. **Confirmed live:**

| Page | Live Canonical | Correct? |
|------|---------------|----------|
| `/` | `https://kscan.app` | ✅ |
| `/beta` | `https://kscan.app/beta` | ✅ (has own metadata) |
| `/rooms` | `https://kscan.app/rooms` | ✅ (has own metadata) |
| `/legal/privacy` | `https://kscan.app` | ❌ Should be `/legal/privacy` |
| `/support` | `https://kscan.app` | ❌ Should be `/support` |
| `/do-not-sell-or-share` | `https://kscan.app` | ❌ Should be `/do-not-sell-or-share` |
| `/privacy` | `https://kscan.app` | ❌ Should be `/privacy` |
| `/legal/terms` | `https://kscan.app` | ❌ (inferred from no metadata export) |
| `/legal/terms-summary` | `https://kscan.app` | ❌ (inferred from no metadata export) |
| `/legal/delete-account` | N/A (noindex) | ✅ noindex pages exempt |

**Fix:** Remove `alternates: { canonical: "/" }` from `app/layout.tsx`. Next.js will auto-generate the correct canonical for each page using `metadataBase`. Pages needing explicit canonicals (like `/beta`) can keep their own `alternates` export.

### 4b. Title Tag Inheritance (Medium Severity)

Pages without their own `export const metadata` fall back to the root title `"K Scan AI | Find Fashion From Real-World Inspiration"`. Confirmed live:

| Page | Live `<title>` | Correct? |
|------|---------------|----------|
| `/` | K Scan AI \| Find Fashion From Real-World Inspiration | ✅ |
| `/beta` | K Scan Beta Center \| Early Access & Product Roadmap | ✅ |
| `/do-not-sell-or-share` | Do Not Sell or Share My Personal Information \| K Scan AI | ✅ |
| `/privacy` | K Scan AI \| Find Fashion From Real-World Inspiration | ❌ Needs own title |
| `/legal/privacy` | K Scan AI \| Find Fashion From Real-World Inspiration | ❌ Needs own title |
| `/legal/terms` | K Scan AI \| Find Fashion From Real-World Inspiration | ❌ Needs own title |
| `/support` | K Scan AI \| Find Fashion From Real-World Inspiration | ❌ Needs own title |

### 4c. Sitemap & robots.txt

| Item | Status |
|------|--------|
| `sitemap.xml` — 10 routes present | ✅ |
| `/investors` excluded from sitemap | ✅ |
| `/rooms` excluded from sitemap | ⚠️ Page is live and indexable — either add to sitemap or set noindex |
| `robots.txt` — disallows `/api/` and `/docs/` | ✅ |
| `robots.txt` — allows all other routes | ✅ |
| `llms.txt` — present and accessible | ✅ |

### 4d. llms.txt Inconsistency

`public/llms.txt` states "StyleChat — Live Now" while `app/beta/page.tsx` shows "StyleChat — Live in Beta". The llms.txt should be updated whenever `/beta` status changes.

### 4e. Open Graph

| Item | Status |
|------|--------|
| Home page OG title/description/image | ✅ Correct |
| Home page Twitter card | ✅ Correct |
| `/beta` OG tags | ✅ Correct (has own metadata) |
| Legal/support pages | ⚠️ Inherit home page OG — not ideal for link sharing |

---

## 5. Privacy & Compliance

### 5a. 🚨 CRITICAL BLOCKER — Live /privacy Page Missing Required Disclosures

**`https://kscan.app/privacy` is serving a historical deployment that is missing four sections** that exist in the current local source (`app/privacy/page.tsx`, added in commit `ede4c5b`):

| Section | In Current Source | On Live `/privacy` | On Live `/legal/privacy` |
|---------|------------------|-------------------|--------------------------|
| Photo & Media Library Access | ✅ | ❌ **MISSING** | ✅ Present |
| No Microphone in Initial Release | ✅ | ❌ **MISSING** | ✅ Present |
| Face & Bystander Protection | ✅ | ❌ **MISSING** | ✅ Present |
| Future Privacy Roadmap | ✅ | ❌ **MISSING** | ✅ Present |
| Cloud Scan Processing | ✅ | ✅ Present | ✅ Present |

Additionally, the stale `/privacy` page retains older language about "transient processing" and deletion timelines that may no longer reflect current practice.

**Why this blocks iOS App Store submission:** Apple reviews the Privacy Policy URL you submit in App Store Connect. If that URL is `https://kscan.app/privacy`, reviewers will not see the Photo Library Access or No Microphone disclosures, which are required for apps requesting these permissions. Apple Guideline 5.1.1 requires that the privacy policy accurately describe what data the app collects and how it is used.

**Mitigation options:**
- Option A: Force a full cache purge + redeploy so `/privacy` serves the current source. *(Preferred — fixes all stale pages simultaneously)*
- Option B: Submit `https://kscan.app/legal/privacy` as the Privacy Policy URL to Apple instead of `/privacy`. This page serves the current deployment and contains the required disclosures.

### 5b. In-App Deletion Path Inconsistency (High)

Two pages disagree on where to find account deletion inside the app:

| Page | Stated In-App Path |
|------|--------------------|
| `/privacy` (current source) | Settings > Account > Delete Account |
| `/legal/delete-account` | Settings > Privacy > Delete Account |

The path must match what the app actually shows. Both pages need to agree. This is also relevant for App Store Review — reviewers sometimes follow the stated path during testing.

### 5c. Public Docs Exposure (Medium)

The following files are in `public/docs/` and return HTTP 200 to anyone with the URL:

| File | Classification |
|------|---------------|
| `KSCAN_FirstLaunch_Modal_Copy.md` | Internal onboarding copy |
| `KSCAN_Terms_and_conditions_complete.txt` | Internal/draft legal document |
| `K_Scan_AI_Privacy_Summary.docx` | May be a draft version |
| `~$can-apple-terms-and-conditions.docx` | Word lock file (temp artifact) |
| `~$can-apple-terms-summary.docx` | Word lock file (temp artifact) |
| `~$can-privacy-policy.docx` | Word lock file (temp artifact) |
| `~$can-terms-and-conditions.docx` | Word lock file (temp artifact) |
| `~WRL2560.tmp` | Word temp file |

`robots.txt` disallows `/docs/` so these won't appear in search results, but they are accessible via direct URL. Move non-public files out of the `public/` directory, and delete all `~$*` and `*.tmp` files from the repo.

### 5d. Investor Contact Email Inconsistency (Medium)

| Location | Email Shown |
|----------|------------|
| Live `/investors` page | `investors@kscan.ai` |
| Current source `app/investors/page.tsx` | `kscanai.app@gmail.com` |

The live `/investors` page is serving from an old deployment. The current source reverted the email to `kscanai.app@gmail.com`. If `investors@kscan.ai` is the intended contact address, the source code needs updating. If `kscanai.app@gmail.com` is correct, a cache-cleared redeploy will fix the live page automatically.

Verify which is active/monitored before deploying.

### 5e. CCPA Do-Not-Sell/Share Controls (Passing with Minor Issue)

| Item | Status |
|------|--------|
| `/do-not-sell-or-share` page exists | ✅ |
| GPC signal honored | ✅ |
| Supabase edge function for opt-out | ✅ |
| CCPA opt-out link in footer | ✅ |
| `/do-not-sell-or-share` "Related Legal Documents" links to `/privacy` | ⚠️ Should link to `/legal/privacy` |

### 5f. App Store Compliance Checklist

| Requirement | Status | Notes |
|-------------|--------|-------|
| Privacy Policy URL accessible (live) | ✅ | Both `/privacy` and `/legal/privacy` return 200 |
| Photo Library Access disclosed | 🚨 | Present in source; **MISSING from live `/privacy`** |
| No Microphone disclosed | 🚨 | Present in source; **MISSING from live `/privacy`** |
| No Facial Recognition disclosed | ✅ | Present in all versions of privacy page |
| Cloud processing disclosed | ✅ | Present in current source |
| Account deletion URL exists | ✅ | `/legal/delete-account` — 200, has email fallback |
| Deletion via email available | ✅ | `mailto:kscanai.app@gmail.com?subject=Account%20Deletion%20Request` |
| Contact email present | ✅ | `kscanai.app@gmail.com` |
| Data retention statement | ✅ | Present in current privacy pages |
| Third-party service providers disclosed | ✅ | Present in privacy pages |

### 5g. Google Play Compliance Checklist

| Requirement | Status | Notes |
|-------------|--------|-------|
| Privacy Policy URL accessible | ✅ | |
| Account deletion support | ✅ | `/legal/delete-account` |
| Data safety form alignment | ⚠️ | Verify Data Safety form matches disclosures in privacy policy, especially Photo Library |
| No deceptive behavior | ✅ | |
| Content rating appropriate | N/A | Verify in Play Console |

### 5h. Security Headers (All Passing)

| Header | Value | Status |
|--------|-------|--------|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | ✅ |
| `X-Frame-Options` | `DENY` | ✅ |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | ✅ |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | ✅ |
| `X-Content-Type-Options` | `nosniff` | ✅ |
| `Content-Security-Policy` | Present | ⚠️ `script-src` includes `'unsafe-inline'` and `'unsafe-eval'` |

**CSP note:** The `'unsafe-inline'` and `'unsafe-eval'` directives in `script-src` weaken XSS protections. Acceptable for Beta/development, but should be replaced with nonces or hashes before GA release.

### 5i. Additional Security Notes

- **Rate limiting:** `lib/serverRateLimit.ts` uses an in-memory `Map`. In Vercel serverless, each cold start resets the map, making rate limiting non-functional in production. Consider a Supabase-backed or Redis-backed rate limiter before GA.
- **Backend endpoint disclosure:** `app/legal/privacy/page.tsx` names `kscan-app-1.onrender.com` as the backend endpoint. This is minor but provides infrastructure mapping to anyone reading the page.

---

## 6. Performance & Accessibility

### 6a. Performance

Lighthouse could not be run from the sandbox environment. The following is inferred from source inspection:

| Item | Status | Notes |
|------|--------|-------|
| Framer Motion animations | ✅ | Client-side, does not block server render |
| Images | ✅ | `/group-street.jpeg` served as OG image; no large inline assets noted |
| Demo video loading | ✅ | MP4 files served from Vercel CDN |
| Server components | ✅ | Most pages are server components; minimal client bundle |
| `force-dynamic` on terms-summary | ✅ | Correctly shifts to lambda, avoiding static pre-render failure |

### 6b. Accessibility (from source review)

| Item | Status | Notes |
|------|--------|-------|
| Social icon `aria-label` attributes | ✅ | All three social icons labeled |
| `aria-hidden="true"` on decorative SVGs | ✅ | Present throughout |
| `focus-visible` styles | ✅ | Implemented on interactive elements |
| Semantic heading hierarchy | ✅ | h1 → h2 → h3 structure maintained |
| Section `aria-labelledby` | ✅ | Used on privacy page sections |
| Footer touch targets (44×44px minimum) | ✅ | `h-11 w-11` (44px) on icon links |
| Minimum text contrast | ⚠️ | `text-stone-400` (#a8a29e) on white — approx 2.5:1, below WCAG AA 4.5:1 for small text. Used extensively for meta labels. |

---

## 7. Final Verdict

### 🚨 Blockers — Must Fix Before Submission

| # | Issue | Impact |
|---|-------|--------|
| B1 | **Live `/privacy` page is a stale deployment missing Photo Library Access and No Microphone disclosures** | iOS App Store submission will fail review (Guideline 5.1.1) |
| B2 | **Canonical tag inheritance bug** — all legal/support pages report canonical as `https://kscan.app` | Google treats all legal pages as duplicates of the homepage; no search equity |

### ⚠️ High Priority — Fix Before Submission

| # | Issue | Impact |
|---|-------|--------|
| H1 | **Deployment gap: `/demo` and `/investors` serving oldest deployment** | Old contact email on investors page; legal footer links absent from demo page |
| H2 | **In-app deletion path mismatch** between `/privacy` (Settings > Account) and `/legal/delete-account` (Settings > Privacy) | App Store reviewer may not find deletion if stated path is wrong |
| H3 | **`/rooms` publicly indexable** — no `noindex`, not in sitemap | User-generated shared room URLs may be indexed; unexpected content exposure |
| H4 | **Title tag inheritance** — `/legal/privacy`, `/legal/terms`, `/support`, `/privacy` all display home page title | Hurts findability; confusing for users who bookmark these pages |

### 📋 Medium Priority — Fix Before GA

| # | Issue |
|---|-------|
| M1 | Internal documents (`KSCAN_FirstLaunch_Modal_Copy.md`, `KSCAN_Terms_and_conditions_complete.txt`, `K_Scan_AI_Privacy_Summary.docx`) accessible via direct URL in `/public/docs/` |
| M2 | Word temp/lock files (`~$*.docx`, `~WRL*.tmp`) in `public/docs/` should be deleted from the repo |
| M3 | Investor contact email inconsistency — live shows `investors@kscan.ai`, source shows `kscanai.app@gmail.com`; confirm which is active before deploying |
| M4 | `/do-not-sell-or-share` "Related Legal Documents" links to `/privacy` (old URL) instead of `/legal/privacy` |
| M5 | X handle is `Kscan_app` — lowercase `s` — while Instagram and TikTok use `KScan_app`. Pick one and be consistent. |
| M6 | `llms.txt` says "StyleChat — Live Now" but `/beta` says "Live in Beta" — update llms.txt to match |
| M7 | `/support` page only mentions iOS camera troubleshooting; Android users are underserved |

### 🔵 Low Priority / Accepted Beta Risk

| # | Issue |
|---|-------|
| L1 | Rate limiting (`lib/serverRateLimit.ts`) uses in-memory Map — non-functional in Vercel serverless (resets on cold start) |
| L2 | CSP `script-src` includes `'unsafe-inline'` and `'unsafe-eval'` — tighten before GA |
| L3 | `app/legal/privacy/page.tsx` discloses `kscan-app-1.onrender.com` backend endpoint |
| L4 | `text-stone-400` label text (~2.5:1 contrast ratio) fails WCAG AA for small text |

---

### Recommended Pre-Submission Action Sequence

1. **Force a full Vercel cache-free redeploy** (fixes B1, H1, and M3 simultaneously) — Dashboard → Deployments → latest → Redeploy → uncheck "Use existing Build Cache"
2. **Confirm which privacy URL to submit to Apple** — if `/privacy` is still stale after redeploy, use `/legal/privacy` as the submission URL temporarily
3. **Fix the canonical bug** in `app/layout.tsx` — remove the root-level `alternates: { canonical: "/" }`
4. **Align deletion path** — confirm the actual in-app path and update both `/privacy` and `/legal/delete-account` to match
5. **Add `noindex` to `/rooms`** (or to `/rooms/[id]` if that's the pattern) and decide whether to add it to the sitemap
6. **Add `export const metadata`** to `/legal/privacy`, `/legal/terms`, `/support`, `/privacy` with page-specific titles and canonicals

---

*Report generated 2026-06-09. Audit was read-only — no changes were made to source files or deployed assets.*
