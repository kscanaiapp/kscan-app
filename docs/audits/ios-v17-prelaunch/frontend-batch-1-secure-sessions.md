# iOS v17 Frontend — Batch 1: Secure Sessions

**Starting checkpoint:** `13e48fc` (backend-core), branch `integration/ios-v17-prelaunch-complete`.
**Date:** 2026-07-24. No build, no backend deploy, `ios.buildNumber` unchanged ("16").

## Source provenance

| Item | Value |
|---|---|
| Donor branch | `codex/integrated-validation-session-elise-v2` |
| Donor commit | `5987f47794e6fc9fba01015d82df1fc61f98d6c2` ("fix(auth): apply session repair to complete baseline") |
| Merge base w/ checkpoint | `5706556` (2026-07-12) |
| Rejected donor | `codex/integrated-validation-session-elise` (`0bd4214`) |

### Why 5987f47 (narrowest accepted source)
- `0bd4214` is a **stale validation branch** — it bundles the session repair with unrelated scanner fixes + avatar-foundation work (it descends through `0c9086a`, the old submission line). The charter forbids merging a whole stale validation branch, so it was rejected.
- `5987f47` is a **single clean commit** (the session repair only) → narrowest accepted source. Both donors carry an **identical** `secureSessionStorage.ts`.

### Superseded source (NOT applied)
- **`contexts/AuthSessionContext.tsx`** — the checkpoint (v15) version **supersedes** the donor's. v15 already implements: transient-failure tolerance (no sign-out on transient storage/network errors), comprehensive account-switch isolation (`resetActorScopedRuntimeState`: attachments, visual context + sanitized-image cleanup, handoff, greeting, stylist identity/voice), generation + actor-boundary guards, handled-stale-refresh-token recovery, and `startAutoRefresh()`. The donor's simpler `getSession()` block + `resetAttachmentStore()`-only reset are strictly less capable. **Left unchanged.**
- Donor's `processLock` + direct `storage: secureSessionStorage` in `supabaseClient.ts` — superseded by v15's `createAuthBootstrapStorage` bootstrap-refresh architecture. Not applied.

## Integration decisions (files changed)

| File | Decision |
|---|---|
| `services/secureSessionStorage.ts` | **Added** (new, from `5987f47`): keychain (`expo-secure-store`) on native, AsyncStorage on web, **write-before-remove** legacy migration. |
| `services/supabaseClient.ts` | Kept v15's `createAuthBootstrapStorage` bootstrap system; **swapped its backing** `storage: AsyncStorage` → `storage: secureSessionStorage`. Removed now-unused `AsyncStorage` import. (Best of both: v15 bootstrap-refresh + secure keychain backing.) |
| `app/auth/update-password.tsx` | Applied donor version (checkpoint == donor base): password change now `signOut({ scope: 'global' })` → revokes refresh on all devices (req. 12). |
| `services/style-chat/providers/edgeStyleChatProvider.ts` | `TIMEOUT_MS` 20s → **30s** to cover two sequential ~12s Gemini calls (frozen-map primary→fallback / incomplete-reply retry) (req. 16). Kept v15's `ELISE_VISUAL_COLLECTION_CONTRACT_VERSION`. |
| `package.json` / `package-lock.json` | Added `expo-secure-store@15.0.8` (imported by `secureSessionStorage.ts`); `npm install` added exactly 1 package, lock diff scoped to that package. |

### Conflicts resolved (3-way, donor authored against older base than v15)
- `supabaseClient.ts` (2) — resolved by keeping v15 architecture + secure backing (above).
- `AuthSessionContext.tsx` (1) — resolved as **superseded** (kept v15).
- `edgeStyleChatProvider.ts` (1) — kept v15 contract-version line + donor 30s timeout.

## Requirement coverage
Native secure persistence ✓ · safe AsyncStorage migration ✓ (+ new regression test) · foreground/background + silent refresh ✓ (v15 `startAutoRefresh` + bootstrap) · no sign-out on transient Scanner/TextScan/Elise/network failure ✓ (v15 tolerance, preserved) · explicit logout cleanup ✓ · password-change global revocation ✓ · account-switch isolation ✓ (v15 `resetActorScopedRuntimeState`) · pending-deletion blocked / restored allowed ✓ (routingGuard + backend guard, unchanged) · Elise sequential-attempt timeout ✓ (30s) · no unrestricted 30-day token ✓ (autoRefresh managed) · no weakening of auth/RLS/account-active ✓.

## Defects
- **B1-D01 (P3, gap):** `services/secureSessionStorage.ts` had **no** regression coverage. Root cause: new file added without tests. Repair: added `__tests__/secureSessionStorage.test.js` (7 cases) incl. the security-critical **migration-failure-preserves-legacy** invariant (a keystore-write failure must not delete a still-valid legacy session → no silent sign-out). Status: FIXED.

## Verification
- **Unit** (focused): `node --test` secureSessionStorage, passwordReset, routingGuard, authEnvironment, authDeepLink → **43/43 pass**.
- **Integration** (multi-module session lifecycle): authBootstrapStability, authSessionBootstrap, oauthCallbackSession, oauthCallback, welcomeRouting → **60/60 pass**.
- **Full Node regression:** **99/99 files pass, 0 fail**.
- **TypeScript:** `npx tsc --noEmit` → 0 errors.
- **diff --check:** clean. **buildNumber:** "16" unchanged. **Backend deployed:** NO. **iOS build:** NO.
