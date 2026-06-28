# BuildConfig Security Policy

## Rule

**BuildConfig must never contain credentials, tokens, passwords, API keys, bearer tokens, private keys, or secrets of any kind.**

## Why

BuildConfig values are compiled into the APK. They can be extracted from the APK by anyone who has the binary.

## What Changed

- `KSCAN_DEBUG_ANALYZE_AUTH_TOKEN` was removed from BuildConfig generation in `app/build.gradle.kts`.
- `DebugAnalyzeConfig.fromBuildConfig()` no longer reads an auth token from BuildConfig. It sets `authToken` to an empty string.
- The token-like field is intentionally absent from BuildConfig so it cannot be accidentally baked in.

## Allowed BuildConfig Fields

Non-secret flags and URLs are allowed:

- `KSCAN_DEBUG_ANALYZE_ENABLED` — boolean debug feature flag
- `KSCAN_DEBUG_ANALYZE_URL` — debug backend URL string (must not contain embedded credentials)
- `KSCAN_DEBUG_ANALYZE_DRY_RUN` — boolean offline/mock gate

## What Remains Safe

- `local.properties` is still gitignored and uncommitted.
- DRY_RUN remains the safe default path for local smoke testing.
- `DebugAnalyzeConfig.DEFAULT` remains disabled.

## Future Live Debug Auth

If a real debug auth token is ever needed, it must be supplied by a **runtime-only credential provider** — not by BuildConfig. A separate task will design that mechanism if required.
