# Smart Watchlist — Tier 2 sweep & Android push: owner provisioning

Two Watchlist capabilities are **complete in source and inert in every
environment** because they depend on credentials that cannot be created from a
repository. Nothing here is fabricated: this file records the exact names the
code already reads, so provisioning is a lookup rather than a guess.

Both are **fail-closed today** — absent configuration produces a refusal, never
a silent partial success.

---

## 1. Tier 2 refresh sweep — `WATCHLIST_WORKER_SECRET`

**Status: OWNER SECRET REQUIRED.** The endpoint, its authentication and its kill
switch all exist and are tested; only the credential and the enablement flip are
outstanding.

`supabase/functions/commerce-watch-refresh/index.ts` routes to the sweep when a
request carries a valid worker secret, then refuses to claim anything unless the
server-side kill switch is on. Three independent gates, all currently closed:

| # | Gate | Where enforced | Current state |
|---|---|---|---|
| 1 | `WATCHLIST_WORKER_SECRET` present and matching | `requireWorkerSecret()`, constant-time compare | **absent** — every sweep request authenticates as a normal caller and is refused |
| 2 | Sweep actually invoked | `.github/workflows/watchlist-tier2-sweep.yml` | manual dispatch only; `schedule:` is commented out |
| 3 | `app_config.watchlist_worker_enabled` is `true` | `readAppConfigFlag()` inside the function | **seeded explicitly `false`** by `20260831000100_watchlist_worker_enablement.sql` |

Gate 3 is the authority — it holds even if the workflow is run by hand, and it
is why nothing in this repo can activate the sweep on its own.

### Owner steps (staging first; production is a separate decision)

1. **Create the Edge Function secret** on the staging project
   (`yzqjvdfgefveprobvvyw`). Name exactly:

   ```
   WATCHLIST_WORKER_SECRET
   ```

   Generate a high-entropy value; it is compared byte-for-byte and never logged.

   ```bash
   supabase secrets set WATCHLIST_WORKER_SECRET --project-ref yzqjvdfgefveprobvvyw
   ```

2. **Mirror it as a GitHub repository secret** of the same name, so the workflow
   can present it. Add repository **variable** `SUPABASE_STAGING_FUNCTIONS_URL`
   set to the staging functions origin (`https://<ref>.functions.supabase.co`).

3. **Validate — refusal path first.** Confirm the endpoint refuses a wrong
   secret before enabling anything:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'content-type: application/json' \
     -H 'x-watchlist-worker-secret: definitely-wrong' \
     --data '{}' \
     "https://yzqjvdfgefveprobvvyw.functions.supabase.co/commerce-watch-refresh"
   # expect 401 — a wrong secret must never reach the sweep
   ```

4. **Validate — governed no-op.** With the real secret and the kill switch still
   `false`, the sweep must report `enabled: false` and claim nothing:

   ```bash
   curl -sS -X POST \
     -H 'content-type: application/json' \
     -H "x-watchlist-worker-secret: $WATCHLIST_WORKER_SECRET" \
     --data '{}' \
     "https://yzqjvdfgefveprobvvyw.functions.supabase.co/commerce-watch-refresh"
   # expect {"mode":"sweep","enabled":false,"claimed":0,"results":[]}
   ```

   Seeing `enabled: false` here is the proof the kill switch is wired, not a
   failure.

5. **Only then**, to actually run the sweep on staging:

   ```sql
   update public.app_config
      set value = jsonb_build_object('enabled', true, 'updatedAt', now())
    where key = 'watchlist_worker_enabled';
   ```

   and uncomment the `schedule:` block in the workflow.

**Production activation is deliberately not covered here.** It requires the same
secret on the production project plus the same flag flip, and is an owner
decision outside this feature's authority.

---

## 2. Android push — Firebase configuration

**Status: OWNER CREDENTIAL REQUIRED. Nothing was fabricated.**

iOS is complete: `aps-environment` appears under
`npx expo config --type introspect`, and `Notifications.getExpoPushTokenAsync()`
resolves. Android **cannot obtain a push token at all** — the repository has:

- no `google-services.json` (no such file is tracked),
- no `googleServicesFile` key in `app.json`'s `expo.android` block,
- no Google Services Gradle plugin (`com.google.gms` appears nowhere).

`services/watchlist/pushRegistration.ts` treats both platforms alike, so on
Android the token request fails and the Watch is left with `push_enabled: false`.
That is safe — a Watch is never blocked by push failing — but it means **Android
users silently never receive a price alert**.

### Owner steps

1. In the Firebase console, add an Android app to the K Scan AI project with
   package name **`com.kscanai.app`** and download its `google-services.json`.

2. **Do not commit the file.** Upload it as an EAS *file* secret:

   ```bash
   eas secret:create --scope project --type file \
     --name GOOGLE_SERVICES_JSON --value ./google-services.json
   ```

   Expected secret name:

   ```
   GOOGLE_SERVICES_JSON
   ```

3. Wire the config field. `app.json` is static JSON and cannot read an
   environment variable, so this requires converting to `app.config.js` (or
   adding one alongside) and setting:

   ```
   expo.android.googleServicesFile = process.env.GOOGLE_SERVICES_JSON
   ```

   Expected config field: **`expo.android.googleServicesFile`**.

4. Upload the FCM V1 service-account key to Expo so the push service can send:

   ```bash
   eas credentials --platform android
   ```

5. **Validation command** — the field must materialise in the resolved config:

   ```bash
   npx expo config --type introspect | grep -i googleServicesFile
   ```

   and for the built artefact:

   ```bash
   npx expo prebuild --platform android --no-install \
     && test -f android/app/google-services.json && echo "FCM config present"
   ```

Until step 3 lands, `__tests__/watchlistAndroidPushConfig.test.js` holds the
line: it fails the moment anything claims Android Watchlist push is operational
while the FCM path is absent, and it equally fails if `googleServicesFile` is
wired without `GOOGLE_SERVICES_JSON` being recorded here. It is a consistency
gate, not a green light.

**iOS `aps` configuration is untouched by any of the above.**
