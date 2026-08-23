# K Scan AI — Meta Client Runtime Validation

Date: 2026-08-23

## Executive Verdict

**PHASE NOT ENTERED — ENTRY GATE 2 (META DAT PACKAGE ACCESS) UNMET.**

The addendum requires all three entry gates before this phase may start. Two are
now satisfied; one is not, and it is the one the whole phase is built on.

| Entry gate | State |
|---|---|
| 1. ADB target | **MET** — `emulator-5554` (Pixel_8_Pro AVD), `sys.boot_completed=1` |
| 2. Meta DAT package access | **NOT MET** — `read:packages` absent; `mwdat-*` resolves `401` |
| 3. Approved staging QA account | **MET** — disposable staging user created through the supported signup flow |

Because gate 2 is unmet, no DAT resolution, DAT-enabled compile, PhotoData
verification, MockDeviceKit exercise, capability-matrix run, or device/mock event
runtime test was performed. **None is claimed.** Per the addendum, only work that
cannot create false runtime evidence was carried out, and it is recorded below
under its true, narrower scope.

Full blocker analysis: `META_BLOCKER_CLOSURE_AND_RELEASE_GATE_REPORT.md`.
Assumed DAT surface and the verification checklist: `docs/META_DAT_API_SIGNATURES.md`.

## The blocking gate, precisely

| Probe | Result |
|---|---|
| `mwdat-core-0.9.0.pom`, no credential | `401` |
| Same, authenticated as `kscanaiapp` | **`401`** |
| Token scopes | `gist, read:org, repo, workflow` — no `read:packages` |
| `/user/packages?package_type=maven` | `"You need at least read:packages scope to list packages."` |
| `/repos/facebook/meta-wearables-dat-android` | `200`, **`visibility=public`** |
| Control `/user` | `200` (`kscanaiapp`) |

The upstream repository is public, so this is not a Meta entitlement or partner
approval gate. GitHub Packages requires an authenticated Maven request even for
public packages. One interactive command clears it:

```
gh auth refresh -h github.com -s read:packages
```

## Environment

| Item | Value |
|---|---|
| Device / Emulator | `emulator-5554`, Pixel_8_Pro AVD (software GPU) |
| App build | `:app:assembleDebug`, `BUILD SUCCESSFUL in 5m 18s` |
| APK SHA-256 | `c20dfd470c674c16bd26ce5b37d6ad83411a7d688ce8e587b7306a14bf2b7830` |
| Source SHA | `f5eb3b8` |
| DAT version | **unresolved** — `kscan.mwdat.enabled` off (shipping default) |
| MockDeviceKit version | **unresolved** |
| Staging project | K Scan AI Staging `yzqjvdfgefveprobvvyw` |
| Test account type | Disposable staging-only QA user via supported self-signup |

## What WAS verified, at its true scope

### ADB runtime — flag-off build (`ADB RUNTIME VERIFIED`)

| Check | Result |
|---|---|
| Clean install | `Success` (streamed, 20 s) |
| Cold launch | `Status: ok`, `LaunchState: COLD`, `TotalTime: 13681 ms` |
| Process alive after 25 s | yes (pid 5997) |
| FATAL EXCEPTION / ANR / `signal 11` / `libc: Fatal` | none |
| Background → foreground × 3 | no crash |
| Rotation / activity recreation × 4 | no crash |
| Process restart (second cold launch) | `Status: ok`, `TotalTime: 4321 ms` |
| Duplicate-listener / leak signals for `com.kscanai.app` | none — the `leaked` lines in logcat belong to `com.android.systemui` and the emulator's `mapper.ranchu` |

This exercises the app with the Meta module in its **default flag-off** state. It
says nothing about DAT initialisation, capture, or glasses behaviour.

### Backend runtime — live staging (`LIVE STAGING VERIFIED`)

The backend half of the chain was fully exercised with real authentication, and
is reported in detail in the blocker-closure report:

- 23/23 authenticated wearable E2E: login → pair → session → result delivery → Save → Open → sign-out → revocation
- Stale revision rejected (`STALE_REVISION`), action conflict rejected (`ACTION_CONFLICT`), foreign session rejected (`SESSION_INVALID`), forged wearable token rejected
- Save idempotency proven at row level: 4 Save calls → **1** `saved_scans` row; cross-route (`wearable-save` ↔ `wearable-bridge`) → **1** row per result in both orders
- Raw imagery rejected inside a real session (`FORBIDDEN_CONTENT`)
- P2-06 oversized-body denial-of-wallet closed: 600 KB `413` in 0.47 s (was a ~160 s hang → 503)

The chain segment **device → capture → privacy** was *not* exercised, because it
is exactly the segment DAT provides.

### Artifact security (`PASS`)

Binary-safe APK scan, 0 hits across GitHub PAT patterns, `GITHUB_TOKEN`,
`read:packages`, `maven.pkg.github.com`, `mwdat-core`, `MockDeviceKit`,
`mockdevice`, the QA account markers, `SUPABASE_SERVICE_ROLE`, `sb_secret_` and
`SUPABASE_QA_PASSWORD`. Positive control (`supabase` → 67 occurrences) proves the
scanner works.

## Completion Matrix

| Gate | Result |
|---|---|
| ADB target | **PASS** |
| `read:packages` | **FAIL** |
| DAT resolution | **NOT RUN** |
| DAT-enabled compile | **NOT RUN** |
| PhotoData | **NOT VERIFIED** |
| MockDeviceKit | **NOT RUN** |
| staging auth | **PASS** |
| full scan E2E | **PARTIAL** — backend segment PASS; device → capture → privacy NOT RUN |
| privacy | **PARTIAL** — relay raw-content rejection PASS live; on-device capture path NOT RUN |
| displayless | **NOT RUN** |
| display-capable | **NOT RUN** |
| disconnect / reconnect | **NOT RUN** |
| cancellation | **NOT RUN** |
| stale result | **PASS** (backend `STALE_REVISION`, live) |
| Save | **PASS** (live, row-level) |
| Save idempotency | **PASS** (live, row-level, cross-route, both orders) |
| Open | **PASS** (live) |
| sign-out / revoke | **PASS** (live) |
| UI state consistency | **NOT RUN** — needs device/mock events |
| drift guard | **PASS** (20/20, negative-controlled) |
| APK security | **PASS** |
| physical hardware | **NOT RUN** — no device attached |

## Repairs Made

None in this phase — no runtime defect could be observed without DAT. Repairs
made in the blocker-closure phase (P2-05 schema, P2-06 body drain, drift guard)
are recorded in that report.

## Remaining Conditions

1. **`read:packages` on the `kscanaiapp` token** — one interactive command; unblocks gates 2 through 6 in a single step.
2. **Physical Meta Ray-Ban hardware** — MockDeviceKit, once available, still will not substitute for it.

## Recommendation

Do not re-attempt this phase until `read:packages` is granted. Everything it
would test either depends on DAT or has already been proven at the backend layer.
Grant the scope, then run the phase in one pass: DAT resolution → DAT-enabled
compile → SDK signature confirmation → PhotoData → MockDeviceKit → the capability
matrix and disconnect/reconnect/cancellation matrix on the ADB target.

## Final Verdict

**BLOCKED — REQUIRED EXTERNAL AUTHORITY (GITHUB PACKAGES `read:packages`)
PREVENTS ENTRY INTO META CLIENT RUNTIME VALIDATION.**

Mock and hardware evidence remain separate, unmade claims:
`MOCKDEVICEKIT VERIFIED` — **not run**.
`PHYSICAL META HARDWARE VERIFIED` — **not run**.
