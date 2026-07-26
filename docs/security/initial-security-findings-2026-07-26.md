# K Scan initial security findings — 2026-07-26

## Evidence labels

- **BASELINE ARTIFACTS PARSED**
- **FINDINGS CLASSIFIED**
- **REMEDIATION PRIORITIES PROPOSED**
- **MANUAL REVIEW REQUIRED**
- **COMMIT NOT CREATED**

## Scope and method

This triage analyzes GitHub Actions run `30218308958` from
`security/reports/baseline-2026-07-26`. The artifact summaries identify the scanned
repository commit as `5fda04be8f9dfea932ef0618cc9b00a92b74063c`, which is also the
current triage branch HEAD. JSON was the authoritative source. Markdown summaries and
text reports were used only to confirm scanner metadata and totals.

The five JSON reports parsed successfully:

1. `gitleaks-report-5/gitleaks-results.json`
2. `semgrep-report-5/semgrep-results.json`
3. `osv-report-5/osv-results.json`
4. `trivy-report-5/trivy-results.json`
5. `npm-audit-report-5/npm-audit.json`

The tables below preserve every scanner record. They do **not** represent 150 distinct
vulnerabilities. OSV and Trivy report the same 31 dependency/advisory pairs, and npm
audit aggregates substantially the same advisory set into 22 affected package nodes.
Static-analysis matches are review signals, not confirmed vulnerabilities.

## Executive summary

### Findings by scanner

| Scanner | Raw findings | Interpretation |
| --- | ---: | --- |
| Gitleaks | 24 | Historical secret-pattern matches; no genuine credential established |
| Semgrep | 40 | 40 code/config matches; 3 additional partial-parse warnings are coverage gaps, not findings |
| OSV-Scanner | 31 | Dependency/advisory/version pairs |
| Trivy | 33 | 31 dependency/advisory/version pairs plus 2 JWT-pattern matches |
| npm audit | 22 | Affected package nodes; aggregates multiple advisories per package |
| **Total scanner records** | **150** | Duplicate evidence across scanners; not 150 unique vulnerabilities |

### Findings by reported severity

Scanner-native `MODERATE` is normalized to `MEDIUM`; Semgrep `ERROR` and `WARNING`
remain separate because they are rule severities, not CVSS ratings. Gitleaks does not
include a severity field in its JSON.

| Severity | Count |
| --- | ---: |
| CRITICAL | 6 |
| HIGH | 35 |
| MEDIUM | 37 |
| LOW | 10 |
| ERROR (Semgrep) | 2 |
| WARNING (Semgrep) | 20 |
| INFO (Semgrep) | 16 |
| UNSPECIFIED (Gitleaks) | 24 |
| **Total** | **150** |

### Findings by runtime classification

| Runtime classification | Count | Notes |
| --- | ---: | --- |
| MOBILE RUNTIME | 3 | Production error logging and exported mobile activity review |
| BACKEND RUNTIME | 16 | Edge Function CORS/logging plus `body-parser` and `qs` evidence repeated by three dependency scanners |
| BUILD/CI | 70 | Compiler, Metro/Expo CLI, YAML/CSS, archive, and Xcode dependency paths |
| DEVELOPMENT ONLY | 20 | Development logs, React DevTools, Metro/dev WebSockets, and dev helpers |
| TEST ONLY | 9 | Synthetic tokens, auth-link tests, and fixed QA fixtures |
| FALSE POSITIVE | 29 | Public Supabase anon JWTs and code matches disproved by inspected context |
| UNVERIFIED | 3 | Wearable bridge/deployment behavior requires product/runtime confirmation |
| **Total** | **150** | |

## Top 10 actionable findings

| Priority | Finding | Why it matters | Proposed action | Owner | Target | Status |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Semgrep CORS: `kickscrew-sneaker-description` | No explicit caller authentication is visible in function code; wildcard browser access may expose provider quota/cost | Verify deployed JWT enforcement, require authenticated callers, add quota/rate controls, restrict origins | Backend/API | Next backend deployment | ACTION REQUIRED |
| 2 | Semgrep CORS: `nike-shoe-details` | Same provider-proxy abuse boundary as above | Verify deployed JWT enforcement and restrict origin/caller policy | Backend/API | Next backend deployment | ACTION REQUIRED |
| 3 | Semgrep CORS: `product-search-deals` | Wildcard origin fronts a paid-provider secret and upstream calls | Require verified user identity, quota requests, and restrict origins | Backend/API | Next backend deployment | ACTION REQUIRED |
| 4 | Semgrep CORS: `search-vinted-secondhand` | Wildcard origin may permit untrusted sites to consume an Apify-backed endpoint | Verify JWT deployment settings; add per-user quotas and origin allowlist | Backend/API | Next backend deployment | ACTION REQUIRED |
| 5 | Semgrep CORS: `tryon-clothes-pro` | Potential high-cost provider proxy lacks visible in-function auth | Require verified identity and quota before provider invocation | Backend/API | Next backend deployment | ACTION REQUIRED |
| 6 | Semgrep logging: `handle-user-deletion` | Raw failed-insert response text is written to backend logs and may contain privacy-request detail | Replace raw detail with bounded error code/category and review existing log retention | Privacy + Backend | Next backend deployment | INVESTIGATE |
| 7 | Semgrep logging: `src/utils/errorLogger.ts` | Arbitrary `error` and `extra` values can reach production console/error capture | Define a redacted error schema and prohibit tokens, image data, user content, and identifiers | Mobile + Privacy | Next mobile patch | INVESTIGATE |
| 8 | Wearable bridge message validation | Message payloads are cast to trusted result/state types without runtime schema or protocol/session validation | Add allowlisted message types, schema validation, version/session checks, and bounded errors | Wearables | Wearables pre-beta | INVESTIGATE |
| 9 | `tar@7.5.15` critical advisories | Expo CLI build path contains crafted-archive DoS/smuggling risks; not a shipped mobile runtime issue | Update transitive `tar` to at least `7.5.21` through a compatible Expo CLI update and rerun builds | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| 10 | `shell-quote@1.8.3` critical advisory | React DevTools path contains command-injection/DoS advisories; exposure is development-only | Update to at least `1.9.0` through `react-devtools-core`; keep dev services inaccessible externally | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |

## Genuine-secret candidates

No finding is confirmed as a genuine secret or credential.

- All 18 Gitleaks `eas.json` JWT findings occur under
  `EXPO_PUBLIC_SUPABASE_ANON_KEY`. Payload-only inspection of current and historical
  values established `role=anon` and `issuer=supabase`; no token value was printed.
- The two current Semgrep JWT matches and two Trivy JWT matches are the same public anon
  keys in the preview and production EAS profiles.
- The other six Gitleaks records are synthetic values or command placeholders in tests,
  QA documents, or a provider unit test.

These remain **FALSE POSITIVE CANDIDATE** records until a security owner confirms that
no service-role, provider, or user-session token is represented and that the public anon
project is the intended environment. If that confirmation fails, rotate the affected key
and review Supabase logs immediately.

## False-positive candidates

- 18 historical public Supabase anon JWT matches in `eas.json`.
- 4 current public anon JWT matches duplicated by Semgrep and Trivy.
- 6 Gitleaks test/document placeholder matches.
- Semgrep raw-image logging matches: one logs payload length only; the other logs a
  static compression-setting string.
- Semgrep token-logging matches: the script logs the words `Authorization`/`Bearer anon`
  and HTTP status, not the token value.
- Four auth-token-in-URL matches occur only in auth deep-link tests.
- The Express CSRF rule found no cookie/session authentication; the observed endpoint is
  a JSON API, so missing CSRF middleware alone does not establish exploitability.
- The main Android launcher activity must be exported for its launcher/deep-link intent
  filters; deep-link input validation still merits routine review.
- The QA fixture path is selected from a fixed in-file list, not user input.

## Dependency findings with available fixes

All 31 OSV dependency findings and all 31 matching Trivy dependency findings have a
published fixed version. npm audit reports a fix path for all 22 affected package nodes,
although several Expo aggregate fixes require a major SDK upgrade and must not be applied
blindly.

| Package / installed version | Advisory set | Minimum fixed version(s) represented in reports | Runtime assessment | Remediation note |
| --- | --- | --- | --- | --- |
| `@babel/core@7.29.0` | GHSA-4x5r-pxfx-6jf8 | `7.29.6` | BUILD/CI | Update compiler transitively; trusted-source builds reduce exposure |
| `body-parser@1.20.5` | GHSA-v422-hmwv-36x6 | `1.20.6` | BACKEND RUNTIME | Update Express chain; current `express.json({ limit: '15mb' })` is a valid limit |
| `brace-expansion@1.1.14/2.1.1/5.0.6` | GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg | `1.1.16`, `2.1.2`, `5.0.8` | BUILD/CI | Update all nested minimatch/glob trees |
| `js-yaml@3.14.2/4.1.1` | GHSA-52cp-r559-cp3m, GHSA-h67p-54hq-rp68 | `3.15.0`, `4.3.0` | BUILD/CI | Update configuration/test tool chains |
| `postcss@8.4.49` | 3 advisories | `8.5.18` | BUILD/CI | Update Metro/Expo chain and validate CSS/source-map builds |
| `qs@6.15.1` | GHSA-q8mj-m7cp-5q26 | `6.15.2` | BACKEND RUNTIME | Update Express chain; reported path is `stringify`, not observed request parsing |
| `shell-quote@1.8.3` | 2 advisories | `1.9.0` | DEVELOPMENT ONLY | Update React DevTools dependency |
| `tar@7.5.15` | 6 advisories | `7.5.21` | BUILD/CI | Update Expo CLI dependency and retest build/archive operations |
| `undici@6.26.0` | 4 advisories | `6.27.0` | BUILD/CI | Update Expo CLI network client |
| `uuid@7.0.3` | GHSA-w5hq-g745-h8pq | `11.1.1` | BUILD/CI | Update through `xcode`; major compatibility review required |
| `ws@6.2.3/7.5.10` | GHSA-96hv-2xvq-fx4p | `6.2.4`, `7.5.11` | DEVELOPMENT ONLY | Update Metro/dev middleware and do not expose dev servers publicly |

No Critical or High advisory was shown to execute in the shipped mobile JavaScript bundle
or the production Express request path. Critical/High records are currently build or
development paths; this lowers runtime exploitability but does not remove the update work.

## Manual code review required

1. Confirm deployed JWT verification and caller quotas for the five provider-backed Edge
   Functions marked **ACTION REQUIRED**.
2. Review wildcard CORS on the three privacy/account functions and authenticated
   `stylechat-generate`; authentication exists in code, but allowed-origin policy should
   be explicit.
3. Trace all callers of `logError()` and establish whether `error` or `extra` can contain
   tokens, user identifiers, product queries, or image-derived data.
4. Review `handle-user-deletion` failure responses and log retention for personal data.
5. Confirm wearable bridge deployment status and add runtime validation before beta use.
6. Validate mobile deep-link parsing before accepting the exported MainActivity match.
7. Confirm the glasses activity cannot process unsafe external intent extras.
8. Resolve Semgrep partial-parse coverage warnings in `app.js:500`, `app/privacy.tsx:338`,
   and `components/luxury/PrivacyFooter.tsx:79`; those files were not fully analyzed.
9. Verify the public Supabase anon project is intentional and protected by correct RLS;
   an anon key is public by design but safe use still depends on authorization policies.
10. Determine compatible Expo/React Native dependency updates instead of using forced
    major-version audit remediation.

## Recommended remediation sequence

1. **Identity/provider boundary:** verify Edge Function JWT enforcement, add per-user
   quotas, and restrict browser origins for provider-backed endpoints.
2. **Privacy logging:** remove raw backend failure details and impose structured redaction
   on production mobile error logging.
3. **Wearable trust boundary:** validate message schema, protocol version, session, and
   allowed commands.
4. **Backend CORS hardening:** replace wildcard origins on privacy/account/style-chat
   functions after validating mobile and web callers.
5. **Backend dependency patch:** update `body-parser` and `qs` with focused API regression
   tests.
6. **Build dependency patch:** update `tar`, `shell-quote`, `ws`, `brace-expansion`,
   `js-yaml`, `postcss`, `undici`, and Babel through compatible parent packages.
7. **Mobile intent review:** validate deep links and exported-activity input handling.
8. **Scanner/rule tuning:** suppress only evidence-backed false positives and preserve the
   rationale, owner, expiry, and retest date.
9. **Coverage repair:** address Semgrep partial parsing and rerun the baseline.

## Proposed owners and target releases

| Owner category | Scope | Proposed target |
| --- | --- | --- |
| Security/Platform | Secret classification, Supabase anon/RLS confirmation, scanner exceptions | Before accepting baseline |
| Backend/API | Edge Function auth, CORS, quotas, backend logging, `body-parser`/`qs` | Next backend deployment |
| Privacy | Deletion/export/correction logging and privacy boundary review | Next backend deployment |
| Mobile | Production error redaction and deep-link/activity review | Next mobile patch |
| Wearables | Bridge schema/session validation and glasses activity review | Wearables pre-beta |
| DevEx/Build | Expo/Metro/compiler/archive dependency upgrades | Next CI maintenance |
| QA | Regression coverage for auth, provider quota, build, and deep-link changes | Same release as owning remediation |

Target labels are proposals, not commitments. “Next mobile patch” and “next backend
deployment” should be mapped to the product release train by the respective owner.

## Detailed finding inventory

The following sections contain every raw scanner finding. `n/a` means the scanner record
does not concern a package or does not provide a fixed version.

### Gitleaks — 24 findings

| Scanner | Finding ID | Severity | File or component | Package / installed | Fixed | Runtime | Exploitability assessment | Recommended remediation | Owner | Target release | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gitleaks | `jwt / 2eba2e1:recentScans:346` | UNSPECIFIED | `__tests__/recentScansCommerceActualRoundTrip.test.js:346` | n/a | n/a | TEST ONLY | Synthetic test JWT; no production credential evidence | Keep obviously synthetic; add scoped test exclusion only with documented evidence | QA + Security | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `generic-api-key / 1c468fd:roomDeepLinks:13` | UNSPECIFIED | `__tests__/roomDeepLinks.test.js:13` | n/a | n/a | TEST ONLY | Synthetic room-token fixture | Preserve synthetic marker and document test-only exception | QA + Security | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `generic-api-key / fa09a82:roomDeepLinks:13` | UNSPECIFIED | `__tests__/roomDeepLinks.test.js:13` | n/a | n/a | TEST ONLY | Historical instance of the same synthetic fixture | Document fingerprint-specific test exception | QA + Security | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `curl-auth-header / 94a42b5:network-smoke:105` | UNSPECIFIED | `docs/PHASE_4_EMULATOR_DEBUG_NETWORK_SMOKE.md:105` | n/a | n/a | FALSE POSITIVE | Documentation command placeholder; no credential established | Keep placeholder notation explicit; document exception | Security/Docs | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 5984969:eas:14` | UNSPECIFIED | historical `eas.json:14` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT (`role=anon`) | Confirm intended project/RLS; retain fingerprint-specific exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 13bb8ea:eas:16` | UNSPECIFIED | historical `eas.json:16` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS; never treat as service-role secret | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 27ca505:eas:16` | UNSPECIFIED | historical `eas.json:16` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / c2fa5e6:eas:16` | UNSPECIFIED | historical `eas.json:16` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / f9e1539:eas:16` | UNSPECIFIED | historical `eas.json:16` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 13ef03d:eas:22` | UNSPECIFIED | historical `eas.json:22` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / dcc584f:eas:22` | UNSPECIFIED | historical `eas.json:22` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 5984969:eas:25` | UNSPECIFIED | historical `eas.json:25` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 27ca505:eas:28` | UNSPECIFIED | historical `eas.json:28` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 2627443:eas:34` | UNSPECIFIED | historical `eas.json:34` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / a99188d:eas:34` | UNSPECIFIED | historical `eas.json:34` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / c2fa5e6:eas:37` | UNSPECIFIED | historical `eas.json:37` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 13bb8ea:eas:38` | UNSPECIFIED | historical `eas.json:38` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 27ca505:eas:42` | UNSPECIFIED | historical `eas.json:42` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / dcc584f:eas:42` | UNSPECIFIED | historical `eas.json:42` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 13ef03d:eas:67` | UNSPECIFIED | historical `eas.json:67` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 5d65266:eas:70` | UNSPECIFIED | historical `eas.json:70` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `jwt / 13ef03d:eas:93` | UNSPECIFIED | historical `eas.json:93` | n/a | n/a | FALSE POSITIVE | Public Supabase anon JWT | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `generic-api-key / 7cee958:readiness-audit:258` | UNSPECIFIED | `qa/internal-testing-readiness-audit-2026-06-14.md:258` | n/a | n/a | FALSE POSITIVE | Supabase anon-key documentation context; no provider/service credential established | Keep placeholder/redaction explicit and document exception | Security/QA | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Gitleaks | `generic-api-key / 6383f86:elevenLabsClient.test:11` | UNSPECIFIED | `supabase/functions/stylist-speech/elevenLabsClient.test.ts:11` | n/a | n/a | TEST ONLY | Provider-client unit-test fixture | Ensure fixture stays synthetic and document exception | Backend QA + Security | Baseline acceptance | FALSE POSITIVE CANDIDATE |

### Semgrep — 40 findings

| Scanner | Finding ID | Severity | File or component | Package / installed | Fixed | Runtime | Exploitability assessment | Recommended remediation | Owner | Target release | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Semgrep | `detected-jwt-token @ eas.json:16` | ERROR | `eas.json:16` preview anon key | n/a | n/a | FALSE POSITIVE | Payload establishes public Supabase `anon`, not a privileged credential | Confirm project/RLS and document narrow exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `detected-jwt-token @ eas.json:38` | ERROR | `eas.json:38` production anon key | n/a | n/a | FALSE POSITIVE | Payload establishes public Supabase `anon`, not a privileged credential | Confirm project/RLS and document narrow exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `express-check-csurf @ server.js:7` | INFO | Express API application | n/a | n/a | FALSE POSITIVE | No cookie/session authentication was found; JSON API CSRF exploitability is not established | Confirm bearer/header-only auth assumption and document rule exception | Backend + Security | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `unsafe-formatstring @ contentReports.ts:28` | INFO | `services/contentReports.ts:28` | n/a | n/a | DEVELOPMENT ONLY | `__DEV__` log contains event/code metadata; format-string impact is low | Keep event allowlisted and code bounded; no user content | Mobile | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ imageUtils.js:68` | INFO | `services/imageUtils.js:68` | n/a | n/a | DEVELOPMENT ONLY | `__DEV__` error message log; possible sensitive path/error text, no format execution | Bound/redact development error messages | Mobile + Privacy | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ productSearchDeals.ts:195` | INFO | product-search integration-test helper | n/a | n/a | DEVELOPMENT ONLY | Test helper logs provider result metadata | Keep helper unreachable from production and avoid user query/body logs | Mobile QA | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ roomMessages.ts:47` | INFO | `services/roomMessages.ts:47` | n/a | n/a | DEVELOPMENT ONLY | `__DEV__` event/code metadata only; comment explicitly excludes bodies/IDs/tokens | Retain bounded metadata contract | Mobile | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ sneakers/devHelpers.ts:25` | INFO | sneaker integration-test helper | n/a | n/a | DEVELOPMENT ONLY | Test labels/provider metadata; no credential path shown | Keep dev helper out of production entry points | Mobile QA | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ sneakers/index.ts:252` | INFO | sneaker test runner | n/a | n/a | DEVELOPMENT ONLY | Test result metadata only | Keep test runner unreachable from production | Mobile QA | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ hoseaSneakerApi.ts:94` | INFO | provider development error log | n/a | n/a | DEVELOPMENT ONLY | `__DEV__` provider/error message; low integrity risk, possible verbose error text | Normalize to bounded error categories | Mobile | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ kickscrewRapidApi.ts:123` | INFO | provider development error log | n/a | n/a | DEVELOPMENT ONLY | `__DEV__` provider/error message | Normalize to bounded error categories | Mobile | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ sneakerDatabase.ts:88` | INFO | provider development error log | n/a | n/a | DEVELOPMENT ONLY | `__DEV__` provider/error message | Normalize to bounded error categories | Mobile | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ sneaksApi.ts:105` | INFO | provider development error log | n/a | n/a | DEVELOPMENT ONLY | `__DEV__` provider/error message | Normalize to bounded error categories | Mobile | Backlog hardening | ACCEPTED BASELINE CANDIDATE |
| Semgrep | `unsafe-formatstring @ errorLogger.ts:6` | INFO | `src/utils/errorLogger.ts:6` | n/a | n/a | MOBILE RUNTIME | Arbitrary error object can reach production console/error capture; confidentiality depends on callers | Introduce structured redaction and review all callers | Mobile + Privacy | Next mobile patch | INVESTIGATE |
| Semgrep | `unsafe-formatstring @ errorLogger.ts:9` | INFO | `src/utils/errorLogger.ts:9` | n/a | n/a | MOBILE RUNTIME | Arbitrary `extra` object can contain user/token/image-derived data | Allowlist fields and redact sensitive values before logging | Mobile + Privacy | Next mobile patch | INVESTIGATE |
| Semgrep | `unsafe-formatstring @ handle-user-deletion:96` | INFO | deletion-request failure log | n/a | n/a | BACKEND RUNTIME | Raw upstream response detail may expose request/privacy data in logs | Log bounded code/category, not raw detail; review retention | Privacy + Backend | Next backend deployment | INVESTIGATE |
| Semgrep | `wearable-bridge-missing-validation @ bridge:27` | INFO | bridge callback into `handleMessage` | n/a | n/a | UNVERIFIED | External message trust/session boundary is not proven | Add protocol version, session binding, allowlist, and schema validation | Wearables | Wearables pre-beta | INVESTIGATE |
| Semgrep | `wearable-bridge-missing-validation @ bridge:79` | INFO | `handleMessage()` payload casts | n/a | n/a | UNVERIFIED | Payloads are cast to trusted result/state types without runtime validation | Validate payload schemas and bound error text | Wearables | Wearables pre-beta | INVESTIGATE |
| Semgrep | `dependabot-missing-cooldown @ dependabot.yml:3` | MEDIUM | npm Dependabot entry | n/a | n/a | BUILD/CI | Newly published dependency updates are proposed immediately; supply-chain blast radius is limited by review | Add supported cooldown after confirming desired update latency | DevEx/Security | Next CI maintenance | UPDATE AVAILABLE |
| Semgrep | `dependabot-missing-cooldown @ dependabot.yml:16` | MEDIUM | Actions Dependabot entry | n/a | n/a | BUILD/CI | Same update-freshness risk for Actions | Add supported cooldown and retain SHA review | DevEx/Security | Next CI maintenance | UPDATE AVAILABLE |
| Semgrep | `exported_activity @ AndroidManifest.xml:17` | WARNING | mobile `MainActivity` | n/a | n/a | MOBILE RUNTIME | Export is required for launcher/deep-link filters; unsafe deep-link parsing is not established | Review scheme routes and reject unexpected hosts/actions/parameters | Mobile | Next mobile patch | FALSE POSITIVE CANDIDATE |
| Semgrep | `exported_activity @ glasses manifest:16` | WARNING | glasses `MainActivity` | n/a | n/a | UNVERIFIED | Launcher export is expected, but external intent-extra handling was not traced | Review activity intent handling before beta | Wearables | Wearables pre-beta | INVESTIGATE |
| Semgrep | `path-join-resolve-traversal @ qa-fixtures.js:30` | WARNING | fixed QA fixture reader | n/a | n/a | TEST ONLY | Filename comes from an in-file constant list, not external input | Keep list fixed; document test-only exception | QA + Security | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `logging-raw-image-data @ api.js:127` | WARNING | analyze-image development log | n/a | n/a | FALSE POSITIVE | Logs payload length only, not raw base64 | Preserve length-only behavior and add regression test/rule fixture | Mobile + Privacy | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `logging-raw-image-data @ imageUtils.js:27` | WARNING | static compression-settings log | n/a | n/a | FALSE POSITIVE | Static string says `base64=true`; no image bytes are logged | Tune rule/test fixture; preserve static-only log | Mobile + Privacy | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `logging-token-values @ verify-supabase.js:234` | WARNING | verification script HTTP-status log | n/a | n/a | FALSE POSITIVE | Logs absence of Authorization and status/body preview, not token value; body preview still merits bounded review | Keep tokens absent; bound/redact response preview | DevEx/Security | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `logging-token-values @ verify-supabase.js:260` | WARNING | verification script status log | n/a | n/a | FALSE POSITIVE | Logs phrase `Bearer anon` and HTTP status, not the JWT | Preserve metadata-only behavior and tune rule fixture | DevEx/Security | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `token-in-url @ authDeepLink.test.js:12` | WARNING | auth deep-link test | n/a | n/a | TEST ONLY | Synthetic URL fixture | Keep synthetic and document test exception | Mobile QA | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `token-in-url @ authDeepLink.test.js:24/a` | WARNING | auth deep-link test | n/a | n/a | TEST ONLY | Synthetic URL fixture | Keep synthetic and document test exception | Mobile QA | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `token-in-url @ authDeepLink.test.js:24/b` | WARNING | second match in same test expression | n/a | n/a | TEST ONLY | Duplicate matcher evidence in synthetic test | Keep synthetic and document test exception | Mobile QA | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `token-in-url @ authDeepLink.test.js:36` | WARNING | auth deep-link test | n/a | n/a | TEST ONLY | Synthetic URL fixture | Keep synthetic and document test exception | Mobile QA | Baseline acceptance | FALSE POSITIVE CANDIDATE |
| Semgrep | `wildcard-cors @ handle-user-deletion:1` | WARNING | deletion Edge Function | n/a | n/a | BACKEND RUNTIME | Function verifies bearer identity; wildcard origin is not by itself an auth bypass | Restrict origins and regression-test authenticated mobile callers | Privacy + Backend | Next backend deployment | INVESTIGATE |
| Semgrep | `wildcard-cors @ kickscrew-description:7` | WARNING | provider Edge Function | n/a | n/a | BACKEND RUNTIME | No explicit in-function caller auth; potential provider quota/cost abuse | Verify deployed JWT enforcement, require user auth/quota, restrict origins | Backend/API | Next backend deployment | ACTION REQUIRED |
| Semgrep | `wildcard-cors @ nike-details:9` | WARNING | provider Edge Function | n/a | n/a | BACKEND RUNTIME | No explicit in-function caller auth; potential provider quota/cost abuse | Verify deployed JWT enforcement, require user auth/quota, restrict origins | Backend/API | Next backend deployment | ACTION REQUIRED |
| Semgrep | `wildcard-cors @ privacy-correction:1` | WARNING | correction-request Edge Function | n/a | n/a | BACKEND RUNTIME | Bearer identity is checked; origin policy remains broad | Restrict origins after caller inventory | Privacy + Backend | Next backend deployment | INVESTIGATE |
| Semgrep | `wildcard-cors @ privacy-export:1` | WARNING | data-export Edge Function | n/a | n/a | BACKEND RUNTIME | Bearer identity is checked; origin policy remains broad around sensitive export | Restrict origins and test cross-origin denial | Privacy + Backend | Next backend deployment | INVESTIGATE |
| Semgrep | `wildcard-cors @ product-search-deals:7` | WARNING | provider Edge Function | n/a | n/a | BACKEND RUNTIME | No explicit in-function caller auth; paid-provider abuse is plausible | Require verified user/quota and restrict origins | Backend/API | Next backend deployment | ACTION REQUIRED |
| Semgrep | `wildcard-cors @ search-vinted:1` | WARNING | Apify-backed Edge Function | n/a | n/a | BACKEND RUNTIME | No explicit in-function caller auth; actor/token cost abuse is plausible | Verify JWT enforcement, add user quotas, restrict origins | Backend/API | Next backend deployment | ACTION REQUIRED |
| Semgrep | `wildcard-cors @ stylechat-generate:21` | WARNING | authenticated StyleChat Edge Function | n/a | n/a | BACKEND RUNTIME | `auth.getUser()` is present; wildcard origin broadens browser caller set but not token possession | Restrict origins and verify quota/session controls | Backend/API | Next backend deployment | INVESTIGATE |
| Semgrep | `wildcard-cors @ tryon-clothes-pro:7` | WARNING | provider Edge Function | n/a | n/a | BACKEND RUNTIME | No explicit in-function caller auth; high-cost provider abuse is plausible | Require verified user/quota before provider call; restrict origins | Backend/API | Next backend deployment | ACTION REQUIRED |

### OSV-Scanner — 31 findings

| Scanner | Finding ID | Severity | File or component | Package / installed | Fixed | Runtime | Exploitability assessment | Recommended remediation | Owner | Target release | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OSV | `GHSA-4x5r-pxfx-6jf8` | LOW | `package-lock.json` compiler tree | `@babel/core@7.29.0` | `7.29.6` | BUILD/CI | Requires attacker-controlled source, readable output, and known map path; builds use trusted source | Update Babel transitively | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-v422-hmwv-36x6` | LOW | Express dependency tree | `body-parser@1.20.5` | `1.20.6` | BACKEND RUNTIME | Invalid limit can disable enforcement; repository uses valid `15mb`, so current reachability is low | Update Express/body-parser and retain request-size tests | Backend/API | Next backend deployment | UPDATE AVAILABLE |
| OSV | `GHSA-3jxr-9vmj-r5cp` | HIGH | codegen glob tree | `brace-expansion@1.1.14` | `1.1.16` | BUILD/CI | Crafted glob input can cause CPU DoS; no untrusted build input shown | Update nested minimatch tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-mh99-v99m-4gvg` | HIGH | codegen glob tree | `brace-expansion@1.1.14` | `1.1.16` or later safe parent resolution | BUILD/CI | Crafted expansion can exhaust memory; build input is trusted | Update parent packages and confirm resolved safe version | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-3jxr-9vmj-r5cp` | HIGH | minimatch tree | `brace-expansion@2.1.1` | `2.1.2` | BUILD/CI | Crafted glob CPU DoS in tooling | Update nested minimatch tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-mh99-v99m-4gvg` | HIGH | minimatch tree | `brace-expansion@2.1.1` | safe parent resolution; report lists `5.0.8` | BUILD/CI | Crafted expansion memory DoS in tooling | Upgrade parent and verify advisory no longer resolves | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-3jxr-9vmj-r5cp` | HIGH | Expo/glob tree | `brace-expansion@5.0.6` | `5.0.7` | BUILD/CI | Crafted glob CPU DoS in tooling | Update to `5.0.8` to cover both brace advisories | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-mh99-v99m-4gvg` | HIGH | Expo/glob tree | `brace-expansion@5.0.6` | `5.0.8` | BUILD/CI | Crafted expansion memory DoS in tooling | Update to `5.0.8` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-52cp-r559-cp3m` | HIGH | Istanbul config tree | `js-yaml@3.14.2` | `3.15.0` | BUILD/CI | Crafted YAML merge chains can consume CPU; only trusted repo config identified | Update config/test tooling | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-h67p-54hq-rp68` | MEDIUM | Istanbul config tree | `js-yaml@3.14.2` | `3.15.0` | BUILD/CI | Crafted YAML alias DoS; no untrusted YAML ingestion shown | Update config/test tooling | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-52cp-r559-cp3m` | HIGH | Expo/Xcode formatting tree | `js-yaml@4.1.1` | `4.3.0` | BUILD/CI | Crafted YAML CPU DoS in build tooling | Update parent dependency | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-h67p-54hq-rp68` | MEDIUM | Expo/Xcode formatting tree | `js-yaml@4.1.1` | `4.2.0` | BUILD/CI | Crafted YAML alias DoS in build tooling | Update to `4.3.0` to cover both advisories | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-6g55-p6wh-862q` | HIGH | Expo Metro CSS tooling | `postcss@8.4.49` | `8.5.12` | BUILD/CI | Arbitrary file read requires attacker-controlled CSS/source-map comments in build | Update Metro/PostCSS chain | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-qx2v-qp2m-jg93` | MEDIUM | Expo Metro CSS tooling | `postcss@8.4.49` | `8.5.10` | BUILD/CI | XSS concerns generated web style output; K Scan is primarily native, web exposure unverified | Update to latest compatible fixed PostCSS | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-r28c-9q8g-f849` | HIGH | Expo Metro CSS tooling | `postcss@8.4.49` | `8.5.18` | BUILD/CI | Crafted source-map path can read files during build | Update to `8.5.18` or compatible safe parent | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-q8mj-m7cp-5q26` | MEDIUM | Express query dependency | `qs@6.15.1` | `6.15.2` | BACKEND RUNTIME | Advisory affects special `qs.stringify` arrays; no matching call was established | Update `qs`/Express and add regression test if stringify is used | Backend/API | Next backend deployment | UPDATE AVAILABLE |
| OSV | `GHSA-395f-4hp3-45gv` | HIGH | React DevTools tree | `shell-quote@1.8.3` | `1.9.0` | DEVELOPMENT ONLY | Crafted parse input CPU DoS only where dev tooling consumes attacker input | Update `react-devtools-core` tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-w7jw-789q-3m8p` | CRITICAL | React DevTools tree | `shell-quote@1.8.3` | `1.8.4` | DEVELOPMENT ONLY | Command-injection primitive exists in dev dependency; no production execution path shown | Update to at least `1.9.0`; isolate dev services | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-23hp-3jrh-7fpw` | CRITICAL | Expo CLI archive tooling | `tar@7.5.15` | `7.5.19` | BUILD/CI | Crafted compressed archive can exhaust build process; untrusted archive source not established | Update Expo CLI tree to `tar@7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-8x88-c5mf-7j5w` | HIGH | Expo CLI archive tooling | `tar@7.5.15` | `7.5.18` | BUILD/CI | Malformed archive can hang build tooling | Update to `7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-gvwx-54wh-qm9j` | MEDIUM | Expo CLI archive tooling | `tar@7.5.15` | `7.5.17` | BUILD/CI | Crafted metadata can crash archive parser | Update to `7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-r292-9mhp-454m` | MEDIUM | Expo CLI archive tooling | `tar@7.5.15` | `7.5.21` | BUILD/CI | Crafted long-path archive can cause stack overflow | Update to `7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-vmf3-w455-68vh` | MEDIUM | Expo CLI archive tooling | `tar@7.5.15` | `7.5.16` | BUILD/CI | Crafted PAX metadata can smuggle file interpretation | Update to `7.5.21+` and test extraction boundaries | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-w8wr-v893-vjvp` | MEDIUM | Expo CLI archive tooling | `tar@7.5.15` | `7.5.18` | BUILD/CI | Crafted PAX numeric path can crash process | Update to `7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-35p6-xmwp-9g52` | LOW | Expo CLI HTTP client | `undici@6.26.0` | `6.27.0` | BUILD/CI | Response mix-up requires particular reused-socket conditions in CLI networking | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-g8m3-5g58-fq7m` | LOW | Expo CLI HTTP client | `undici@6.26.0` | `6.27.0` | BUILD/CI | Cookie parsing issue in CLI path; no app runtime cookie use shown | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-p88m-4jfj-68fv` | MEDIUM | Expo CLI HTTP client | `undici@6.26.0` | `6.27.0` | BUILD/CI | Header injection needs malicious Set-Cookie response in CLI network flow | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-vxpw-j846-p89q` | HIGH | Expo CLI HTTP client | `undici@6.26.0` | `6.27.0` | BUILD/CI | WebSocket fragment DoS applies if CLI opens attacker-controlled socket; no shipped app path | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-w5hq-g745-h8pq` | MEDIUM | Xcode project tooling | `uuid@7.0.3` | `11.1.1` | BUILD/CI | Requires affected v3/v5/v6 buffer API use; only Xcode tooling path found | Update `xcode` parent with compatibility testing | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-96hv-2xvq-fx4p` | HIGH | React Native/dev middleware | `ws@6.2.3` | `6.2.4` | DEVELOPMENT ONLY | Remote memory DoS matters only if dev WebSocket service is exposed | Update parent and keep dev servers private | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| OSV | `GHSA-96hv-2xvq-fx4p` | HIGH | Metro/dev tools | `ws@7.5.10` | `7.5.11` | DEVELOPMENT ONLY | Same dev-server memory DoS; no production backend use found | Update parent and keep dev servers private | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |

### Trivy — 33 findings

The first 31 rows duplicate the OSV dependency/version evidence under Trivy IDs. The
last two rows duplicate the current public-anon JWT matches.

| Scanner | Finding ID | Severity | File or component | Package / installed | Fixed | Runtime | Exploitability assessment | Recommended remediation | Owner | Target release | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Trivy | `CVE-2026-49356` | LOW | `package-lock.json` compiler tree | `@babel/core@7.29.0` | `7.29.6` | BUILD/CI | Requires malicious source/source-map conditions; duplicate of OSV record | Update Babel transitively | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-12590` | LOW | Express dependency tree | `body-parser@1.20.5` | `1.20.6` | BACKEND RUNTIME | Valid `15mb` limit is configured; duplicate of OSV record | Update Express/body-parser | Backend/API | Next backend deployment | UPDATE AVAILABLE |
| Trivy | `CVE-2026-13149 / 1.1.14` | HIGH | codegen glob tree | `brace-expansion@1.1.14` | `1.1.16` | BUILD/CI | Crafted glob CPU DoS in trusted-input tooling | Update nested minimatch tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-14257 / 1.1.14` | HIGH | codegen glob tree | `brace-expansion@1.1.14` | safe parent resolution; report lists `5.0.8` | BUILD/CI | Crafted expansion memory DoS in tooling | Update parent and verify advisory clears | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-13149 / 2.1.1` | HIGH | minimatch tree | `brace-expansion@2.1.1` | `2.1.2` | BUILD/CI | Crafted glob CPU DoS in tooling | Update nested minimatch tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-14257 / 2.1.1` | HIGH | minimatch tree | `brace-expansion@2.1.1` | safe parent resolution; report lists `5.0.8` | BUILD/CI | Crafted expansion memory DoS in tooling | Update parent and verify advisory clears | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-13149 / 5.0.6` | HIGH | Expo/glob tree | `brace-expansion@5.0.6` | `5.0.7` | BUILD/CI | Crafted glob CPU DoS in tooling | Update to `5.0.8` for both advisories | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-14257 / 5.0.6` | HIGH | Expo/glob tree | `brace-expansion@5.0.6` | `5.0.8` | BUILD/CI | Crafted expansion memory DoS in tooling | Update to `5.0.8` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-59869 / 3.14.2` | HIGH | Istanbul config tree | `js-yaml@3.14.2` | `3.15.0` | BUILD/CI | Crafted YAML CPU DoS; trusted config path found | Update config/test tooling | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-53550 / 3.14.2` | MEDIUM | Istanbul config tree | `js-yaml@3.14.2` | `3.15.0` | BUILD/CI | Crafted YAML alias DoS in tooling | Update config/test tooling | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-59869 / 4.1.1` | HIGH | Expo/Xcode formatting tree | `js-yaml@4.1.1` | `4.3.0` | BUILD/CI | Crafted YAML CPU DoS in build tooling | Update parent dependency | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-53550 / 4.1.1` | MEDIUM | Expo/Xcode formatting tree | `js-yaml@4.1.1` | `4.2.0` | BUILD/CI | Crafted YAML alias DoS in build tooling | Update to `4.3.0` for both advisories | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-45623` | HIGH | Expo Metro CSS tooling | `postcss@8.4.49` | `8.5.12` | BUILD/CI | Malicious CSS/source map needed during build | Update Metro/PostCSS chain | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `GHSA-r28c-9q8g-f849` | HIGH | Expo Metro CSS tooling | `postcss@8.4.49` | `8.5.18` | BUILD/CI | Crafted source-map path can read build files | Update to `8.5.18` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-41305` | MEDIUM | Expo Metro CSS tooling | `postcss@8.4.49` | `8.5.10` | BUILD/CI | Web style-output exposure unverified; native runtime unaffected | Update to `8.5.18` for all advisories | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-8723` | MEDIUM | Express query dependency | `qs@6.15.1` | `6.15.2` | BACKEND RUNTIME | Affected stringify pattern was not established in repository | Update `qs`/Express | Backend/API | Next backend deployment | UPDATE AVAILABLE |
| Trivy | `CVE-2026-9277` | CRITICAL | React DevTools tree | `shell-quote@1.8.3` | `1.8.4` | DEVELOPMENT ONLY | Command-injection primitive in dev dependency; no production path found | Update to `1.9.0` through parent | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-13311` | HIGH | React DevTools tree | `shell-quote@1.8.3` | `1.9.0` | DEVELOPMENT ONLY | Crafted parse input CPU DoS in dev tooling | Update parent and isolate dev services | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-59873` | CRITICAL | Expo CLI archive tooling | `tar@7.5.15` | `7.5.19` | BUILD/CI | Crafted compressed archive can exhaust build process | Update to `7.5.21+` through Expo CLI | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-59874` | HIGH | Expo CLI archive tooling | `tar@7.5.15` | `7.5.18` | BUILD/CI | Malformed archive can hang build tooling | Update to `7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-53655` | MEDIUM | Expo CLI archive tooling | `tar@7.5.15` | `7.5.16` | BUILD/CI | Crafted PAX metadata can create interpretation differences | Update to `7.5.21+` and test extraction | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-59871` | MEDIUM | Expo CLI archive tooling | `tar@7.5.15` | `7.5.18` | BUILD/CI | Crafted PAX data can crash process | Update to `7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-59875` | MEDIUM | Expo CLI archive tooling | `tar@7.5.15` | `7.5.17` | BUILD/CI | Crafted NUL metadata can crash parser | Update to `7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `GHSA-r292-9mhp-454m` | MEDIUM | Expo CLI archive tooling | `tar@7.5.15` | `7.5.21` | BUILD/CI | Crafted long paths can stack-overflow parser | Update to `7.5.21+` | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-12151` | HIGH | Expo CLI HTTP client | `undici@6.26.0` | `6.27.0` | BUILD/CI | DoS applies to CLI WebSocket use; no shipped app path | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-9679` | MEDIUM | Expo CLI HTTP client | `undici@6.26.0` | `6.27.0` | BUILD/CI | Malicious Set-Cookie response needed in CLI flow | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-11525` | LOW | Expo CLI HTTP client | `undici@6.26.0` | `6.27.0` | BUILD/CI | Cookie parsing issue in CLI path | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-6733` | LOW | Expo CLI HTTP client | `undici@6.26.0` | `6.27.0` | BUILD/CI | Socket-reuse response confusion in CLI path | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-41907` | MEDIUM | Xcode project tooling | `uuid@7.0.3` | `11.1.1` | BUILD/CI | Affected buffer APIs not shown; only Xcode tooling path found | Update `xcode` parent with compatibility testing | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-48779 / 6.2.3` | HIGH | React Native/dev middleware | `ws@6.2.3` | `6.2.4` | DEVELOPMENT ONLY | Remote memory DoS only if dev socket is exposed | Update parent and keep dev servers private | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `CVE-2026-48779 / 7.5.10` | HIGH | Metro/dev tools | `ws@7.5.10` | `7.5.11` | DEVELOPMENT ONLY | Remote memory DoS only if dev socket is exposed | Update parent and keep dev servers private | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| Trivy | `jwt-token @ eas.json:16` | MEDIUM | preview `EXPO_PUBLIC_SUPABASE_ANON_KEY` | n/a | n/a | FALSE POSITIVE | Payload confirms public `anon` key | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |
| Trivy | `jwt-token @ eas.json:38` | MEDIUM | production `EXPO_PUBLIC_SUPABASE_ANON_KEY` | n/a | n/a | FALSE POSITIVE | Payload confirms public `anon` key | Confirm project/RLS and document exception | Security/Platform | Before baseline acceptance | FALSE POSITIVE CANDIDATE |

### npm audit — 22 findings

npm audit records are package-level aggregates. A row can represent several advisories
already itemized by OSV and Trivy.

| Scanner | Finding ID | Severity | File or component | Package / installed | Fixed | Runtime | Exploitability assessment | Recommended remediation | Owner | Target release | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| npm audit | `1123528 / @babel/core` | LOW | `package-lock.json` compiler tree | `@babel/core@7.29.0` | `7.29.6` | BUILD/CI | Aggregate duplicate; malicious source-map build conditions required | Update Babel transitively | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:@expo/cli` | MEDIUM | Expo package aggregate | `@expo/cli@54.0.25` | via `expo@57.0.8` (major) | BUILD/CI | Inherits config/Metro/prebuild advisories; not shipped mobile runtime code | Find compatible patched Expo line; do not force major upgrade | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:@expo/config` | MEDIUM | Expo configuration aggregate | `@expo/config@12.0.13` | via `expo@57.0.8` (major) | BUILD/CI | Inherits config-plugin/Xcode advisory paths | Resolve through compatible Expo update | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:@expo/config-plugins` | MEDIUM | Expo configuration aggregate | `@expo/config-plugins@54.0.4` | via `expo@57.0.8` (major) | BUILD/CI | Inherits Xcode/UUID tooling advisory | Resolve through compatible Expo update | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:@expo/metro-config` | MEDIUM | Metro configuration aggregate | `@expo/metro-config@54.0.16` | via `expo@57.0.8` (major) | BUILD/CI | Inherits PostCSS/config tooling advisories | Resolve through compatible Expo/Metro update | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:@expo/prebuild-config` | MEDIUM | Expo prebuild aggregate | `@expo/prebuild-config@54.0.8` | fix reported available | BUILD/CI | Inherits configuration/plugin advisory paths | Update compatible parent and confirm audit clears | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `1123977 / body-parser` | LOW | Express dependency tree | `body-parser@1.20.5` | `1.20.6` | BACKEND RUNTIME | Valid request limit reduces current exploitability | Update Express/body-parser and test body-size enforcement | Backend/API | Next backend deployment | UPDATE AVAILABLE |
| npm audit | `npm:brace-expansion` | HIGH | six nested glob/codegen nodes | `1.1.14`, `2.1.1`, `5.0.6` | `1.1.16`, `2.1.2`, `5.0.8` | BUILD/CI | Aggregates CPU/memory DoS advisories in tooling | Update all nested minimatch/glob parents | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:expo` | MEDIUM | direct Expo aggregate | `expo@54.0.35` | `57.0.8` (major) | BUILD/CI | Severity is inherited from CLI/config packages, not confirmed Expo mobile runtime code | Plan compatible SDK upgrade; validate native builds and app behavior | DevEx/Build + Mobile | Planned SDK maintenance | UPDATE AVAILABLE |
| npm audit | `npm:expo-asset` | MEDIUM | Expo aggregate | `expo-asset@12.0.13` | via `expo@57.0.8` (major) | BUILD/CI | Inherited from Expo config chain; no asset runtime flaw identified | Resolve through planned SDK update | DevEx/Build + Mobile | Planned SDK maintenance | UPDATE AVAILABLE |
| npm audit | `npm:expo-constants` | MEDIUM | direct Expo aggregate | `expo-constants@18.0.13` | `57.0.7` (major) | BUILD/CI | Inherited config advisory; no constants runtime flaw identified | Resolve through compatible SDK update | DevEx/Build + Mobile | Planned SDK maintenance | UPDATE AVAILABLE |
| npm audit | `npm:expo-linking` | MEDIUM | direct Expo aggregate | `expo-linking@8.0.12` | `57.0.4` (major) | BUILD/CI | Inherited through Expo constants; no linking runtime flaw identified | Do not force incompatible major; update with SDK train | DevEx/Build + Mobile | Planned SDK maintenance | UPDATE AVAILABLE |
| npm audit | `npm:expo-router` | MEDIUM | direct Expo aggregate | `expo-router@6.0.24` | `57.0.8` (major) | BUILD/CI | Inherited through constants/linking; router exploitability not established | Resolve with compatible SDK/router update and navigation tests | DevEx/Build + Mobile | Planned SDK maintenance | UPDATE AVAILABLE |
| npm audit | `npm:js-yaml` | HIGH | two build/config nodes | `3.14.2`, `4.1.1` | `3.15.0`, `4.3.0` | BUILD/CI | Aggregates crafted-YAML DoS advisories; no untrusted YAML source shown | Update config/test parent packages | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:postcss` | HIGH | Expo Metro CSS tooling | `postcss@8.4.49` | `8.5.18` | BUILD/CI | Aggregates file-read/path/XSS advisories in build output | Update compatible Metro/PostCSS chain | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `1119502 / qs` | MEDIUM | Express query dependency | `qs@6.15.1` | `6.15.2` | BACKEND RUNTIME | Affected stringify call pattern not established | Update `qs`/Express and regression-test APIs | Backend/API | Next backend deployment | UPDATE AVAILABLE |
| npm audit | `npm:shell-quote` | CRITICAL | React DevTools dependency | `shell-quote@1.8.3` | `1.9.0` | DEVELOPMENT ONLY | Aggregates command-injection and parse-DoS advisories; no production path found | Update `react-devtools-core` tree and isolate dev services | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:tar` | CRITICAL | Expo CLI archive dependency | `tar@7.5.15` | `7.5.21` | BUILD/CI | Aggregates six crafted-archive advisories | Update Expo CLI tree; test install/build/archive flows | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:undici` | HIGH | Expo CLI HTTP dependency | `undici@6.26.0` | `6.27.0` | BUILD/CI | Aggregates four CLI network advisories; no app runtime import shown | Update Expo CLI/Undici tree | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `1119441 / uuid` | MEDIUM | Xcode project tooling | `uuid@7.0.3` | `11.1.1` | BUILD/CI | Affected buffer API use not established | Update `xcode` parent with compatibility testing | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:ws` | HIGH | Metro/dev middleware nodes | `ws@6.2.3`, `7.5.10` | `6.2.4`, `7.5.11` | DEVELOPMENT ONLY | Aggregates dev WebSocket memory DoS; risk requires exposed dev server | Update parents and keep dev servers private | DevEx/Build | Next CI maintenance | UPDATE AVAILABLE |
| npm audit | `npm:xcode` | MEDIUM | Xcode project tooling aggregate | `xcode@3.0.1` | via `expo@57.0.8` (major) | BUILD/CI | Inherits UUID advisory; no mobile runtime path | Update compatible Xcode/Expo tooling | DevEx/Build | Planned SDK maintenance | UPDATE AVAILABLE |

## Triage conclusion

**BASELINE ARTIFACTS PARSED:** all five scanner JSON reports parsed successfully.

**FINDINGS CLASSIFIED:** all 150 raw scanner records have a runtime classification,
exploitability assessment, remediation, owner, target, and status. None is labeled a
confirmed exploitable vulnerability.

**REMEDIATION PRIORITIES PROPOSED:** provider-backed Edge Function access controls and
privacy logging lead the sequence, followed by wearable validation and compatible
dependency updates.

**MANUAL REVIEW REQUIRED:** Edge Function deployment/JWT policy, provider quotas, CORS,
production error-log call sites, deletion logs, wearable messages, exported activities,
Supabase RLS, and three Semgrep partial-parse locations remain open.

**COMMIT NOT CREATED:** this document is intentionally left as an uncommitted working-tree
change, and the downloaded artifact directory remains untracked.
