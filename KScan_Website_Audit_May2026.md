# K Scan AI — Full Website Audit
**Prepared:** May 18, 2026  
**Scope:** Live site at https://www.kscan.app + source files at `kscan-website/`  
**Audit team roles:** Brand Strategy · UX/Conversion · Copy · Next.js Code · Accessibility/Responsive · SEO · Performance · Security · Legal/Compliance · Investor Risk

---

## 1. Executive Summary

**Overall verdict: Ready to launch after targeted fixes — but two issues should be resolved before any public announcement.**

K Scan AI has a genuinely impressive site for an early-stage consumer product. The visual identity is premium and intentional. The brand voice is confident without being overclaiming. The technical architecture is well-structured, and the security approach for investor materials is thoughtful. Most importantly, the product story is clear within ten seconds: see something, scan it, buy it.

**What is working best:**
- Hero copy ("See it. Say it. Get it.") is memorable and punchy
- Visual design is polished, editorial, and category-appropriate
- The investor page presents a coherent, honest thesis with appropriate caveats
- API routes use Zod schema validation, honeypot bot defense, and HMAC-based session tokens
- Privacy, terms, and Do Not Sell pages are present and linked
- Structured data (Schema.org Organization, WebSite, FAQ, SoftwareApplication) is well-implemented
- Benchmark stat disclosure ("Internal benchmark across 50,000 test outfit images. Independent audit pending.") is credibly honest

**What is most concerning:**
1. **`public/docs/` exposes internal working files** that should never be publicly accessible: Word lock files (`~$can-privacy-policy.docx`, `~$can-terms-and-conditions.docx`), a Word recovery file (`~WRL2560.tmp`), an internal first-launch copy document (`KSCAN_FirstLaunch_Modal_Copy.md`), and a beta validation summary (`beta-v2-validation-summary.md`). These are live at `https://kscan.app/docs/[filename]`.
2. **In-memory rate limiting will not survive serverless cold starts** on Vercel. The investor login brute-force protection is effectively disabled in production.
3. **"NEURAL MATCH ACCURACY" appears with no value** in the homepage ticker — it reads as broken copy.
4. **The investor contact email (`kscanai.app@gmail.com`) is inconsistent** with the investor page's listed address (`investors@kscan.ai`), and using Gmail for investor outreach is a credibility problem.
5. **Leadership section has zero content** — no name, title, photo, or bio.

**Launch verdict:** Ready to launch after the public/docs cleanup and the copy fixes. The in-memory rate limit and email issues are important but not launch-blocking for a soft announcement.

---

## 2. Scorecard

| Dimension | Score | Notes |
|---|---|---|
| Brand clarity | 8/10 | Fashion-specific, premium, retailer-neutral — clear |
| Premium visual feel | 9/10 | Editorial, intentional, category-appropriate |
| Product explanation | 8/10 | Clear within 10s; demo reinforces it |
| Fashion specificity | 9/10 | Consistently fashion-first throughout |
| Privacy-first credibility | 7/10 | Claims edge-first but no deeper detail; Gmail email hurts |
| Retailer-neutral positioning | 9/10 | Consistently stated and well-framed |
| Waitlist conversion strength | 7/10 | Form is clean; success state is good; needs more urgency cues |
| Investor credibility | 6/10 | Thesis is honest; Gmail contact, zero leadership info, and email mismatch reduce trust |
| Mobile responsiveness | 8/10 | Generally solid; mobile nav is horizontal scroll tray, no hamburger |
| Accessibility | 6/10 | Basics present; aria-labels on interactive elements OK; color contrast on some overlay text needs checking |
| SEO readiness | 7/10 | Good structured data; secondary pages missing page-specific meta; no Twitter handle |
| Performance readiness | 7/10 | Images optimized via Next.js; large source PNGs; framer-motion bundle cost |
| Security posture | 6/10 | Good HMAC auth; CSP present; rate limit broken serverless; public/docs exposure |
| Legal/policy alignment | 7/10 | Policies present; Gmail contact and leadership section inconsistencies |

---

## 3. Page-by-Page Findings

### Homepage (`/`)

**What works:**
- Hero headline "See it. Say it. Get it." is clean, fast, and catchy
- Sub-headline "The fashion you spot in real life — shoppable in seconds" immediately frames the value prop
- The animated phone mockup and overlay labels (Active Vision, Structured blazer, Leather bag) convey the product in motion without a full video load
- The three-step flow (Capture → Identify → Shop) is clear and scannable
- The FAQ section uses proper schema markup and addresses real pre-purchase objections
- Waitlist form has honeypot bot defense, success/duplicate/error states, and privacy microcopy

**What doesn't work:**
- **"NEURAL MATCH ACCURACY" in the ticker has no value** — it shows only the label with no number. Looks broken. Either supply a value (e.g., "94%") or remove the metric.
- **Duplicate paragraph in "The Fashion Intelligence Engine" section** — the paragraph beginning "K Scan is designed to understand how fashion works together" appears twice within three paragraphs of each other (lines ~989 and ~993 in page.tsx). One version should be removed.
- **"Say it" in the hero headline is confusing** — the product is scan/visual. "Say" implies voice interaction. The tagline is memorable, but this deserves a revisit.
- **Style DNA section ("Your Style DNA")** is a static mockup with hardcoded values and no explanation that it's a feature preview. A one-line "Coming soon" or "Preview" label would prevent user confusion.
- **Stats ticker says "10+ INTEGRATED RETAILERS"** but the benchmarks section says "200+ Retailers Indexed." These should be consistent.
- **Investor bottom sheet on mobile** opens `/investors` in a new tab (`target="_blank"`) but the email link does not have `rel="noopener noreferrer"` — the button `motion.a` at line 399 does have it, but the full page nav flow should be verified.

**Recommendations:**
1. Fix the "NEURAL MATCH ACCURACY" metric immediately — add a value or remove it
2. Remove the duplicate paragraph in the Fashion Intelligence Engine section
3. Standardize the retailer count across the page (10+ vs 200+)
4. Add a "Feature preview" or "Coming soon" label to the Style DNA section

---

### Demo Page (`/demo`)

**What works:**
- The hero copy ("Mobile now. Wearables next.") is strong and honest about product stage
- Two distinct demo contexts (mobile and wearables) give investors a clear product timeline
- The "Continue from the demo" section cleanly converts to either waitlist or investor
- The Suspense fallback with skeleton loading is well-implemented
- Page-specific metadata (title, OG, Twitter) is properly set via `demoMetadata`

**What doesn't work:**
- **"Copy Link to Demo" copies direct MP4 URLs** (e.g., `/demo/kscan-demo-v16.mp4`) — these are public, downloadable video files. Anyone with the link can download the demo videos. If these are proprietary, they need protection; if not, the behavior is fine but should be intentional.
- **The demo videos are anchor `<href>` links** — not video embeds. Clicking them navigates to the raw MP4 file. The "MOBILE PRODUCT · PURCHASE PATHS LIVE" label implies they should be playable inline.
- **"Next" section label appears twice** for the two demo blocks — this appears to be a section label, not interactive navigation. It's mildly confusing on first read.
- The demo page footer nav shows Home/Demo/Investors/Waitlist — inconsistent with the full footer on other pages (which includes Privacy/Terms/Social links).

**Recommendations:**
1. Either embed the videos inline or protect them from direct download if proprietary
2. Confirm the demo video links are intentional anchor hrefs vs. video players
3. Standardize the footer across pages

---

### Investor Page (`/investors`)

**What works:**
- The thesis is coherent, honest, and appropriately hedged ("being built," "in validation")
- Section numbering (01–12) gives the page a document-like authority
- The password gate for the deck is properly implemented (HMAC session cookie, rate limiting, server-side validation)
- Both a standard deck and a mobile deck version are served through the same authenticated API
- Investor inquiry form collects name, email, firm, and message with server-side Zod validation
- The "Early stage" tag on the hero image accurately sets expectations

**What doesn't work:**
- **Leadership section (Section 11) has no actual content** — no name, no title, no photo, no bio. This is the single most credibility-damaging gap for an investor audience. Investors need to know who they are backing.
- **"Schedule a Conversation" button scrolls to the inquiry form** — it does not open a calendar or scheduling tool. This is misleading. Rename it "Submit an Inquiry" or wire up an actual calendar link (Calendly, Cal.com, etc.).
- **"Request Investor Materials" and "Schedule a Conversation" are two separate-looking CTAs that do exactly the same thing** (both call `scrollToAccess()`).
- **No market size figures** — the market opportunity section (07) argues the thesis but provides no TAM/SAM/SOM or third-party citation. This is standard for early stage but investors will ask. Even a rough cited figure would help.
- **The entire investor thesis is publicly visible without authentication** — only the PDF deck itself is gated. This is a design choice, but it means all strategic positioning, moat description, and roadmap are fully indexed by search engines if the page is ever indexed. Currently `/investors` is not in the sitemap, which helps, but robots.txt allows all paths with `/`, so it could still be crawled.
- **Email inconsistency** — the investor inquiry route auto-replies from `kscanai.app@gmail.com`, but the investor page body displays `investors@kscan.ai`. These must match.

**Recommendations:**
1. Add a leadership section with at minimum a name, title, and 2-sentence bio
2. Rename "Schedule a Conversation" or wire up a real calendar link
3. Resolve the `investors@kscan.ai` vs `kscanai.app@gmail.com` discrepancy
4. Consider adding robots disallow for `/investors` if full public indexing is undesirable

---

### Privacy Page (`/privacy`)

**What works:**
- The privacy summary is readable and clearly written
- It distinguishes between scan data (not sold) and non-sensitive commercial data (may be used)
- Links to full PDF policy and Do Not Sell page are present
- The distinction between raw visual data and inferred data is appropriately handled

**What doesn't work:**
- **Contact email is `kscanai.app@gmail.com`** — for a privacy contact, this significantly reduces trust. A domain-matched email (e.g., `privacy@kscan.ai`) should replace this.
- **The page uses the global metadata** (title, OG description, canonical) rather than privacy-specific metadata. The page title shows "K Scan AI | AI Fashion Search From Photos & Screenshots" instead of something like "Privacy Policy | K Scan AI."
- **The canonical tag on this page points to `https://kscan.app`** (root) not `https://kscan.app/privacy` — this is a metadata inheritance issue and tells search engines to treat the privacy page as a duplicate of the homepage.

**Recommendations:**
1. Set page-specific metadata (title, description, canonical) for the privacy page
2. Replace `kscanai.app@gmail.com` with a domain-matched privacy contact email

---

### Terms Summary Page (`/legal/terms-summary`)

**What works:**
- The terms summary is appropriately concise and readable for users
- Key limits (AI outputs not guarantees, third-party retailer disclaimers) are clearly stated
- Links to the full PDF terms are present

**What doesn't work:**
- **Same global metadata issue** as the privacy page — title and canonical are incorrect for this page
- **The copyright line ("© 2026 K SCAN AI. All rights reserved.") appears twice** — once in the page content and once in the SiteFooter component
- **Full Terms and Conditions are linked from `/docs/kscan-terms-and-conditions.pdf`** — this is the robots.txt-disallowed `/docs/` path, which is fine for SEO but means the file is still directly accessible via URL

---

### Do Not Sell or Share Page (`/do-not-sell-or-share`)

**What works:**
- The page correctly implements CCPA opt-out capability
- GPC signal support is disclosed
- Data deletion is addressed (via email)
- The opt-out toggle for sale/sharing appears functional

**What doesn't work:**
- **"Limit sensitive personal information processing" redirects to email** — this is acceptable but should be noted in any legal review
- Same global metadata issue (canonical points to root)
- Contact is `kscanai.app@gmail.com` — same credibility concern

---

### Footer (Sitewide)

**What works:**
- Privacy, Terms Summary, and Do Not Sell links are all present
- Social links to Instagram, TikTok, and X are present

**What doesn't work:**
- **Social links use raw `https://` anchors** rather than Next.js `<Link>` — these need `target="_blank" rel="noopener noreferrer"` attributes. Currently they appear to be rendered without `rel` attributes, which is a minor security issue (reverse tabnapping on external opens).
- **No `rel="noopener noreferrer"` on social links** in the footer
- **The footer is minimal** — no contact email, no address, no About link. For investors who reach the footer, there's nothing to anchor trust.
- **"K Scan AI" brand name** uses inconsistent spacing in the footer logo ("K ScanAI" appears as a two-part text span rather than a spaced logo) — verify this renders correctly.

---

### 404 / Error Page

No custom 404 page was found. Next.js will serve its default 404. A custom `not-found.tsx` page with branded styling and a link back to the homepage would be standard for a launch-ready product.

---

## 4. Link / Navigation / CTA Findings

| Location | Issue | Severity |
|---|---|---|
| Footer social links | Missing `target="_blank" rel="noopener noreferrer"` | Medium |
| Investor page "Schedule a Conversation" | Scrolls to form instead of scheduling | Medium |
| Investor page "Request Investor Materials" + "Schedule" | Both CTAs do identical action | Low |
| Demo page video links | `<a href="/demo/...mp4">` — navigates to raw MP4 instead of playing | Medium |
| Investor page `investors@kscan.ai` | Does not match actual delivery email `kscanai.app@gmail.com` | High |
| Privacy/Terms/Do-not-sell | Canonical tag incorrectly points to root `/` on all secondary pages | High (SEO) |
| Investor inquiry auto-reply | Sends from `kscanai.app@gmail.com` not `investors@kscan.ai` | High |
| `/investors` page | Not in sitemap — intentional but should be confirmed decision | Low |

**Links verified as working:**
- Homepage CTA → #waitlist ✓
- "Get Early Access" → #waitlist ✓
- "See the scan flow" → #how-it-works ✓
- Nav: Demo → /demo ✓
- Nav: Investors → /investors ✓
- Footer: Privacy → /privacy ✓
- Footer: Terms Summary → /legal/terms-summary ✓
- Footer: Do Not Sell → /do-not-sell-or-share ✓
- Privacy page: Full Policy PDF → /docs/kscan-privacy-policy.pdf ✓ (confirmed accessible)
- Terms: Full Terms PDF → /docs/kscan-terms-and-conditions.pdf ✓

---

## 5. Interactive Element and Toggle Findings

| Element | Status | Notes |
|---|---|---|
| Waitlist form submission | ✓ Works | honeypot, success/duplicate/error states |
| Investor password form | ✓ Works | HMAC cookie, shake animation on error |
| Password Show/Hide toggle | ✓ Works | `aria-pressed` is set correctly |
| Investor inquiry form | ✓ Works | Loading/success/error states present |
| Investor bottom sheet (mobile) | ✓ Works | AnimatePresence, backdrop, close button, body scroll lock |
| Mobile nav horizontal scroll | Functional | No hamburger menu — UX friction on small screens |
| FAQ accordion | Not implemented | FAQs render as static Q&A pairs, not expandable. Fine for current length but becomes a problem if more are added |
| "Copy Link to Demo" | Functional | Copies raw MP4 URL to clipboard; intentionality should be confirmed |
| Investor deck check (HEAD) | ✓ Works | Checks deck availability after auth before showing button |
| Reduced motion support | ✓ Correct | `useReducedMotion()` is implemented throughout framer-motion usage |

**Accessibility notes:**
- `aria-hidden="true"` is correctly applied to decorative elements throughout
- `role="dialog"`, `aria-modal="true"`, and `aria-label` are set on the investor bottom sheet
- Password input has `aria-label="Investor password"` ✓
- Step numbers in "How It Works" use `aria-hidden` with `sr-only` text alternatives ✓
- Interactive list items use `key` props from unique data (not indexes) ✓
- The FAQ does not use `<details>`/`<summary>` or ARIA expand pattern — static display is fine for current content length

---

## 6. Copy and Positioning Review

### Copy that is strong and should remain:
- **"See it. Say it. Get it."** — Punchy, memorable, fast to parse
- **"The fashion you spot in real life — shoppable in seconds"** — Immediately clear
- **"No more 'I'll find it later.' K Scan closes the gap between inspiration and action in seconds."** — Honest, specific, emotionally resonant
- **"K Scan is not trying to solve visual search broadly."** — Investor page; honest scope-setting
- **"User utility first. Platform leverage second."** — Clean, credible sequencing
- **"Built from style signals, not identity."** — Strong privacy-first signal
- **"Internal benchmark across 50,000 test outfit images. Independent audit pending."** — Exactly right. Credible disclosure.
- **"Private beta — 2026"** — Sets expectation correctly
- **"K Scan is a visual fashion discovery layer."** — FAQ answer; precise and honest

### Copy that feels generic or should be tightened:
- **"A commerce layer for fashion, not another browse-and-search workflow."** — Strong positioning, but "browse-and-search workflow" is jargon. Consider: "Not another search box. A discovery layer built for fashion's real moments."
- **"Fashion discovery increasingly starts outside traditional ecommerce search"** — True but familiar. Could be sharper.
- **"K Scan reads fashion-specific signals such as silhouette, material, color, layering, and styling context"** — Repeated with minor variations at least four times across the homepage. Consolidate.
- **"The product is being built" / "K Scan is being built"** — Appears multiple times on the investor page. Appropriate hedging, but when stacked, it slightly undermines confidence. A mix of past ("We built X"), present ("We're validating Y"), and future ("Next: Z") tense would read more dynamically.

### Copy that is vague or potentially misleading:
- **"NEURAL MATCH ACCURACY"** (homepage ticker) — No value shown. This is factually incomplete and visually broken.
- **"10+ INTEGRATED RETAILERS"** (ticker) vs **"200+ Retailers Indexed"** (benchmark section) — Inconsistent and unexplained. Clarify the distinction or use one number.
- **"< 0.4s Lock Time"** and **"AVG SCAN TIME: 1.4S"** — These appear to be internal benchmark figures. They're disclosed as such in the fine print, but the ticker shows them without any qualifier. The disclaimer applies to the detailed stats section, not the ticker.
- **"Style Memory: Saved scans and purchases build a sharper profile"** — Implies the app is live and users are scanning. Clearly a feature description, but the present tense creates minor confusion on a pre-launch product. Add "will" or "is designed to."

### Copy that weakens credibility:
- **"See it. Say it. Get it."** — "Say it" is the weak link. Nothing in the product description involves saying anything. If this is a future voice/wearable use case, acknowledge that; otherwise, the mismatch will confuse users.
- **Leadership section** — Blank. No copy, no names. This is not a copy problem; it's a content gap.

### Missing proof points and trust cues:
- No social proof (no waitlist count, no press mention, no pilot partner logos even redacted)
- No founder or team credibility signal anywhere on the public site
- No "as seen in" or advisor names

---

## 7. Source Code Review

### Bugs

**Bug 1 — Duplicate paragraph in homepage (verified)**  
`app/page.tsx`, lines ~989–993. Two consecutive paragraphs beginning "K Scan is designed to understand how fashion works together" appear in the "Fashion Intelligence Engine" section. One is slightly longer than the other. This is a copy paste artifact.

**Bug 2 — NEURAL MATCH ACCURACY has no value (verified)**  
`app/page.tsx`, line ~736: `<span>NEURAL MATCH ACCURACY</span>` renders with no numeric value beside it. The other two metrics ("AVG SCAN TIME: 1.4S" and "10+ INTEGRATED RETAILERS") include their values inline. This metric was likely stripped of its value in editing.

**Bug 3 — Canonical metadata inheritance on secondary pages (verified)**  
`app/layout.tsx` sets `alternates: { canonical: "/" }` as the base metadata. Secondary pages (`/privacy`, `/legal/terms-summary`, `/do-not-sell-or-share`, `/investors`) do not override the canonical. All four pages therefore emit `<link rel="canonical" href="https://kscan.app/">` — pointing search engines to the homepage. Only `/demo` correctly sets its own canonical via `demoMetadata`.

### Code Quality Concerns

**Concern 1 — In-memory rate limiting is unreliable in serverless (High)**  
`lib/serverRateLimit.ts` uses a module-level `Map<string, RateLimitEntry>` as its store. In Vercel's serverless architecture, each function invocation may spin up a fresh process, clearing the map. The rate limit on investor login (5 attempts/hour) effectively provides no protection against brute-force attempts from different Lambda instances. This means an attacker could cycle through passwords rapidly across concurrent requests.

**Fix:** Replace with Redis-backed rate limiting (Vercel KV, Upstash, or a Supabase RPC counter with TTL). A simple Supabase RPC that increments a counter and checks TTL would cost no additional infrastructure.

**Concern 2 — Homepage and Investors page are fully "use client" (Medium)**  
Both `app/page.tsx` and `app/investors/page.tsx` use `"use client"` at the top level. This is correct because they use hooks (useState, useEffect, framer-motion). However, it means the entire framer-motion library plus all interactive logic ships to the client for every visitor. The impact is partially mitigated by Next.js's static prerender, but the hydration bundle is large.

**Recommendation:** Extract the purely static sections (How It Works, Features, FAQ content) into Server Components and keep only interactive islands (waitlist form, investor sheet, password gate) as Client Components.

**Concern 3 — Supabase client re-created on every request (Low)**  
`app/api/waitlist/route.ts` and `app/api/investor-inquiry/route.ts` call `createClient(...)` inside the `POST` handler on each request, rather than caching a singleton. In serverless this is less critical (process recycling is frequent), but it adds per-request overhead. Consider moving the client creation to module scope (outside the handler) with a null-safety guard.

**Concern 4 — Investor cookie is not user-specific (Informational)**  
`lib/investorAccess.ts` creates a cookie value that is identical for all sessions using the same password: `HMAC(password, "kscan-investor-access-v1")`. There is no session-per-user randomness. This is a simplified design that works for a shared password model, but it means:
- All authenticated investors share the same cookie value
- You cannot invalidate a specific user's session without changing the password for everyone
- The cookie value, if leaked from one device, works on any other device indefinitely until the password rotates

This is acceptable for an early-stage product with a shared investor password, but should be noted.

**Concern 5 — `prepareMobileDeckHtml` uses string replacement on HTML (Low)**  
`app/api/investor/deck-mobile/route.ts` post-processes the mobile deck HTML by replacing known PDF paths with the API route. This is fragile — if path formats change, the replacement silently fails. Consider a more robust approach (a known placeholder string in the HTML template rather than a production path).

**Concern 6 — CSP weakened by `'unsafe-inline'` and `'unsafe-eval'` (Medium)**  
`next.config.ts` sets a CSP header with `script-src 'self' 'unsafe-inline' 'unsafe-eval'`. These are required by Next.js's runtime and framer-motion, but they negate most of the XSS protection the CSP is intended to provide. Consider nonce-based CSP (Next.js supports this) or hash-based CSP for script whitelisting as a post-launch improvement.

**Concern 7 — Missing security headers (Medium)**  
The CSP header is applied globally but several standard security headers are absent from `next.config.ts`:
- `X-Content-Type-Options: nosniff` — prevents MIME-type sniffing
- `X-Frame-Options: DENY` — redundant with `frame-ancestors 'none'` in CSP but adds defense-in-depth
- `Referrer-Policy: strict-origin-when-cross-origin` — controls referrer exposure
- `Permissions-Policy` — restricts browser feature access (camera, microphone, etc.)
- `Strict-Transport-Security` — Vercel adds this, but it should be explicit in the config

**Concern 8 — No custom 404 page (Low)**  
No `app/not-found.tsx` file is present. Next.js will serve its generic 404, which breaks the site's visual polish and misses a conversion opportunity.

### Maintainability Concerns

- Fashion signal copy ("silhouette, material, layering, and styling context") is repeated verbatim in at least six places across the codebase (page.tsx, investors/page.tsx, layout.tsx, API route email body). Centralizing this into a shared constants file would prevent drift.
- The `trustMetrics` and `benchmarkStats` arrays in `page.tsx` are hardcoded. A single source of truth in a `constants/metrics.ts` file would prevent the 10+ vs 200+ retailer inconsistency.
- The investor inquiry auto-reply message (`INVESTOR_REPLY_BODY`) in `route.ts` contains `kscanai.app@gmail.com` hardcoded — not pulled from an environment variable, so it will need a code change if the email address changes.

---

## 8. SEO Review

### What's good:
- Global metadata (title, description, keywords, OG, Twitter) is well-formed in `app/layout.tsx`
- Demo page has page-specific metadata via `demoMetadata` (title, description, canonical, OG, Twitter) ✓
- Sitemap is generated dynamically at `/sitemap.xml` with correct routes and priorities
- robots.txt disallows `/api/` and `/docs/` correctly
- Schema.org structured data is implemented for Organization, WebSite, FAQPage, and SoftwareApplication
- Heading hierarchy on homepage (H1 → H2 → H3) is correct
- Image alt text is thorough and descriptive throughout
- `metadataBase` is set to `https://kscan.app` ✓
- Bing site verification is present (`msvalidate.01`) ✓

### Issues:
**Critical — Canonical pointing to root on 4 secondary pages:**  
`/privacy`, `/legal/terms-summary`, `/do-not-sell-or-share`, and `/investors` all emit `<link rel="canonical" href="https://kscan.app/">`. These pages will not be indexed under their own URLs. The demo page is the only secondary page that correctly sets its canonical.

**Missing page-specific metadata:**  
The privacy, terms, and do-not-sell pages inherit global metadata including the global meta description ("K Scan is an AI fashion search app...") and the homepage OG title. These pages need their own title tags and descriptions.

**`/investors` not in sitemap:**  
This is intentional (confidential) but should be an explicit decision. Currently the page is technically indexable (not disallowed in robots.txt). Adding `/investors` to robots.txt disallow or adding a `<meta name="robots" content="noindex">` tag would make the non-indexing intentional.

**No Twitter handle:**  
The Twitter/X card metadata does not include a `twitter:site` or `twitter:creator` handle. Adding `@Kscan_app` would improve social sharing attribution.

**Keyword targets:**  
The site is well-positioned for "AI fashion search," "find clothes from photos," and "screenshot shopping." Gaps:
- "scan outfit to find clothes" — not represented in keyword list
- "wearable fashion search" — no page ranks for this despite it being a core product pillar
- "privacy fashion app" — an opportunity given the privacy-first positioning

---

## 9. Performance Review

### What's likely fine for launch:
- Next.js `<Image>` component is used throughout — handles WebP conversion, responsive sizing via `sizes` prop, and lazy loading automatically
- `priority` prop is correctly set on above-the-fold hero images
- Framer-motion's `useReducedMotion` is implemented — users with reduced motion preferences are respected
- Videos are served as MP4 from the `/public/demo/` directory — no third-party video embeds that would add privacy or speed concerns

### Should be optimized before launch:
- **Large source PNG files**: Several images in `/public/` are 2–4MB PNGs (`k2-cafe2.png` at 2.3MB, `texture-dinner.png` at 2.5MB, `group-street2.png` at 2.4MB). Next.js Image serves these as WebP, but the source file size affects server processing time. Converting sources to already-compressed WebP or AVIF would improve this.
- **`white-tan-hat.png` (1.8MB) appears twice in the waitlist section** — once for mobile, once for desktop (toggled with CSS `hidden`/`block`). This means both are downloaded on all devices. A single image with responsive sizing would eliminate the double-download.
- **Framer-motion is imported at the top level of `app/page.tsx`** (a "use client" component). This means the entire framer-motion library loads for every homepage visitor, even those without JavaScript interactions. Lazy-importing framer-motion for non-critical animations would improve initial load.

### Can wait until post-launch:
- Migrating static sections of the homepage to Server Components to reduce hydration bundle size
- Implementing ISR (Incremental Static Regeneration) for the sitemap
- Investigating whether demo MP4 videos should be served from a CDN rather than Next.js's public directory

---

## 10. Security Review

### Critical

None found at launch-blocking severity.

---

### High

**H1 — Public exposure of internal working files in `/public/docs/`**  
**Location:** `public/docs/` directory  
**Files exposed:** `~$can-privacy-policy.docx`, `~$can-terms-and-conditions.docx`, `~WRL2560.tmp`, `KSCAN_FirstLaunch_Modal_Copy.md`, `beta-v2-validation-summary.md`  
**Why it matters:** These files are live at `https://kscan.app/docs/[filename]` and are directly downloadable. Word lock files (`.~$...`) reveal file path fragments and Microsoft Office metadata. The `KSCAN_FirstLaunch_Modal_Copy.md` document reveals internal UI copy strategy. The `beta-v2-validation-summary.md` contains internal validation notes. The `robots.txt` disallows `/docs/` from search indexing, but this does not prevent direct URL access.  
**Fix:** Remove `~$can-privacy-policy.docx`, `~$can-terms-and-conditions.docx`, `~WRL2560.tmp`, `KSCAN_FirstLaunch_Modal_Copy.md`, and `beta-v2-validation-summary.md` from `public/docs/` immediately. Only the PDFs and `.txt` versions of user-facing legal documents should remain.  
**Launch-blocking:** Yes — remove before any public announcement.

**H2 — In-memory rate limiting non-functional in serverless production**  
**Location:** `lib/serverRateLimit.ts`, used in `/api/investor/login`, `/api/investor/deck`, `/api/investor-inquiry`, `/api/waitlist`  
**Why it matters:** The `Map<string, RateLimitEntry>` store is process-local. Vercel functions spin up fresh instances under load, meaning concurrent or sequential requests from different instances bypass the rate limit entirely. The investor login endpoint is rate-limited at 5 attempts/hour — in practice, an attacker with concurrent requests could run unlimited brute-force attempts.  
**Fix:** Replace with a persistent store. Upstash Redis (free tier, edge-compatible) is the lowest-friction option. Alternatively, a Supabase table with a `rate_limit_attempts` RPC and TTL-based expiry.  
**Launch-blocking:** Recommended to fix before investor deck goes live with real passwords. Not blocking for a soft waitlist launch.

---

### Medium

**M1 — Missing standard security headers**  
**Location:** `next.config.ts`  
**Missing:** `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, explicit `X-Frame-Options`  
**Fix:** Add to the headers array in `next.config.ts`.

**M2 — CSP weakened by `unsafe-inline` and `unsafe-eval`**  
**Location:** `next.config.ts`  
**Why it matters:** These directives are required for Next.js + framer-motion, but they eliminate most XSS protection the CSP provides.  
**Fix:** Post-launch: investigate nonce-based CSP with Next.js middleware for a stronger posture.

**M3 — Demo videos are publicly downloadable without any access control**  
**Location:** `public/demo/kscan-demo-v16.mp4`, `public/demo/kscan-demo-smartglasses-groupstreet.mp4`  
**Why it matters:** Anyone can download these videos directly. If they contain proprietary product footage or unreleased UI, this is an intentional but worth-confirming design decision.  
**Fix:** Confirm intentionality. If videos should not be freely downloadable, move them to Supabase storage and serve through an authenticated route.

**M4 — ZIP archives in public/demo directory**  
**Location:** `public/demo/kscan_demo_assets_v2.zip`, `public/demo/kscan_demo_folder_pack.zip`  
**Why it matters:** These ZIP archives are publicly downloadable and may contain development assets or unreleased materials.  
**Fix:** Remove if not intentionally public, or confirm contents are safe to expose.

---

### Low

**L1 — Footer social links lack `rel="noopener noreferrer"`**  
External links that open in a new tab without `rel="noopener noreferrer"` expose the page to reverse tabnapping. Verify the SiteFooter component adds these attributes.

**L2 — Investor cookie is not user-session-specific**  
The HMAC cookie value is deterministic from the password. All investors share the same cookie value. This is acceptable for a shared-password model but limits session invalidation control.

**L3 — No CSRF protection beyond Content-Type**  
Forms submit JSON (not form-encoded), which prevents simple CSRF from HTML form submissions. This is adequate for the current implementation but should be noted.

---

### Informational

- `.env.local` and `.env.production` both contain live Supabase service role keys. Both files are correctly gitignored (`.env*` pattern in `.gitignore`). The keys were NOT found committed to git. No action needed, but rotation is good practice periodically.
- `private/investor-docs/` is gitignored and is in the project root (not `public/`), so it is NOT web-accessible. Files there are safe.
- `investor-docs/` watermark tooling is also gitignored correctly.

---

## 11. Privacy Policy and Terms Review

*(Not formal legal advice — compliance-risk review only)*

### What appears solid:
- The Privacy Summary is clear, readable, and appropriately scoped
- The Do Not Sell or Share page is present and functional — CCPA compliance appears considered
- GPC (Global Privacy Control) signal is explicitly honored
- Raw scan data non-sale commitment is clearly stated
- Access/deletion rights are mentioned
- Terms Summary links to full PDF Terms

### What appears incomplete:
- **No cookie/analytics disclosure** — If any analytics tool is added (even Vercel Analytics), a cookie notice will be required under GDPR and CCPA. None is currently present. No analytics tool appears to be active in the current codebase, which means no notice is strictly needed now, but this should be added as a condition before analytics are enabled.
- **No GDPR / international transfer language** — The privacy summary does not address whether EU/UK users' data is transferred outside the EU, or what legal basis applies for EU processing. If waitlist signups include EU residents, this is a gap.
- **Data retention timeline is vague** — "24–72 hours" for transient visual data is stated, but no retention period for email addresses, waitlist signups, or inquiry data is specified.
- **No minors/children's language** — The Terms and Privacy should include COPPA-compliant language explicitly excluding users under 13.

### What seems inconsistent with actual site behavior:
- **Privacy summary contact email (`kscanai.app@gmail.com`)** — The policy appears to belong to a professional company, but the contact is a personal Gmail address. This creates a credibility issue and potential legal inconsistency if the company entity name doesn't match the email.
- **Terms Summary section 2 ("Commercial Data & Partner Activity")** — Mentions affiliate revenue and advertising revenue as possible income sources, but no advertising or affiliate relationships are visible in the current product. This is fine to include for future-proofing but should be reviewed by counsel.

### Should be reviewed by legal counsel before launch:
- The precise scope of "inferred fashion affinity information" that may be sold — this language is broad and should be precise
- Whether the current "Do Not Sell or Share" mechanism meets the specific requirements of CCPA 2.0 (CPRA)
- GDPR lawful basis for processing EU residents' email addresses collected via the waitlist
- Whether the company legal entity ("K Scan AI") is formally registered and matches the copyright notices

---

## 12. Investor / Public Claims Risk Review

*(Not formal securities advice — credibility and risk-flag review only)*

### Claims that are appropriately qualified:
- "K Scan is being built..." — present continuous, accurately pre-launch ✓
- "Prototype product experience, brand system, and investor-facing materials are in place" — specific and verifiable ✓
- "Internal benchmark across 50,000 test outfit images. Independent audit pending." — properly disclosed ✓
- "Early stage" tag on the investor hero image ✓

### Claims that need tighter phrasing or context:
- **"94% Silhouette Recognition"** — Shown in the trust metrics ticker without any qualifier. The qualifier ("Internal benchmark...") is only shown in the detailed stats card below the fold. This metric should have at minimum a small asterisk or note at the point of display.
- **"200+ Retailers Indexed"** — If this is a projection or target rather than a current live count, it should say "up to," "planned," or "target."
- **"10+ INTEGRATED RETAILERS"** vs **"200+ Retailers Indexed"** — These two figures appear on the same page and are inconsistent. Investors and journalists will notice immediately.
- **"Ranked results pulled from indexed retailer catalogs"** (Product Architecture, Section 06) — Implies live integration. Should include a clarifier like "being developed to pull" if not yet live.

### Claims that should be qualified for investor materials:
- Market opportunity section contains no cited figures — all market claims are stated in first person without attribution. Add a citation or caveat: "K Scan's estimate based on [source]" or "per [analyst firm]."
- The leadership section being entirely blank means the investor deck (if it reflects the site) is representing a company with no identified leadership. This is a significant investor-credibility concern.

### What is fine as-is:
- No traction claims (user numbers, revenue, pilots) are stated — appropriate for stage
- No guarantees of returns or investment outcomes
- No "opportunity to invest" language that would constitute a public solicitation
- The investor page states "materials are intended for qualified recipients only" ✓

---

## 13. Top 15 Issues Ranked by Importance

| # | Severity | Location | Problem | Why it Matters | Recommendation |
|---|---|---|---|---|---|
| 1 | 🔴 High | `public/docs/` | 5 internal/temp files publicly accessible via URL | Word lock files, temp files, and internal docs expose operational info | Delete `~$can-*.docx`, `~WRL2560.tmp`, `KSCAN_FirstLaunch_Modal_Copy.md`, `beta-v2-validation-summary.md` from `public/docs/` |
| 2 | 🔴 High | `lib/serverRateLimit.ts` | In-memory rate limiting non-functional in serverless | Investor password has no real brute-force protection | Replace with Upstash Redis or Supabase RPC counter |
| 3 | 🔴 High | All secondary pages | Canonical tag points to root (`/`) on /privacy, /legal/terms-summary, /do-not-sell-or-share, /investors | Search engines treat these as duplicates of the homepage | Add `alternates: { canonical: "/[route]" }` to each page's metadata |
| 4 | 🟠 Medium | Homepage ticker | "NEURAL MATCH ACCURACY" has no value | Looks broken; damages credibility | Add the value (e.g., "94%") or remove this metric |
| 5 | 🟠 Medium | `app/page.tsx` ~L989–993 | Duplicate paragraph in Fashion Intelligence Engine section | Unprofessional copy; indicates editing oversight | Delete the shorter duplicate paragraph |
| 6 | 🟠 Medium | Investor page / email routes | `investors@kscan.ai` on investor page vs `kscanai.app@gmail.com` in auto-replies | Investor receives Gmail reply after contacting a professional address | Standardize to one email; use domain-matched address |
| 7 | 🟠 Medium | Investor page, Section 11 | Leadership section has no names, titles, or bios | Investors need to know who they are backing | Add at minimum one founder name, title, and 2-sentence bio |
| 8 | 🟠 Medium | Homepage stats | "10+ INTEGRATED RETAILERS" vs "200+ Retailers Indexed" on same page | Inconsistent figures will be caught by investors and press | Standardize and clarify the distinction or use one number |
| 9 | 🟠 Medium | Investor page CTAs | "Schedule a Conversation" scrolls to form, not a calendar | Misleading CTA label erodes trust | Rename to "Submit an Inquiry" or add a real calendar link |
| 10 | 🟠 Medium | `next.config.ts` | Missing `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` headers | Defense-in-depth security headers absent | Add standard security headers to the headers config |
| 11 | 🟡 Low | Footer social links | External links lack `rel="noopener noreferrer"` | Minor reverse tabnapping risk | Add `rel="noopener noreferrer"` to all external links |
| 12 | 🟡 Low | All pages | No custom 404 page | Breaks polish on dead-end navigation | Add `app/not-found.tsx` with branded layout and CTA |
| 13 | 🟡 Low | Privacy/Terms pages | Contact email is `kscanai.app@gmail.com` | Reduces trust for a privacy contact | Replace with `privacy@kscan.ai` or equivalent |
| 14 | 🟡 Low | `/demo` page videos | Video links navigate to raw MP4 URLs | Videos are downloadable; inline playback is expected | Embed videos inline or confirm the behavior is intentional |
| 15 | 🟡 Low | Homepage hero | "See it. **Say it.** Get it." — "Say it" has no product basis | Creates confusion about whether the product uses voice | Revisit tagline or add a brief clarifier |

---

## 14. Top 15 Recommended Improvements

1. **Resolve public/docs exposure** — Delete all non-user-facing files from `public/docs/` before any public announcement. This is the single most urgent action.

2. **Fix canonical metadata on all secondary pages** — Four pages incorrectly canonicalize to the homepage. This is a 30-minute fix with meaningful SEO impact.

3. **Fix "NEURAL MATCH ACCURACY" to show a value** — Assign the correct figure or remove the metric from the ticker entirely.

4. **Remove the duplicate paragraph in the Fashion Intelligence Engine section** — Quick copy edit in `page.tsx`.

5. **Add a founder/leadership profile** — Even one paragraph with a name and brief background dramatically increases investor credibility. Add to both the investor page and optionally an About section or footer bio.

6. **Fix the investor contact email inconsistency** — Standardize to one domain-matched email (`investors@kscan.ai`) throughout the codebase, including the auto-reply template in `investor-inquiry/route.ts`.

7. **Replace in-memory rate limiting with a persistent store** — Before sharing investor passwords with real investors, this should be done. Upstash Redis with a free tier is the lowest-friction fix.

8. **Add page-specific metadata to /privacy, /legal/terms-summary, /do-not-sell-or-share** — Improves both SEO and social sharing when these pages are linked.

9. **Add the five missing HTTP security headers** — `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `HSTS` (explicit). A 20-line change in `next.config.ts`.

10. **Standardize the retailer count (10+ vs 200+)** — Pick one number for the ticker and one for the benchmark section, and clarify what each means.

11. **Create a custom `app/not-found.tsx` page** — Branded 404 with nav, headline, and CTA. 1–2 hours of work.

12. **Add `rel="noopener noreferrer"` to all external links in SiteFooter** — Specifically the social links (Instagram, TikTok, X).

13. **Add a `noindex` directive or robots disallow for `/investors`** — If the investor content should not be publicly indexed, make this explicit rather than relying on sitemap omission alone.

14. **Clarify or adjust "See it. Say it. Get it."** — Either drop "Say it" or anchor it to the wearable product vision with a brief label like "(and soon, say it)."

15. **Embed demo videos inline on the demo page** — Rather than linking to raw MP4 files, use a `<video>` element with controls, poster frame, and `preload="metadata"`.

---

## 15. Pre-Launch Decision

**→ Ready to launch after minor fixes.**

The site is substantively strong. The brand identity, product narrative, and technical foundations are sound. The investor portal is thoughtfully implemented. The waitlist flow is clean. The copy is generally honest and appropriately hedged for a pre-launch product.

**Before any public announcement or press mention:**
1. Delete the five problem files from `public/docs/` — this is the only genuinely security-sensitive issue
2. Fix the "NEURAL MATCH ACCURACY" broken metric
3. Fix the canonical metadata on secondary pages (SEO impact compounds over time)
4. Remove the duplicate paragraph

**Before sharing investor passwords with real investors:**
5. Replace in-memory rate limiting with a persistent store
6. Standardize the investor contact email

**Before a broader launch or paid marketing:**
7. Add leadership section content
8. Fix the "Schedule a Conversation" CTA
9. Add custom 404 page
10. Standardize retailer counts

None of the remaining issues are launch-blocking. The site is credible, premium, and focused. The gaps are mostly polish and operational consistency — not fundamental product or positioning problems.

---

## 16. Final Concise Recommendation to the Founder

**Fix first, right now (before you share the URL publicly):**

You have five internal files sitting in your public folder that anyone can download: two Word lock files, a Word temp file, your first-launch modal copy doc, and an internal beta validation summary. These are live at `https://kscan.app/docs/[filename]`. Delete them today — they're not visible to casual visitors but they're fully accessible. This is the only issue that rises to "urgent."

**What is already strong:**

Your product story is the clearest part of the site. "See it. Say it. Get it." is punchy. The step-by-step flow (Capture → Identify → Shop) is immediately understandable. Your fashion-specific and retailer-neutral positioning comes through consistently. The investor thesis is honest and appropriately hedged — you're not overclaiming. The benchmark disclosure ("Internal benchmark...independent audit pending") is the right call and will be respected by serious investors. The visual design is premium and category-appropriate; it feels like it belongs in the same world as the fashion it's trying to surface.

**What matters most for credibility:**

Two things are actively hurting investor credibility right now. First, the leadership section has zero content — investors need to know who they're backing. Add your name, title, and two sentences about your background. Second, the investor contact email inconsistency — the investor page shows `investors@kscan.ai` but inquiries are auto-replied to from `kscanai.app@gmail.com`. Pick one address, make it domain-matched, and fix the mismatch in the codebase. These two issues will be the first things a serious investor notices.

**What matters most for conversion:**

The "NEURAL MATCH ACCURACY" metric in the homepage ticker has no value — it just shows the label. That looks broken, not impressive. Add the number or cut the metric. Also, "10+ INTEGRATED RETAILERS" in the ticker conflicts with "200+ Retailers Indexed" in the stats section on the same page. Inconsistent numbers signal carelessness. Fix both before sharing the URL.

The waitlist form is clean, the success state is warm, and the form copy is appropriately honest. Your conversion infrastructure is in good shape. The main risk to waitlist conversion is visitors who don't understand what stage the product is at — the "Private beta — 2026" label helps, but the FAQ still phrases some answers in a way that implies the product is live ("K Scan is being built" is better than "K Scan analyzes..." for a product not yet in users' hands).

---

*End of Audit — K Scan AI | May 18, 2026*
