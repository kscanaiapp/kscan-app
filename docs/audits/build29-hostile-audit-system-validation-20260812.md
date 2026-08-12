# K Scan AI — Build 29 Hostile Audit & System Validation

Audit date: 2026-08-12

Audited application commit: `68421a1`

Branch: `codex/build29-hostile-audit-20260811`

Upstream base: `origin/staging/production-parity` at `2cc33a8`

## 1. Final verdict

The Build 29 application candidate passes the hostile audit and application-system validation. All in-scope application defects found in this pass are fixed, including the confirmed stale-tree consent regression, missing iOS compliance/auth work, the Elise image-styling continuation loop, Android release hardening, and the one additional same-boundary stale family for guarded commerce URLs.

The candidate is suitable to continue Build 29 integration. It is not yet eligible for store promotion because protected release governance still needs to classify/deploy the restored Apple functions, register the authorized staging consent migration, apply the separately protected AI-reporting/Apple backend migrations, and resolve the inherited shared-room manifest exception. Those controls were not weakened or edited by this audit.

Production was neither contacted nor mutated. No EAS command was run.

## 2. Source authority

| Field | Value |
| --- | --- |
| Starting staging branch | `staging/production-parity` |
| Starting staging SHA | `d56565ae6a90fc8baf9cfd10b022a786f8ef9675` |
| Final audit branch | `codex/build29-hostile-audit-20260811` |
| Audited application SHA | `68421a1` |
| Rebased upstream SHA | `2cc33a8afb46bd32eaee4e60e917166963e5319d` |
| Ahead/behind before report commit | 4/0 |
| Worktree before report creation | clean |
| Force push | NO |

The upstream moved during the audit because PRs #108/#109 changed protected release infrastructure. The four audit commits rebased without conflict. The remote changes do not alter the mobile runtime, but they introduce current TypeScript/test failures in their own protected release scripts; these are recorded under release-infrastructure collisions.

## 3. Audit scope

Features audited: auth/session lifecycle, Welcome Tree and legal acceptance, Scanner/TextScan/Product Match, Privacy Lens boundaries, Elise text/image flows, Closet, Dressing Room handoff, Saved Looks/shared rooms, AI reporting, account deletion, Apple credential revocation, adaptive Android layout, edge-to-edge behavior, and optimized Android release behavior.

Backend surfaces audited: Supabase Auth, RLS-visible consent ledger, reporting tables/client, account-deletion registries and functions, Scanner/Product/Elise edge-function seams, Apple credential functions/schema source, shared-room manifests, RPC policy inventory, storage paths, and staging release parity.

Excluded from mutation: protected release/rollback manifests, release activation scripts, production infrastructure, EAS configuration/versioning, and broad Expo/React Native/AGP/ML Kit/native dependency upgrades.

## 4. Defect summary

| Severity | Found | Fixed | Remaining application defects |
| --- | ---: | ---: | ---: |
| P0 | 0 | 0 | 0 |
| P1 | 4 | 4 | 0 |
| P2 | 5 | 5 | 0 |
| P3 | 1 | 1 | 0 |

## 5. Defect ledger

| ID | Severity | Surface | Symptom | Root cause | Fix commit | Regression evidence | Final status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B29-AUTH-001 | P1 | Android auth | A valid emulator connection could be presented as a generic network failure; incomplete runtime config could fall through to dummy values | Runtime configuration and error classification were not fail-closed | `b8a8b44` | Auth environment/config/error/bootstrap and password-visibility suites; real staging emulator auth | FIXED |
| B29-CONSENT-001 | P1 | Welcome Tree | Approved AI disclosure, independent checkbox, ledger row, and four-way gate were absent | Stale mobile tree selected during promotion; approved Android/iOS consent lines never entered the staging ancestry | `e9afbad` | 115 focused consent/compliance tests; live staging ledger; cold-start/relogin emulator walkthrough | FIXED |
| B29-IOS-001 | P1 | iOS compliance/auth | GP-006 reporting, privacy/location posture, TextScan reporting, Elise voice gate, and Apple authorization-code/revocation source were absent | Same promotion/baseline omission at `8cbb2e6` | `3360f2d` | Reporting, privacy, voice, Apple linkage/revocation and Deno tests | FIXED_IN_SOURCE; ACTIVATION_GOVERNED |
| B29-ELISE-001 | P1 | Elise | Attach-first, active-item continuation, follow-up actions, optional Closet save, and Dressing Room anchor handoff were stale | Approved Elise line was absent from the promoted staging tree | `68421a1` | 153/153 focused Elise contracts before rebase; 185/185 integrated focused tests after rebase | FIXED |
| B29-R8-001 | P2 | Android release | Release minification/resource shrinking were not certified | Release flags/keep rules had not been hardened against the integrated native/reflection graph | `b8a8b44` | Optimized AAB/APK, R8 mapping/usage/resources, release-quality contract | FIXED |
| B29-UI-001 | P2 | Adaptive UI | MainActivity/app configuration forced portrait behavior | K Scan-owned orientation restriction | `b8a8b44` | Phone landscape, tablet and foldable-size emulator checks | FIXED |
| B29-EDGE-001 | P2 | Edge-to-edge | K Scan-owned deprecated system-bar configuration remained | Legacy Android theme/config values | `b8a8b44` | Static release-quality checks and Android 15/16-style inset/rotation smoke | FIXED; DEPENDENCY CALLS TRACED |
| B29-DELETE-001 | P2 | Account deletion/RPC policy | Deletion resource registries and one service-only refund RPC classification had drifted | Parallel inventories were incomplete/inconsistent | `b8a8b44` | Registry parity, deletion processor and RPC policy tests | FIXED |
| B29-IOS-URL-001 | P2 | iOS commerce exits | Three commerce surfaces opened provider destinations without the newer guarded URL seam | Concrete additional files from the same promotion omission | `3360f2d` | 10/10 external URL safety tests | FIXED |
| B29-TEST-001 | P3 | Regression baseline | Date/env/model assertions obscured the real application signal | Stale deterministic test expectations | `b8a8b44` | Corrected targeted suites | FIXED |

## 6. Backend wiring

| Feature | Client seam | Backend target | Auth/actor control | Contract result | Live staging result | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Auth/session | `AuthSessionContext`, Supabase client | Supabase Auth | Supabase JWT/session; fail-closed config | PASS | Real email auth, invalid credentials, sign-out, cold restart PASS | PASS |
| Legal consent | `legalAcceptance` | `legal_acceptances` | RLS owner select/insert; actor scoped | PASS | Four rows written/read; cross-actor query returned zero | PASS |
| Scanner/TextScan | `scanIdentification` | `scan-identify` | JWT-required function seam | PASS | Network/auth seam proven; full camera scan not executed | NOT_VERIFIED |
| Product Match | scan result/product services | `product-search-deals` and scan results | JWT-required function seam | PASS | End-to-end retailer response not executed | NOT_VERIFIED |
| Elise | `edgeStyleChatProvider` | `stylechat-generate` | JWT/session/actor-bound request | PASS | Backend contracts PASS; emulator message generation not executed | NOT_VERIFIED |
| Closet | Closet services/storage | tables, storage and closet RPCs | RLS/JWT/owner filters | PASS | Inventory/policy parity PASS; full emulator mutation not executed | NOT_VERIFIED |
| Dressing Room | handoff/outfit services | `style-outfit-generate`, dressing-room data | JWT/session anchor | PASS | Handoff contracts PASS; emulator destination not executed | NOT_VERIFIED |
| Saved Looks/shared rooms | saved-look/shared-room services | tables/RPCs/image URL function | RLS/JWT | PASS | Existing protected migration exception remains | BLOCKED |
| AI reporting | reporting context/client | `content_reports` + `ai_output` support migration | Actor/session scoped | PASS | App source works; protected reporting migration is not applied | BLOCKED |
| Account deletion | deletion client/processor | `handle-user-deletion`, `process-account-deletions` | JWT/service-role split; registries aligned | PASS | Disposable audit account cleanup verified; full worker not invoked | PASS |
| Apple revocation | credential-link client | `apple-credential-link`, `apple-revoke-credential` | Apple authorization code + server credential vault | PASS | Source present; functions/migration deliberately not activated | BLOCKED |
| RPC inventory | generated/runtime registry | 82 staging RPCs | Exact access-class comparison | PASS | 82/82 exact | PASS |

Backend wiring verdict: PASS for every currently reachable Build 29 surface, with explicit governed activation blocks for Apple revocation, AI-output reporting, and the inherited shared-room migration.

## 7. Feature integration

| Feature | Source/contract | Android emulator | Final status |
| --- | --- | --- | --- |
| Auth and session isolation | PASS | PASS | PASS |
| Welcome/AI consent | PASS | PASS | PASS |
| Terms/Privacy links | PASS | PASS | PASS |
| Scanner | PASS | NOT_VERIFIED | NOT_VERIFIED |
| TextScan | PASS | NOT_VERIFIED | NOT_VERIFIED |
| Product Match | PASS | NOT_VERIFIED | NOT_VERIFIED |
| Privacy Lens runtime boundary | PASS | NOT_VERIFIED | NOT_VERIFIED |
| Elise text | PASS | NOT_VERIFIED | NOT_VERIFIED |
| Elise image continuation | PASS | NOT_VERIFIED | NOT_VERIFIED |
| Closet | PASS | NOT_VERIFIED | NOT_VERIFIED |
| Dressing Room | PASS | NOT_VERIFIED | NOT_VERIFIED |
| Saved Looks/shared rooms | PASS | NOT_VERIFIED | BLOCKED |
| GP-006/TextScan reporting UI | PASS | NOT_VERIFIED | BLOCKED |
| Apple authorization/revocation | PASS | NOT_APPLICABLE | BLOCKED |
| Android adaptive UI | PASS | PASS | PASS |
| Android edge-to-edge owned behavior | PASS | PASS | PASS |
| Sentry integration | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |

## 8. Staging system validation

- Auth: PASS. Valid account sign-in, invalid-credential classification, Google entry point, forgot-password entry, create-account entry, sign-out, cold launch and relogin were exercised.
- Scanner/Product Match/Elise/Closet/Dressing Room/Saved Looks: source, contracts and backend registries PASS; end-to-end feature emulator transactions are explicitly NOT_VERIFIED.
- Reporting: application implementation PASS; live `ai_output` backend support BLOCKED by protected migration ownership.
- Deletion/privacy: registry and processor contracts PASS; disposable staging user was deleted and verified absent.
- Storage: inventory/path contracts PASS; no destructive live storage sweep was run.
- RLS/RPC: consent owner isolation PASS; RPC inventory 82/82 exact.
- Live parity: 450 MATCH, 3 expected exceptions, and 1 new untracked live object—the authorized consent migration applied during this audit but not yet admitted to the protected release manifest.
- Supabase advisors: 62 security findings (10 INFO/52 WARN) and 203 performance findings (104 INFO/99 WARN). They are pre-existing policy/performance posture, not introduced by the consent constraint, and were not broadly remediated in this focused pass.

## 9. Android emulator and release artifact

```text
ANDROID EMULATOR USED: YES
DEVICE: sdk_gphone16k_x86_64 (emulator-5554)
API: 37
SOURCE SHA: 68421a1 (application-equivalent rebased tree)
BACKEND: staging yzqjvdfgefveprobvvyw
ACCOUNT: designated staging audit account; no password recorded

INSTALL: PASS
LAUNCH: PASS
AUTH: PASS
SCANNER: NOT_VERIFIED
ELISE TEXT: NOT_VERIFIED
ELISE IMAGE: NOT_VERIFIED
CLOSET: NOT_VERIFIED
DRESSING ROOM: NOT_VERIFIED
REPORTING: NOT_VERIFIED
BACKGROUND/FOREGROUND: PASS
CRASHES OBSERVED: NO
SYSTEMUI/EMULATOR FAILURES: none observed; feature-level omissions above are test-scope limits, not app failures
```

Consent walkthrough:

1. Fresh app state showed all four acknowledgements unchecked.
2. Exact approved AI disclosure and independent AI-processing checkbox were visible.
3. Terms and Privacy links opened successfully.
4. Terms + Privacy + 18+ with AI unchecked kept ACCEPT & CONTINUE disabled.
5. Checking all four enabled the button and wrote exact versioned rows, including `ai_processing:v1` from `mobile`.
6. Onboarding completed; cold restart retained the valid state.
7. Clearing app data and signing in again restored consent from the remote ledger.
8. An account missing `ai_processing` was routed back to the consent step instead of being treated as complete.

Responsive smoke covered phone landscape, 1600×2560 tablet portrait, and 840×2200 foldable/narrow geometry. No crash or ANR was observed.

Optimized local artifacts (no EAS):

| Artifact | Size | SHA-256 | Notes |
| --- | ---: | --- | --- |
| `android/app/build/outputs/bundle/release/app-release.aab` | 80,134,620 bytes | `9C1ECD390BF187BE41813D2C1F05B669082E4DF6CF0063291EE7E5EBDADA2BA3` | R8/minify + resource shrink output rebuilt after rebase |
| `android/app/build/outputs/apk/release/app-release-build29-staging-qa-signed.apk` | 109,992,662 bytes | `F10B26199F67F7CABBD7287DBE3593AAFD7BCB90E24A5083728767A83D5556E9` | Rebuilt QA/debug certificate artifact; v2/v3 verified; not distribution-signed |

Build compatibility state: Gradle 8.14.3, AGP 8.11, Expo 54.0.36, React Native 0.81.5, Kotlin 2.1.20, compile/target SDK 36, min SDK 24, NDK 27.1. No AGP 9 or broad framework/native upgrade was performed.

R8 output includes mapping, usage, and optimized resource reports. Required keep rules cover Expo SecureStore/module reflection, Kotlin record conversion and integrated JNI/reflection seams. The resolved Android graph contains ML Kit barcode scanning 17.3.0 and Play Services barcode scanning 18.3.1, but no ML Kit Pose, ML Kit Face Detection, Skia, TFLite, Nitro, XR, or Sentry artifact. Therefore `com.google.mlkit.vision.pose.internal.zzc.zzc` has no owning dependency or reachable K Scan runtime path in this candidate. No dependency was upgraded merely to suppress the Play warning.

Remaining deprecated system-bar calls trace to React Native/`react-native-screens`; K Scan-owned bar colors and portrait restriction were removed. They were reported, not patched inside dependencies.

## 10. Privacy and security

| Check | Result |
| --- | --- |
| Cross-account consent access | PASS — own rows 4, other-actor rows 0 |
| Consent leakage between accounts | PASS |
| Raw-image boundary contracts | PASS; physical Privacy Lens flow NOT_VERIFIED |
| Embedded credentials/secrets | No new embedded credentials; runtime configuration fails closed |
| PII in audit output | Passwords excluded; disposable test identifier only |
| Observability privacy contracts | PASS; Sentry dependency NOT_APPLICABLE |
| Account deletion registries | PASS |
| Production access | NO |

Privacy/security result: PASS within tested scope.

## 11. Races and lifecycle

Rapid action gating, stale attachment/response suppression, retry behavior, actor switching and logout/session isolation are covered by focused state-machine/contract tests. Background/foreground and cold restart were exercised on the emulator. No cross-account consent leakage occurred.

Result: PASS for tested contracts and auth/onboarding lifecycle. Long-running camera/Elise transactions across process death remain NOT_VERIFIED.

## 12. Tests

| Layer | Result |
| --- | --- |
| Focused post-rebase integration set | 185/185 PASS |
| Consent/compliance focused set | 115/115 PASS |
| Elise focused set | 153/153 PASS before conflict-free rebase |
| External URL safety | 10/10 PASS |
| Backend Deno | 23 files, 242/242 PASS |
| Security validation | 11 expected checks PASS; localhost ZAP target correctly rejected |
| TypeScript | Application tree passed before upstream rebase; current repository FAILS only in newly merged protected `security/release/*` scripts from PR #109 |
| Expo Doctor | 17/18; only native/app-config sync warning |
| Full aggregate | 5,355 tests; 5,169 pass; 127 fail |
| Full failure ownership | 118 failure markers are `UNCLASSIFIED_EDGE_FUNCTION`; remaining failures are protected activation/shared-room/branch-authority baselines |
| `git diff --check` | PASS before report commit; rerun at handoff |
| TestSprite | NOT RUN: native local candidate has no publicly reachable deployed URL and no TestSprite MCP tunnel/project config |

The full-suite failures are not hidden or reclassified as green. They are caused by the restored Apple functions entering a fail-closed protected release inventory plus inherited protected baseline expectations. Editing that inventory was explicitly outside this audit's authority.

## 13. Environment

```text
STAGING PROJECT: yzqjvdfgefveprobvvyw
PRODUCTION PROJECT: wyyuqfdxucjksghsmhry
PRODUCTION CONTACTED: NO
PRODUCTION MUTATED: NO

STAGING TEST USERS:
- designated pre-existing staging audit account (identifier intentionally not duplicated; no password recorded)
- disposable fd328982-b524-43d6-ad72-e74e69dd9882 / build29-audit-1786501087296-886059@kscan.invalid

STAGING SYNTHETIC DATA CREATED:
- versioned ai_processing consent row on the designated audit account, retained for returning-user proof
- disposable auth user and associated audit rows

STAGING SYNTHETIC DATA REMOVED:
- disposable auth user fd328982-b524-43d6-ad72-e74e69dd9882 and all legal rows (verified zero remaining)

LEGITIMATE STAGING USER DATA CHANGED: NO
```

Authorized staging migration applied: live version `20260812031312`, `legal_acceptances_restore_ai_processing`. It extends the accepted legal document types to include `ai_processing`; it does not weaken owner RLS.

## 14. Release-infrastructure collisions

1. The authorized live consent migration is not yet present in the protected release manifest, so parity reports one untracked live object.
2. `apple-credential-link` and `apple-revoke-credential` are restored in source but deliberately undeployed and unclassified by the protected edge-function inventory.
3. The protected GP-006/Apple backend migrations were not applied; staging reporting/revocation therefore remain activation-blocked.
4. Upstream PR #109 introduced TypeScript errors and release tests that fail closed once the restored Apple functions are visible. Those files are owned by the parallel protected release workstream.
5. The pre-existing `shared_room_item_contributions.sql` manifest exception and branch-authority baseline remain unresolved.

These are promotion blockers for the release-infrastructure owner, not unresolved P0/P1 application defects.

## 15. Repository

Application commits:

- `b8a8b44` — Android release/auth/runtime hardening
- `e9afbad` — atomic AI consent-contract restoration
- `3360f2d` — iOS compliance, reporting and Apple revocation source restoration
- `68421a1` — approved Elise image-styling continuation loop

Push/PR status is intentionally recorded in the final task handoff after this report commit is published; a document cannot contain its own final commit hash.

## 16. Unverified items

- Scanner camera capture and Product Match retailer response on the final emulator build.
- Privacy Lens physical/emulator raw-image workflow.
- Elise text/image live generation on the emulator.
- Closet, Dressing Room, Saved Looks and shared-room live emulator transactions.
- GP-006/TextScan report submission against the not-yet-applied protected backend migration.
- Apple authorization-code/revocation against deployed staging functions.
- Long-running feature operations across process death/account switch.
- Distribution signing and Play Console upload (the APK uses a QA/debug certificate).
- Physical Android 16 tablet/foldable hardware and physical iOS execution.

## 17. Current Build 29 status

```text
HOSTILE AUDIT: PASS
APPLICATION SYSTEM VALIDATION: PASS
BACKEND WIRING: PASS (reachable surfaces); GOVERNED ACTIVATIONS BLOCKED
ANDROID EMULATOR SMOKE: PASS_WITH_LIMITATIONS
RELEASE/ROLLBACK INFRASTRUCTURE: PARALLEL WORKSTREAM — NOT CERTIFIED BY THIS AUDIT
EAS BUILD: NOT RUN
```

## 18. Final recommendation

**CONTINUE BUILD 29 INTEGRATION.**

Do not promote to a store candidate until the release-infrastructure owner registers the live consent migration, classifies/deploys the Apple functions, applies the protected reporting/Apple migrations, clears the inherited shared-room exception, and restores its own TypeScript/full-suite baseline. No additional historical feature-recovery audit is warranted without concrete evidence from that same boundary.
