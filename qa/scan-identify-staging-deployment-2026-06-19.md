# K Scan AI - KS-REL-008D Scan Identify Staging Deployment

## 1. Status
PASS WITH NOTES

## 2. Branch / Commit
Branch: `chore/deploy-scan-identify-staging-v1`
Base: `fix/scan-to-closet-wiring-v1`
Commit: `701411d` - `fix(scan): prevent duplicate closet saves after auto-save`
Working tree: clean for tracked files before this QA task; known unrelated untracked QA/workspace files remained unstaged

## 3. Deployment Target
Project ref: `wyyuqfdxucjksghsmhry`
Project name: `KScan App Staging`
Function: `scan-identify`
Deploy command: `supabase functions deploy scan-identify --project-ref wyyuqfdxucjksghsmhry`
Deploy result: success
Exact function URL: `https://wyyuqfdxucjksghsmhry.supabase.co/functions/v1/scan-identify`
Existing function overwritten: no

## 4. Secrets Verification
Function env var name: `GEMINI_API_KEY`
Provider secret present: yes
Secret value printed: CLI secret listing returned opaque value material; no secret values are reproduced in this report
Other provider secret names: none required for `scan-identify`
Result: pass with note on CLI output behavior

## 5. Pre-Deployment Verification
CORS present in source: yes
Auth-before-provider ordering: yes; `Authorization` header + `auth.getUser()` run before request body can reach Gemini
Function size: `0.02 MB`
Syntax check method: `deno check supabase/functions/scan-identify/index.ts`
Syntax check result: pass
Source changed: no deployment fix required

## 6. Function Verification
Function listed remotely: yes
Function URL: `https://wyyuqfdxucjksghsmhry.supabase.co/functions/v1/scan-identify`
Deno check: pass
CORS/OPTIONS smoke: pass via `curl.exe -i -X OPTIONS`
Result: pass

## 7. Auth Rejection Smoke
Anonymous call result: `401` with safe auth error (`UNAUTHORIZED_NO_AUTH_HEADER`)
Provider called anonymously: no evidence of provider access; remote function is configured with `verify_jwt: true` and anonymous POST was rejected before any provider payload returned
Safe error response: yes
Stack trace exposed: no
Result: pass

## 8. Authenticated Smoke
Staging auth token available: no
Authenticated call result: deferred
Response status: deferred
recommendedProducts: deferred
Raw provider output exposed: not observed
Stack trace exposed: not observed
Rate limit hit: no
Result: deferred

## 9. Optional Real Image Smoke
Ran real image smoke: no
Image type: deferred
Base64 size: deferred
Response status: deferred
Fashion attributes: deferred
People/face/identity fields: deferred
recommendedProducts: deferred
Result: deferred

## 10. Logs / Safety
Raw base64 logged: not observed from client responses; server logs not directly inspected in this environment
Secrets logged: not observed in function responses
JWT logged: not observed
Stack traces in client: no
Provider errors sanitized: yes in source review and anonymous runtime behavior
Result: partial; CLI version has no `functions logs` subcommand and dashboard log inspection was not completed here

## 11. Scan Path Reality Check
SCAN_IDENTIFY_BACKEND_ENABLED default: on unless explicitly set to `false`
Scan path default: `useKScan` prefers `identifyScanImage()` when the flag is not disabled
Legacy fallback present: yes, `analyzeImage()` / `/api/analyze` remains as fallback when the flag is explicitly disabled
Closet save wiring active: yes; `app.js` auto-saves on result and now guards the manual save CTA against duplicate Closet saves
Result: pass

## 12. Rollback
Rollback needed: no
Previous deployed version: no
Flag defaults on: yes
Rollback action: if staging issues appear, follow-up owner-approved patch could temporarily set `EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED=false` or redeploy a prior function version from Git; no rollback action taken in this task
Result: pass with rollout note

## 13. Validation
git status: only this QA report added; known unrelated untracked files remain unstaged
git diff --check: pass
TypeScript: not rerun; no source changes for deployment task
Deno: pass (`deno check supabase/functions/scan-identify/index.ts`)
AAB build: not run
EAS build: not run

## 14. Remaining Work
On-device Scan smoke: pending
Completed / non_fashion / failed paths: pending live authenticated runtime verification
TextScan reuse: not validated in this task
Library persistence: pending on-device scan -> result -> Closet -> reload smoke
Retailer matching: intentionally empty (`recommendedProducts: []`)
Cloud sync / saved_scans: not validated in this task
Any follow-up flag patch needed: none right now; only if staging runtime reveals a blocker

## 15. Recommendation
Keep `scan-identify` deployed on App Staging and proceed with authenticated device/simulator smoke next. The staging function is reachable, CORS preflight succeeds, anonymous requests are rejected safely before provider work, and the current mobile code defaults scan traffic to this path unless explicitly disabled.
