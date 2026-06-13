# Google Play — Fresh Submission Audit (2026-06-13)

> Google Submission v2 — Prompt 14 (fresh regression audit after the V6 "purple gold electric"
> theme merge). This audit re-verifies whether recent app changes preserve the Play submission
> posture established by Prompt 12 (`qa/google-play-data-safety-final-answers-2026-06-12.md`) and
> Prompt 13 (`qa/google-play-prompt-13-readiness-report-2026-06-12.md`).
>
> This document does NOT update Play Console, build/upload an AAB, or submit for review.
>
> Last updated: June 13, 2026.

---

## 1. Executive summary

**Core question — Do recent app changes preserve the Google Play submission posture established by Prompt 12 / Prompt 13?** → **Yes.**

The only substantive change since the last compliance commit (`b8d23a9`) is the V6 "purple gold electric" visual theme, merged into `release/android-1.0.0` as `b54f0f7`. It is **visual-only**: five files changed (color tokens and styling), with no logic, data-flow, permission, provider, or dependency changes. Every submission anchor from Prompt 12/13 was independently re-verified against the current code and still holds.

- **No P0 blockers.**
- **Canonical Data Safety packet remains valid** — no update required.
- Manifest/permissions, ads/tracking, providers, privacy/terms/deletion URLs, audience, and version identity are all unchanged and consistent.
- TypeScript passes (`tsc --noEmit` exit 0, owner-run in PowerShell); working tree clean; no merge-conflict markers.
- Remaining items are P1 confirmations (most carried forward from Prompt 12) and P2 hygiene.

**Process note (not a repo issue):** an earlier pass in the sandbox reported a 283-file "dirty tree" with three truncated source files. That was a **sandbox-mount read artifact** — the Linux mount served stale/partial copies. The authoritative Windows filesystem (and the owner's PowerShell `git status`) shows a **clean tree** with the theme files intact. All findings in this report were derived from the authoritative Windows paths (Read/Grep) and owner-run PowerShell git.

---

## 2. Baseline verification

| Item | Value | Source |
|---|---|---|
| Branch | `release/android-1.0.0` | `.git/HEAD` (Windows) + owner PowerShell |
| HEAD | `b54f0f7` (merge: integrate purple gold electric theme) | `.git/refs/heads/release/android-1.0.0` |
| Descends from `b8d23a9` | Yes (HEAD is the merge commit; topology + owner-attested) | merge structure |
| Feature commits merged | `44aa296` (finalize theme), `ee370a5` (V6 home-scan slice), `7e3fa11` (V6 palette) | owner-attested |
| `tsc --noEmit --skipLibCheck` | **exit 0 (PASS)** | owner PowerShell |
| `git status --short` | **clean** | owner PowerShell |
| `git diff` / `--name-status` | **no output** | owner PowerShell |

Disallowed commands NOT run by this audit: `expo prebuild`, `eas build`, `eas submit`, `supabase deploy`, push. No native/schema/migration/auth/deletion/build/dependency changes were made.

## 3. Branch / merge / visual-change status

The V6 theme branch (`feature/purple-gold-electric-theme`) has been **committed and merged**; HEAD of the release branch is the merge commit `b54f0f7`. The "minor UX/UI polish" that Prompt 13 listed as the precondition for the AAB gate is therefore **complete**. No unmerged visual commits remain. No conflict markers exist in source (`<<<<<<<`/`=======`/`>>>>>>>` scan of `*.{ts,tsx,js,jsx}` → no matches).

## 4. Commit / version identity

- Package ID: `com.kscanai.app` (app.json L35, build.gradle L92 namespace/applicationId).
- VersionName: `1.0.0` (app.json L5, build.gradle L96).
- VersionCode: `5` (app.json L36, build.gradle L95). **Consistent across both files.**
- `eas.json` `appVersionSource: local` → version is governed by app.json/build.gradle.

**versionCode bump:** the repo cannot prove the highest versionCode already uploaded to Play Console. **PLAY CONSOLE OWNER CONFIRMATION REQUIRED** — verify the highest uploaded Android versionCode across Internal/Closed/Open/Production is **< 5**. If Console already holds 5 or higher, a bump is required before AAB upload. Do not bump without owner authorization.

## 5. Data Safety packet validity

**Still valid — no update required.** The canonical packet (`qa/google-play-data-safety-final-answers-2026-06-12.md`) was re-checked against current code; all anchors hold:

- Permissions `CAMERA`/`INTERNET`/`VIBRATE` only; `RECORD_AUDIO` blocked — matches manifest + app.json.
- `USE_OPENROUTER=true`, `OPENROUTER_MODEL=meta-llama/llama-4-scout` — matches `.env.example`.
- No ad/analytics SDK — matches `package.json`.
- versionName/Code/package — match.
- In-app deletion (request-based, 30-day) — matches `app/privacy.tsx`.
- Photos collected/**shared** (OpenRouter Gate C); StyleChat messages collected/not-shared (Gemini service-provider); Email/User IDs/Name collected; Advertising ID / location / audio **not** collected — all consistent with current code.

The theme merge touched no data-collection surface, so the conservative disclosure baseline is unaffected. Per the safe-fix rule, the canonical answers were **not** modified (current evidence does not prove them inaccurate).

## 6. Manifest / permission audit

- **`android/app/src/main/AndroidManifest.xml`:** `CAMERA`, `INTERNET`, `VIBRATE` only. `allowBackup="false"`. No `AD_ID`, `LOCATION`, `RECORD_AUDIO`, `BLUETOOTH`, or `SYSTEM_ALERT_WINDOW`.
- **`android/app/src/release/AndroidManifest.xml`:** explicitly **removes** `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` via `tools:node="remove"` — release build is hardened against plugin permission leakage.
- **`app.json`:** permissions `CAMERA`/`INTERNET`/`VIBRATE`; `blockedPermissions: [RECORD_AUDIO]`.

All permissions are consistent with the Data Safety answers. No contradiction → no Lane C fix required.

## 7. Permission-source / native-module safety check

Expo plugins in `app.json`: `expo-camera` (`cameraPermission` set, `microphonePermission:false` → injects CAMERA only, not RECORD_AUDIO), `expo-image-picker` (photo-library upload), `expo-router`, `expo-apple-authentication`, `expo-font`. None inject `AD_ID`, `LOCATION`, `BLUETOOTH`, or `RECORD_AUDIO`. Any storage permission `expo-image-picker` might add is additionally stripped by the release manifest. No permission removal was needed, so the Lane C Expo-plugin guard did not trigger.

(`node_modules` native-manifest scan was not run from the sandbox; the merged manifest is governed by the Expo config above and the release-manifest removals. Final merged manifest should still be confirmed at AAB build time — P1.)

## 8. Ads / tracking / analytics / Device ID audit

**Clean.** `package.json` contains **no** ads/tracking/analytics SDKs (no firebase, admob, appsflyer, adjust, segment, mixpanel, amplitude, crashlytics, sentry, posthog, branch, expo-notifications). Source scan for `advertisingId`/`AAID`/`trackEvent`/`logEvent`/`analytics.`/`pushToken` returned only benign matches (`server.js` comment; an Apple-readiness QA verifier script). No Advertising ID, no tracking, no push tokens, no analytics SDK. Consistent with "Ads: No / Tracking: No / Advertising ID: not collected." Local `AsyncStorage`/`expo-secure-store`-style session storage does not constitute tracking.

## 9. Provider drift / AI configuration audit

Providers referenced: **OpenRouter** (image analysis, default `USE_OPENROUTER=true`, `server.js` + `app/api/analyze+api.js`) and **Gemini** (StyleChat, `supabase/functions/stylechat-generate`). All keys are server-side (no `EXPO_PUBLIC_` prefix). **No new provider** was added since Prompt 12/13; routing is unchanged. The conservative Data Safety packet (OpenRouter Gate C for images; Gemini service-provider for StyleChat) still fits. Production `USE_OPENROUTER` value remains unprovable from repo → P1 (already documented; conservative disclosure covers it).

**Theme-merge Data Safety impact:** the five changed files (`app.js`, `app/index.tsx`, `components/PerceptionLayer.tsx`, `components/ScanButton.tsx`, `constants/theme.ts`) contain only color tokens / styling. Scan for `fetch(`/`upload`/`base64`/`analytics`/`track(`/`logEvent`/`geolocation`/`RECORD_AUDIO`/`mediaLibrary`/`pushToken` across them → **no matches**. **Theme merge is visual-only; no Data Safety impact.**

## 10. Privacy / Terms / deletion URL audit

Canonical URLs present and consistent:
- Privacy Policy: `https://kscan.app/legal/privacy` (`app/privacy.tsx`, `app/auth/index.tsx`, `store.config.json`).
- Terms: `https://kscan.app/legal/terms` (`app/privacy.tsx`, `app/auth/index.tsx`).
- Support: `https://kscan.app/support`.
- Delete-account (Play Console field): `https://kscan.app/legal/delete-account` — referenced in QA packet/store docs (verified 200 on 2026-06-12). The in-app deletion uses a native flow (`submitAccountDeletionRequest`), so the app does not hardcode the URL; this is fine for the app, but the URL must be entered in Play Console and the page kept live (owner).

No stale URLs in app-facing copy. No Lane D/E URL fix required.

## 11. Roadmap-only / unsupported-claim audit

App-facing copy (`app/`, `components/`) scan for `teen`/`minor`/`children`/`kids`/`13+`/`family-friendly`/`zero-knowledge`/`end-to-end`/`all faces`/`auto-blur`/`100% accurate`/`guaranteed` → no problematic matches. (`PRIVACY_COPY.minor` is a CCPA under-16 sale/sharing opt-out clause — a compliance statement, not youth positioning. `children` in `rooms/[token].tsx` is the React `children` prop.) No smart-glasses/voice/AR/virtual-try-on/agentic-checkout claims in shipped copy. The `kscan-google-glasses/` subproject is **not** part of the shipped Android app (separate module, not in the AAB) and is not surfaced in user-facing copy.

## 12. Store listing / reviewer notes / assets audit

- **Store listing draft:** 18+ explicit; "not directed to children or minors"; Copy Safety Notes proactively exclude complete/immediate deletion, on-device/zero-knowledge, auto face-blur, retailer-partnership/guaranteed-checkout, teen/family/13+/16+, and no-training/no-retention/ZDR claims. No roadmap claims.
- **Reviewer notes:** 18+, request-based deletion, "no facial recognition, biometric identification, or person identification," provider keys not exposed in client.
- **Store assets checklist:** versionCode 5 / 1.0.0 / `com.kscanai.app` and production EAS = store/app-bundle confirmed; URLs verified 200; 18+ screenshot guidance.

No overclaims; no child/family/teen positioning; no ZDR/no-retention reviewer claims. Internally consistent with the Data Safety packet and current code.

## 13. Visual asset freshness audit

No committed store assets exist (Glob for `fastlane`/`store-assets`/screenshot dirs → none; checklist graphic-asset boxes all unchecked; "screenshot creation deferred to operator/designer"). Therefore there are **no stale committed screenshots** showing the old palette — but screenshots must be **created from the new V6.2 pearl/plum/aubergine theme** before public submission, following the 18+/no-minors guidance. **P1 — pending asset.** (Untracked `qa/**` PNGs are QA runtime captures, not store assets.)

## 14. Account deletion audit

In-app deletion is present and **functional in path**: `app/privacy.tsx` → `submitAccountDeletionRequest(supabase, session)`, a confirmation modal ("Request account deletion?"), pending-state handling, and sign-out. Copy is correctly request-based: "reviewed and processed through our account lifecycle workflow, generally within 30 days, subject to legal, security, and operational requirements." No instant/complete-automated-deletion overclaim. Public URL `https://kscan.app/legal/delete-account` carried in QA/store docs (verified 200). Runtime confirmation of the full flow (and storage-object cleanup caveat) is a P1 follow-up.

## 15. Target audience / Families audit

**18+ only**, consistent across app copy, store listing, reviewer notes, assets checklist, Data Safety packet, and live Privacy Notice. Families/Designed-for-Children **not** selected. No 13–15 / 16–17 positioning. No child-directed copy. No ads.

## 16. EAS build configuration audit

`eas.json` `production` profile: `distribution: store`, `android.buildType: app-bundle` (AAB), `ios.buildConfiguration: Release`, `submit.production` present. **Correctly configured for Play store AAB submission.** `preview`/`development` profiles are internal/APK (not submission profiles — not blockers). `eas.json` embeds the Supabase **anon (publishable)** key and API URL in `env` — acceptable (the anon key is designed for client exposure; it is not the `service_role` secret). Release signing is delegated to EAS credentials (not in repo).

## 17. Build readiness / AAB gate audit

- Working tree clean (owner PowerShell); `tsc` exit 0; no manifest/config contradiction; version identity aligned; no dependency/native/prebuild changes; no secrets exposed in committed code.
- The "minor UX/UI polish" precondition is satisfied (theme merged at `b54f0f7`).
- **AAB build remains owner-gated.** Merged manifest must still be inspected at build time, and Play Console versionCode history must be confirmed by the owner before upload.

## 18. Safe fixes applied

- Created this fresh audit report (`qa/google-play-fresh-submission-audit-2026-06-13.md`) — Lane A.
- **No** code, metadata, permission, copy, or canonical-Data-Safety changes were required or made (nothing contradicted the established posture).
- Git staging/commit of this report is delegated to the owner in PowerShell (sandbox git is unreliable for this repo).

## 19. Detailed issue register

| ID | Sev | Area | File / Evidence | Issue | Impact | Fixed? | Fix / Recommendation | Blocks Console Entry? | Blocks AAB Build? | Blocks Internal Testing? | Blocks Final Submission? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| I1 | P1 | Provider | `.env.example` `USE_OPENROUTER=true`; no ZDR in code | Production image-routing value unprovable from repo (Gate C conservative) | Photos declared "shared"; could optimize to service-provider if `false` | No | Owner/dashboard confirm prod `USE_OPENROUTER`; conservative disclosure already covers entry | No | No | No | No |
| I2 | P1 | Provider | Packet §4 | Gemini paid-tier billing project not repo-verifiable | StyleChat "service-provider/not shared" depends on paid tier | No | Owner confirm Cloud Billing paid project for prod traffic | No | No | No | No |
| I3 | P1 | Infra | Packet §16 | Supabase DPA + Edge/log retention + prod debug flags off not verifiable | Service-provider framing + log hygiene | No | Owner confirm DPA, retention, `NODE_ENV=production`, debug flags off | No | No | No | No |
| I4 | P1 | Commerce | Packet §7; untracked `supabase/functions/search-vinted-secondhand/index.ts` | Which commerce/search providers ship in v1.0.0 + their terms | May require declaring search/activity "shared" | No | Owner confirm shipped commerce paths; declare accordingly | No | No | No | Conditional |
| I5 | P1 | Legal | Packet §12 | Full Privacy Policy PDF must name AI sub-processors + current date | Policy/Data-Safety completeness | No | Legal review of `/docs/kscan-privacy-policy.pdf` | No | No | No | Conditional |
| I6 | P1 | Data Safety | Packet §6 | OAuth scopes (Name stored?) + push-token (Device IDs) | Affects Name/Device-ID declarations | No | Owner confirm scopes + push usage | No | No | No | No |
| I7 | P1 | Deletion | Packet §10 | Storage-object + `style_chat_burst_usage` cleanup before "complete deletion" claim | Deletion-scope accuracy | No | Owner finalize cleanup + delete-account page caveat | No | No | No | No |
| I8 | P1 | Assets | Checklist §"Screenshots"; Glob → no store assets | Store screenshots not yet created; must reflect new V6.2 theme | Listing needs ≥2 current screenshots to publish | No | Designer captures screenshots from current theme; 18+/no-minors | No | No | No | **Yes** |
| I9 | P1 | Version | repo can't prove Console history | Highest uploaded Play Console versionCode unknown | If Console ≥ 5, AAB upload rejected | No | **PLAY CONSOLE OWNER CONFIRMATION REQUIRED**: confirm highest uploaded < 5 | No | Conditional | No | Conditional |
| I10 | P1 | Runtime | Packet §16; checklist | Physical-device + AAB/internal-track + a11y smoke deferred | Runtime regressions unverified | No | Run device/internal-track smoke at packaging | No | No | No | Conditional |
| I11 | P2 | Hygiene | Untracked `qa/**` build+screenshot artifacts, `supabase/.branches/` | Large untracked artifact set not gitignored | Repo clutter; `git add .` risk | No | Add `.gitignore` rules for `qa/` builds/screenshots + `supabase/.branches/` | No | No | No | No |
| I12 | P2 | Scope | Untracked `supabase/functions/search-vinted-secondhand/index.ts` | New Edge Function untracked, out of scope for theme work | Unclear whether it ships in v1.0.0 | No | Owner decide; do not fold into theme commit (links to I4) | No | No | No | No |
| I13 | P2 | Hygiene | Untracked root `release-candidate-audit-2026-06-09.md` | Stray older audit doc at repo root | Doc clutter | No | Move under `qa/` or remove; owner choice | No | No | No | No |
| I14 | Info | Config | `eas.json` env | Supabase **anon (publishable)** key embedded in eas.json | None — anon key is client-safe | n/a | No action; confirm it is anon, not `service_role` (it is) | No | No | No | No |

**No P0 issues.**

## 20. Remaining P0 blockers

**None.** Every flow has an accurate conservative Data Safety answer; manifest/permissions are consistent; no new ads/tracking/AD_ID/location/audio/children risk; no roadmap-only features presented as live; privacy/terms/deletion URLs consistent; version identity submission-ready; `tsc` clean; tree clean; no conflict markers.

## 21. Remaining P1 follow-ups

I1–I10 above. The most impactful for *public* submission: **I8** (capture screenshots from the new theme) and **I9** (confirm Play Console versionCode history < 5). The remainder are owner/provider/legal confirmations already covered by conservative disclosure for Play Console entry.

## 22. Remaining P2 cleanup

I11–I13: gitignore untracked QA/build artifacts and `supabase/.branches/`; decide scope of the untracked `search-vinted-secondhand` Edge Function; relocate/remove the stray root audit doc. Optional: a `.gitattributes` (`* text=auto eol=lf`, `*.bat/*.cmd/*.ps1 eol=crlf`, binary rules) would prevent cross-environment line-ending noise — low priority since the real Windows tree is clean.

## 23. Final readiness decision

```
Google Submission Fresh Audit Status:  PASS WITH NOTES
Play Console Entry Ready:               YES
AAB Build Gate:                         REPO-READY / PENDING OWNER
Minor UX/UI Polish Ready:               YES  (V6 theme merged at b54f0f7; tsc clean; tree clean)
Submission Ready:                       PENDING OWNER
Reason: The V6 theme merge is visual-only and preserves the Prompt 12/13 submission posture.
No P0 blockers. Canonical Data Safety packet still valid and permission-consistent. No new
ads/tracking/AD_ID/location/audio/children risk. Remaining items are P1 confirmations/assets
(notably store screenshots from the new theme and Play Console versionCode history) and P2 hygiene.
```

## 24. Next recommended action

1. **Owner:** stage + commit this audit (exact path, no `git add .`):
   `git add qa/google-play-fresh-submission-audit-2026-06-13.md`
   `git commit -m "docs(play): add fresh submission audit"`
2. Confirm Play Console highest uploaded versionCode < 5 (I9).
3. Have a designer capture store screenshots from the current V6.2 theme (I8).
4. Work the remaining P1 provider/legal/commerce confirmations (I1–I7) as time allows — none block Console entry.
5. Build/upload the AAB only after owner go/no-go (out of scope here).

---

**Cross-reference:** supersedes the readiness snapshot in
`qa/google-play-submission-readiness-lock-2026-06-12.md` §13 for the post-theme-merge state
(the "minor UX/UI polish" precondition is now satisfied at `b54f0f7`).
