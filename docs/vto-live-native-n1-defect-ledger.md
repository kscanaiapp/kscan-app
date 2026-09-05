# Live VTO Native Runtime N1 — Defect / Divergence Ledger

Format follows the mission's own P0-P10 severity bands. Only real findings recorded here -- see section 59/62 of the N1 mission for repair authority.

## N1-ENV-001 (P2) -- amendment B1 conflicts with an existing merged governance test

**Found:** N1-A setup, before any eas.json edit was made.

**What:** Amendment B1 authorizes setting `EXPO_PUBLIC_LIVE_VTO_ENABLED=true` in the `development` EAS build profile so the dev-client APK can reach the Live entry point. But `__tests__/vtoLiveFeatureGate.test.js` ("flag: no EAS profile sets it -- production and staging included") iterates **every** profile in `eas.json` and asserts none of them defines `EXPO_PUBLIC_LIVE_VTO_ENABLED` or `EXPO_PUBLIC_LIVE_VTO_HARNESS` -- no profile is exempted, `development` included. This test is part of the already-merged, hostile-audited P3-C Live VTO contract (integration `4365cebf`, pre-N1), not something N1 authored.

**Root cause:** the mission's amendment B1 was written before (or without accounting for) the P3-C contract's own launch-posture test. The two are drafted from different vantage points: B1 assumes no such test exists; the merged codebase already closes exactly this door, deliberately, with a named test.

**Resolution (per amendment B3 -- "if scaffold and merged contract diverge, the merged contract governs, record the divergence"):** did **not** edit `eas.json`. `development` keeps `EXPO_PUBLIC_LIVE_VTO_ENABLED` absent, same as every other profile; `vtoLiveFeatureGate.test.js` stays green, unmodified. N1's own local verification builds use a gitignored `.env.local` instead (see the environment doc) -- Expo's local dev/build tooling reads `EXPO_PUBLIC_*` from `.env.local`/shell env for a local `expo run:android`/gradle build, which never touches the committed eas.json profiles the test inspects. This gives N1 a real way to exercise the flagged-on code path for its own verification without weakening the customer-facing launch posture the test protects.

**Outcome:** not a bug to fix -- a policy conflict between an amendment and a merged test, resolved in the merged test's favor. If the owner wants the dev-client APK itself (the section 49 installable deliverable) to ship with Live reachable out of the box, that requires either amending `vtoLiveFeatureGate.test.js` itself (an explicit, reviewed decision to narrow its assertion) or accepting that the dev-client APK needs the same local `.env.local`/`--build-env` treatment at install time. Deferred to an owner decision at N1-G, not resolved unilaterally here.

## N1-ENV-002 (P2) -- mission's illustrative capability JSON diverges from the merged native-module TS contract

**Found:** N1-A implementation, before writing the Kotlin module.

**What:** Mission section 5 gives an illustrative initial capability payload:
```json
{ "moduleAvailable": true, "runtimeReady": false }
```
The actual merged application adapter (`services/vto/liveVtoNativeModule.ts`, `LiveVtoNativeSelfCheck`) defines the real, tested shape as:
```ts
{ capable: boolean; runtimeReady: boolean; runtimeVersion?: string | null }
```
There is no `moduleAvailable` field anywhere in the merged contract -- module presence is a fact the JS **adapter** derives from whether `requireOptionalNativeModule` found anything at all (`LiveVtoNativeCapability.present`), not something the native `getCapability()` call reports about itself.

**Resolution (per amendment B3):** the Kotlin module's `getCapability()` returns `{capable, runtimeReady, runtimeVersion}` -- the real, merged, tested field names -- not the mission's illustrative ones. Both `capable` and `runtimeReady` are `false` at N1-A: no device-eligibility check has been implemented yet, and claiming `capable: true` with nothing behind it would repeat exactly the "registration is not capability" mistake `liveVtoNativeModule.ts`'s own header comment warns against. `capable` becomes a real, evidenced device check no earlier than the gate that actually implements one (not yet decided which -- likely N1-E/N1-F, alongside the perception/camera capability checks).

**Outcome:** resolved in the merged contract's favor, no test or app-layer change needed. Recorded so a later session doesn't "fix" the native module back toward the mission's illustrative shape.

## N1-ENV-003 (P2, build infrastructure) -- literal `--` inside XML manifest comments breaks every local Gradle Android build

**Found:** N1-A, first `./gradlew :app:assembleDebug` attempt in this worktree.

**Reproduction:** `./gradlew :app:processDebugMainManifest --stacktrace` -> `com.android.manifmerger.ManifestMerger2$MergeFailureException: Error parsing android/app/src/main/AndroidManifest.xml` -> `Caused by: org.xml.sax.SAXParseException; lineNumber: 31; columnNumber: 55; The string "--" is not permitted within comments.`

**Root cause:** the XML 1.0 spec forbids the two-character string `--` anywhere inside a comment body, not only at its `<!--`/`-->` boundaries. Android's manifest-merger parses with a strict validating Xerces SAX parser that enforces this as a fatal error rather than tolerating it (many lenient XML/HTML tools do tolerate it, which is presumably why this survived unnoticed). `android/app/src/main/AndroidManifest.xml` line 31 (the mailto `<queries>` rationale comment) and six more occurrences across `android/app/src/certification/AndroidManifest.xml`'s Voice Scan comment block all used `--` as a prose parenthetical dash -- the same style used throughout this codebase's `.ts`/`.js` comments, where it is perfectly legal.

**Scope:** blocks the `main` and `certification` manifest variants of every local Gradle Android build (`assembleDebug`, `bundleRelease`, etc.) on any machine, regardless of which module or lane is being worked on. Not specific to N1 or to the new native module -- discovered only because N1-A was the first lane in the visible history to attempt a genuine from-scratch local Gradle build through to final packaging (prior verification was consistently EAS-cloud-shaped; see the environment doc).

**Repair:** replaced each literal `--` with a comma or semicolon, preserving the comments' meaning exactly. No permission, activity, intent-filter, or `tools:node` directive touched in either file.

**Regression:** `./gradlew :app:processDebugMainManifest` -- BUILD SUCCESSFUL (was FAILED) after the fix, both manifests.

**Outcome:** fixed, committed (`510cbdb`), declared in the integration manifest's authorized boundary (new rows for both `AndroidManifest.xml` paths -- neither was covered by any existing pattern).
