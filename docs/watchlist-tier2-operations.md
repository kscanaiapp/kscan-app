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

**Status: WIRED IN SOURCE. OWNER CREDENTIAL REQUIRED to activate.**

Build 34 Android certification closed the *mechanism*. The *credential* is still
an owner action — nothing here fabricates one, and no build acquires FCM
capability until the owner uploads the file secret in step 1.

iOS is complete: `aps-environment` appears under
`npx expo config --type introspect`, and `Notifications.getExpoPushTokenAsync()`
resolves. Android previously could not obtain a push token at all, because the
repository had no `google-services.json`, no `googleServicesFile` key, and no
Google Services Gradle plugin.

`services/watchlist/pushRegistration.ts` treats both platforms alike, so on
Android the token request fails and the Watch is left with `push_enabled: false`.
That is safe — a Watch is never blocked by push failing — but it means Android
users silently never receive a price alert.

### Why this is wired natively, not through `app.json`

Android is **NATIVE_AUTHORITATIVE** in this repository
(`config/native-config-authority.json`): `android/` is committed and is what
produces the shipped artifact. `expo.android.googleServicesFile` is a
Continuous-Native-Generation field — it is consumed by `expo prebuild`, which
this repository does not run for Android. Setting it would have produced a
config that *looks* wired and an AAB with no Firebase configuration in it,
which is the exact failure mode this document exists to prevent. (It would
also have meant converting `app.json` to `app.config.js` and running
`expo prebuild`, which would regenerate the native project and discard the
Build 32 R8/AAB hardening that lives there.)

So the file is materialised directly into the native project instead:

```
EAS file secret GOOGLE_SERVICES_JSON
        │  EAS decrypts it and exports its PATH as $GOOGLE_SERVICES_JSON
        ▼
android/app/build.gradle   copies it to android/app/google-services.json
        │                  then, only if that file now exists:
        ▼
apply plugin: 'com.google.gms.google-services'   (classpath in android/build.gradle)
```

If the secret is absent, the plugin is not applied, the build still succeeds,
and the artifact honestly has no Firebase configuration. It never half-applies.

`android/app/google-services.json` is git-ignored (`android/app/.gitignore`) and
**must never be committed** — this repository is public, and the file carries the
Firebase API key and app identifiers.

### Owner steps

1. In the Firebase console, add an Android app to the K Scan AI project with
   package name **`com.kscanai.app`** and download its `google-services.json`.

2. **Do not commit the file.** Upload it as an EAS *file* secret:

   ```bash
   eas secret:create --scope project --type file --name GOOGLE_SERVICES_JSON --value ./google-services.json
   ```

   Expected secret name:

   ```
   GOOGLE_SERVICES_JSON
   ```

   No `eas.json` change is needed: EAS injects project file secrets into every
   build for the project and exports the decrypted path under that same name.

3. Upload the FCM V1 service-account key to Expo so the push service can send:

   ```bash
   eas credentials --platform android
   ```

   Step 2 lets the app *obtain* a token; step 3 lets Expo's push service
   *deliver* to it. Both are required — either alone produces silence.

4. **Validation.** The build log prints the resolved state directly:

   ```
   kscan: googleServicesConfigured=true
   ```

   `false` means the secret did not reach the build. Locally, the same path can
   be exercised without EAS:

   ```bash
   GOOGLE_SERVICES_JSON=/absolute/path/to/google-services.json ./gradlew :app:bundleRelease
   ```

5. **On-device proof (the only thing that closes this).** Source configuration
   cannot prove delivery. Android Watchlist push is not "ready" until a
   Play-distributed artifact actually receives and routes a notification —
   see the Voice/Watchlist rows in the physical certification package.

`__tests__/watchlistAndroidPushConfig.test.js` holds the line either way: it
fails if anything claims Android Watchlist push is operational while the FCM
path is absent, and it fails if the native wiring exists without
`GOOGLE_SERVICES_JSON` being recorded here. It is a consistency gate, not a
green light.

**iOS `aps` configuration is untouched by any of the above.**

---

## 3. Voice Scan certification permission proof

**Status: SOURCE-WIRED. ARTIFACT VERIFICATION REQUIRED.**

Voice Scan needs `android.permission.RECORD_AUDIO`, but only in the
`staging-certification` AAB. It is carried by a build-type manifest selected
by a governed Gradle selector, never by `app.json` — so the default and
production artifacts keep requesting no microphone permission at all.

| | default / production release | `staging-certification` release |
|---|---|---|
| `RECORD_AUDIO` | removed (`tools:node="remove"` in `src/main`) | granted |
| selector `KSCAN_VOICE_CERTIFICATION` | unset | `"true"` |
| manifest used | `android/app/src/release/AndroidManifest.xml` | `android/app/src/certification/AndroidManifest.xml` |
| `FOREGROUND_SERVICE_MICROPHONE` | removed | removed |

The declaration lives in `config/native-config-authority.json` under
`platforms.android.buildProfileManifestExceptions`, and
`scripts/check-native-config-parity.js` enforces it (with negative controls in
`__tests__/nativeConfigParityGate.test.js` proving each rule bites).

**What source cannot prove.** Manifest-merger precedence is a build-time
behaviour. Before certification, inspect the *merged* manifest of both
artifacts:

```bash
unzip -p app-release.aab base/manifest/AndroidManifest.xml > merged.pb && aapt2 dump xmltree --file base/manifest/AndroidManifest.xml app-release.aab | grep -i RECORD_AUDIO
```

Required results:

- certification AAB — `RECORD_AUDIO` **present**, no `FOREGROUND_SERVICE_MICROPHONE`, no `<service>`
- production AAB — `RECORD_AUDIO` **absent**

A certification AAB whose merged manifest lacks `RECORD_AUDIO` must not be
certified: Voice would render its affordance and never obtain permission.
