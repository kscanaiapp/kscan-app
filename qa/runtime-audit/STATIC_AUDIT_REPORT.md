# K Scan — Release-Candidate UX/UI Diagnostic Audit (Static + Partial Runtime)

**Mode:** Read-only. No source edits, commits, builds, deploys, or destructive actions.
**Audit environment:** Cowork Linux sandbox — full static code/UX access to the repo; **no network route to the Windows host ADB/emulator** (verified). Runtime evidence is limited to artifacts dropped by the Windows host into `qa/runtime-audit/`.
**Date:** 2026-06-11
**Repo:** `C:\Users\jsmit\KScan` · Branch `feature/stylechat-v0.4.2-burst-limit` · Commit `15a0b35` · Build label `Android Beta v1.5.2` · `version 1.0.0` / `versionCode 3` · pkg `com.kscanai.app`

---

## 1. Executive Summary

- **Overall release-candidate readiness:** **Ready for AAB after a small polish batch**, contingent on a clean runtime smoke pass (see §8 — runtime is currently *partial*).
- **Static audit P0 blockers:** **None confirmed in code.** Scan state machine, error mapping, routing guard, account-deletion flow, destructive-action confirms, secret handling, and QA-tool gating are all sound.
- **Top 3 likely pre-AAB issues:** (1) Developer jargon + raw error strings in consumer copy; (2) brand split — cyan sign-in/loading vs gold app; (3) WCAG contrast failures on muted/gold label text + Android safe-area/keyboard handling.
- **Runtime status:** **PARTIAL.** Three launch screenshots received (all identical — app still on the native splash ~7s after launch in a dev build) + one prior logcat (system noise, no app lines). No scan/rooms/chat/auth/privacy screenshots, no XML dumps, empty `notes.txt`. Core-flow runtime testing remains **pending**.

---

## 2. P0 Release-Candidate Killers

**None confirmed from static code or the available runtime artifacts.** Four items remain **P0-until-cleared by runtime** (they cannot be proven from code and the screenshots so far don't reach them):

| ID | Flow/Screen | File/Component | Evidence | Impact | Recommended fix | Regression risk | Runtime validation |
|----|-------------|----------------|----------|--------|-----------------|-----------------|--------------------|
| C1 | First scan vs cold backend | `services/api.js:18-19` (`ANALYZE_TIMEOUT_MS=45000`, hosted base) | Static: 45s client abort; hosted backend cold-starts. Splash-only screenshots can't reach scan. | First scan may fail → "core feature broken" first impression | App-open warm-up ping; surface "waking up" by ~3-4s | low | **Required** — time first scan |
| C2 | Keyboard over inputs | `app/auth/index.tsx:327`, `app/style-chat/[sessionId].tsx:158` | `KeyboardAvoidingView behavior="height"` (Android) | Input/submit hidden while typing | Switch to padding+offset or keyboard-aware container | low–med | **Required** — type in both |
| C3 | Safe-area on tall device | `app/index.tsx`, `app/auth/index.tsx`, `app/privacy.tsx` (RN `SafeAreaView`) + `constants/theme.js:259` (`safeTop android:56`) | RN SafeAreaView is iOS-only for insets; hardcoded top pad | Status-bar/cutout overlap or dead gap on 1344×2992 | Use `react-native-safe-area-context` + `useSafeAreaInsets` | low | **Required** — visual |
| C4 | Slow first render / splash hang | native splash + JS bundle | Runtime: `01/02/03_*.png` identical — still on splash ~7s post-launch (dev build) | If it persists in a release build, looks frozen on open | Re-measure on a **release build**; check splash→first-screen handoff | n/a | **Required** — production build |

---

## 3. P1 Pre-AAB Fix Candidates

| # | Flow/Screen | File/Component | Issue | User impact | Style/function impact | Recommended fix | Complexity | Regression | Runtime val. |
|---|-------------|----------------|-------|-------------|-----------------------|-----------------|-----------|-----------|-------------|
| P1-1 | Privacy actions | `app/privacy.tsx:183,199,361` | "if your Edge Function is deployed and reachable" / "deployed Edge Functions" | Confusing; exposes backend | Looks unfinished | Rewrite to user-neutral; gate dev caveat to `__DEV__` | small | low | no |
| P1-2 | Auth footnote | `app/auth/index.tsx:508` | "protected by row-level security" | DB jargon | Trust | "Your choices are private to your account." | small | low | no |
| P1-3 | Errors across flows | `privacy.tsx:163/186/202`, `auth/callback.tsx:48/62/82`, `authValidation.js:87` (raw fallthrough), `dressing-rooms/[id].tsx`, `dressing-rooms/index.tsx:84`, `style-chat/[sessionId].tsx:78` | Raw `error.message` surfaced to user (incl. on delete) | Scary/unbranded errors | Trust | Map through a friendly-message helper; log raw to console | small–med | low | partial |
| P1-4 | Global theme | `app/_layout.tsx:81`, `app/auth/index.tsx` (many `#00FFFF`) | Cyan sign-in/loader vs gold editorial app | Feels like two apps | Brand coherence | Migrate auth/loader to gold system | medium | medium | confirm visual |
| P1-5 | Contrast (AA) | `constants/theme.js` (24,25,29,38) + consumers | `editorialTextMuted #8A8A8A`, `goldPressed #B6924E` on light (~3:1); `textTertiary` 9px labels | Hard to read | A11y | Darken tokens to ≥4.5:1; bump 9px labels | small | low–med | confirm on device |
| P1-6 | First-scan latency UX | `hooks/useKScan.js:22`, `app.js:143` | Long-wait copy only at 10s; +600ms min + HUD reveal each scan | Feels frozen before 10s | Perceived perf | Surface "waking up" sooner; warm-up ping | small | low | time it |
| P1-7 | Home gating | `app/index.tsx:63,94` vs `app.js:448` | Home always shows Rooms/StyleChat; tap when frozen → "TEMPORARILY UNAVAILABLE" | Mild confusion | Consistency | Gate cards by `useFeatureFreeze` | small | low | no |
| P1-8 | Prod log hygiene | `services/imageUtils.js:4`, `hooks/useKScan.js:24` | Diag loggers run unconditionally (safe metadata only — no base64/PII/secrets) | None visible | Console noise | Wrap in `__DEV__` like `api.js:27` | small | low | no |
| P1-9 | Tiny targets/text | `style-chat/[sessionId].tsx:201,216`; camera overlay buttons in `app.js` | 9px labels; small overlay buttons | Fat-finger / legibility | A11y | ≥11px text, ≥44dp targets | small | low | confirm on device |
| P1-10 | Double loading treatment | `app.js:546` (ProcessingPanel) + `app.js:647` (PerceptionLayer) | Both mount during `processing` | Possible double spinner/HUD | Polish | Dedupe after visual confirm | small | low | **confirm in `04`** |
| P1-11 | Splash duration | native splash / bundle | App on splash ~7s in dev (C4) | Slow open perception | Perceived perf | Validate on release build; consider splash copy | small | low | **release build** |

---

## 4. Form-and-Function Findings

- **Cold backend dominates the first impression** (C1/P1-6): hosted base `https://kscan-app-1.onrender.com` (`services/api.js:19`) — sleep-prone host; first scan eats the wake-up and there's no app-open warm-up ping.
- **Scan recovery is strong**: `Try Again` (re-preview) + `Retake Photo`, `dismissResult`; abort/timeout/network all mapped to safe copy (`services/api.js:239-251`). No raw scan errors reach the user.
- **Non-fashion is a first-class success state** ("NO FASHION SIGNAL DETECTED"), not an error — good fashion-specific behavior.
- **Silent auto-save** to Style Library on each success (`app.js:316`) with a 1.8s toast, no undo — acceptable, but rapid scanning accumulates entries silently.
- **Rooms/Looks/StyleChat** all have empty + loading + error + retry states; create-room validates a non-empty title; StyleChat handles burst/limit notices distinctly from errors (`style-chat/[sessionId].tsx:111`).
- **Routing guard** (`services/routingGuard.js`) correctly gates private routes, allows public share routes, redirects expired sessions to `/auth`, and bounces authed users off `/auth`.

---

## 5. Visual/Style Findings

- **Two design languages** (P1-4): champagne-gold warm editorial (home, rooms, privacy, analysis card, **splash** — confirmed gold in `01_launch.png`) vs neon-cyan dark (AuthGate loader, full auth screen). Biggest "not one product" issue.
- **Contrast** (P1-5): muted greys + gold label token fall below AA on cream/white surfaces (eyebrows, captions, meta, "No close catalog matches found.", footer links).
- **Analysis card** is genuinely premium: staggered chip reveals, drag-to-dismiss, gold glow, `useSafeAreaInsets`, "Style Read" headline fallback.
- **ProductShelf** ships custom per-category vector placeholders + image `onError` fallback + bad-stock-image URL filtering (`services/api.js:57`).
- **Splash** (`01_launch.png`): gold-K-on-purple icon on white, dark status-bar text (readable). On-brand.
- **Typography** is fixed-size (no Dynamic Type scaling) — large-text users risk truncation (P2).

---

## 6. Android-Specific Risks

- **Safe-area inconsistency** (C3): `app.js` uses `react-native-safe-area-context` correctly; `app/index.tsx`, `app/auth/index.tsx`, `app/privacy.tsx` use RN's iOS-only `SafeAreaView` + hardcoded `safeTop:56`. Not cutout/edge-to-edge aware. **Requires runtime** on 1344×2992.
- **Keyboard** (C2): `behavior="height"` on Android for auth, confirm-email, StyleChat. `app.json softwareKeyboardLayoutMode:"resize"` helps but `height` + bottom input is the classic cover-up. **Requires runtime.**
- **Edge-to-edge:** no explicit opt-in seen; API 35+ enforces it; device reports release "17". Verify system bars don't draw over content. **Requires runtime.**
- **Hardware back:** thoroughly handled in `app.js` (blocks back during `processing`/reveal; preview→retake; non-fashion/error→dismiss; modals via `onRequestClose`); StyleChat has a dedicated home-back handler respecting open delete dialogs. Good (confirm at runtime).
- **Share sheet:** native `Share.share` with proper payload; revoke-link has a clear confirm.
- **Permissions:** requests only CAMERA/INTERNET/VIBRATE; **blocks RECORD_AUDIO** — clean, policy-friendly. Camera- and photo-denied states handled with Settings guidance.
- **Cold render** (C4): splash persisted ~7s in the dev build per `01-03_*.png`; re-validate on a release build.

---

## 7. Privacy/Trust Findings

- **Account deletion copy is accurate** (`app/privacy.tsx:219-222`): "processed within 30 days… except information we are legally required to retain." No instant-deletion overclaim. Confirm modal with Cancel/Delete + `onRequestClose`.
- **Destructive actions all confirmed**: delete room/item/inspiration, revoke share, delete chat — each via a Cancel/destructive dialog.
- **Pre-upload privacy**: image sanitizer + face-blur path before upload (`hooks/useKScan.js:175`); only safe metadata logged (no base64/PII).
- **No secrets in code**: secret scan clean; Supabase client uses only `EXPO_PUBLIC_SUPABASE_ANON_KEY` from env. No `service_role`/private keys.
- **Trust concerns to fix:** dev jargon (P1-1/P1-2) and raw error strings (P1-3) undercut a privacy-conscious user's confidence, especially on the deletion path.
- **Auth disclosure hygiene:** `mapAuthError` avoids revealing whether an email is registered — good — but its unmapped fallthrough returns the raw provider string (P1-3).

---

## 8. Runtime Artifact Findings *(only what artifacts support)*

**Artifacts present in `qa/runtime-audit/`:**

| Artifact | Maps to | Finding |
|----------|---------|---------|
| `01_launch.png`, `02_camera_permission.png`, `03_home_or_camera.png` | Priority 1 launch / C4 | **Byte-identical** (same md5). At ~5–7s post-launch the app is still on the **native splash** (gold-K-on-purple on white). The app did **not** progress to a camera-permission prompt or home/camera within the capture window. Status-bar text is dark/readable on white; brand is gold (consistent). |
| `02_camera_permission.png` | Camera permission | **No permission prompt visible** (app still on splash). Per the no-`pm clear` constraint, cannot tell if permission was pre-granted or simply not yet reached → **requires fresh-install validation**. |
| `logcat_session.txt` (prior batch) | Logs | ~100s of **system noise only** (libbinder/ConnectivityService/skia/GMS). **0** ReactNativeJS, **0** kscan, **0** AndroidRuntime FATAL/redbox. App wasn't foregrounded/driven during that capture; not usable for app diagnostics. |
| `notes.txt` | Priority 1 notes | Empty (0 bytes). |
| `01_launch.xml` and `04-07_*.png` | — | **Not present.** |

**Confirmed runtime conclusions (artifact-backed):**
- No crash/redbox observed — but this is weak: the app produced no JS log lines and the screenshots never left the splash, so absence of crashes is not yet meaningful.
- Splash-to-interactive handoff was **not observed within ~7s** in the dev build (C4/P1-11).

**Still pending (no artifacts):** scan→analyze→result, cold-backend timing, rooms/share, StyleChat, auth/OAuth/session restore, privacy/deletion modal, safe-area/keyboard/back. These remain **static-only** assessments.

**To make Priority 1 usable, re-capture on the Windows host with:** longer post-launch wait (≈15–20s for the dev bundle, or test a release build), app-scoped UTF-8 logcat (`--pid`, captured *while* driving the scan), and verified non-empty PNGs (`>10 KB` check) for `04–07` + filled `notes.txt`.

---

## 9. Recommended Pre-AAB Fix Batch (≤12 files; no backend/schema/config/version)

1. `app/privacy.tsx` — strip "Edge Function" jargon (×3); friendly-map raw `error.message` (×3). *(P1-1, P1-3)*
2. `app/auth/index.tsx` — replace "row-level security" footnote; start cyan→gold migration. *(P1-2, P1-4)*
3. `app/auth/callback.tsx` — wrap raw `error.message` (×3). *(P1-3)*
4. `services/authValidation.js` — replace raw fallthrough at `:87` with a generic message. *(P1-3)*
5. `app/dressing-rooms/[id].tsx` + `app/dressing-rooms/index.tsx` — friendly-map `Alert`/create errors. *(P1-3)*
6. `app/style-chat/[sessionId].tsx` — friendly-map delete error; bump 9px labels. *(P1-3, P1-9)*
7. `constants/theme.js` — darken `editorialTextMuted`, `goldPressed` (labels) to AA. *(P1-5)*
8. `services/imageUtils.js` + `hooks/useKScan.js` — gate diag loggers behind `__DEV__`. *(P1-8)*
9. `app/index.tsx`, `app/privacy.tsx` — swap RN `SafeAreaView` → `react-native-safe-area-context`. *(C3)* *(group with auth in #2)*
10. `services/api.js` / `app.js` — app-open warm-up ping; surface "waking up" sooner. *(C1, P1-6)*
11. `app/index.tsx` — gate Rooms/StyleChat cards by `useFeatureFreeze`. *(P1-7)*

Keyboard handling (C2) and the splash/cold-render (C4) should be **confirmed at runtime first**, then fixed if reproduced — not blind-changed.

---

## 10. Do-Not-Touch List (before this AAB)

- Do not re-enable `DEV_FALLBACK` (`constants/build.js` stays `'false'`).
- Do not weaken non-fashion detection.
- Do not alter the scan state machine in `hooks/useKScan.js` beyond logger gating.
- Do not change `app.json` permissions / `blockedPermissions` (RECORD_AUDIO block is correct).
- Do not touch Supabase schema, RLS, migrations, or Edge Functions.
- Do not change `version`/`versionCode` as part of polish.
- Do not do a full theme-system rewrite now — minimum cyan→gold + contrast token edits only.
- Do not change OAuth/deep-link config.

---

## 11. Final Recommendation

**Ready for AAB after a small polish batch** (§9), **gated on a clean runtime smoke pass**. If runtime shows keyboard covering inputs (C2), safe-area overlap (C3), first-scan failure (C1), or a persistent splash hang on a **release** build (C4), those promote to **Not ready for AAB** until fixed.

---

## Appendix — coverage

**Files/areas inspected (static):** `app/_layout.tsx`, `app/index.tsx`, `app/scan/index.tsx`, `app.js` (full), `hooks/useKScan.js`, `services/api.js`, `services/imageUtils.js`, `services/accountDeletion.js`, `services/routingGuard.js`, `services/authValidation.js`, `services/supabaseClient.ts`, `services/featureFreeze.ts`, `app/auth/index.tsx`, `app/auth/callback.tsx` (refs), `app/privacy.tsx`, `app/dressing-rooms/index.tsx`, `app/dressing-rooms/[id].tsx`, `app/style-chat/index.tsx`, `app/style-chat/[sessionId].tsx`, `app/(public)/rooms/[token].tsx`, `components/AnalysisCard.tsx`, `components/ProductShelf.tsx`, `components/FeatureFreezeFallback.tsx`, `constants/build.js`, `constants/theme.js`, `app.json`, `package.json`.

**Artifacts found:** `01_launch.png`, `02_camera_permission.png`, `03_home_or_camera.png` (identical), `logcat_session.txt` (system noise), `notes.txt` (empty). **Not found:** `04–07_*.png`, `01_launch.xml`.

**Unresolved runtime validation gaps:** scan/cold-backend timing, rooms+share, StyleChat, auth/OAuth/session restore, privacy/deletion modal, keyboard/safe-area/back, release-build splash timing.

**Note:** The emulator runs a **Metro dev build (`__DEV__=true`)** — QA panels, build-label overlays, and verbose `[K-SCAN]`/`[DEBUG]` logs appear there and are correctly gated out of the production AAB (`constants/build.js`). Do not file them as production leaks.
