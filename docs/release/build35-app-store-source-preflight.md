# Build35 App Store source preflight

BLOCKED. Applied the requested app-store-preflight-skills checklist to React Native/Expo source; current Apple primary guidelines and third-party SDK requirements were consulted. No ASC write, build, submission, new installation or legal rewrite.

Confirmed source defects: Gemini disclosure/version and before-transfer authority repairs #645/#649 remain unmerged; B35-C-005 durable withdrawal remains owner-gated. Apple's5.1.2(i) covers explicit permission before sharing personal data with third-party AI, and5.1.1(ii) covers withdrawal. [Official guidelines](https://developer.apple.com/app-store/review/guidelines/#privacy). These are source-level risks, not a claim of a signed-binary rejection.

Local verify-apple-readiness.js exit0 at c1348ed4. Source has camera/photo/microphone/speech/location purpose strings, Apple sign-in integration, nine declared collected-data categories and two required-reason API categories. Three script warnings: ASC app ID not encoded in eas.json; App Review contact/demo account not encoded in store.config.json; signing credentials require Apple Developer validation. These warnings are missing submission/config evidence, not automatic product defects. No versions incremented.

No ios Xcode directory in this Expo checkout is itself not a missing-binary defect. App config/plugin declarations must be verified in the separately authorized generated native project and signed privacy report, including every required third-party SDK manifest/signature. [Official SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/).

Subscription live store read confirms current US0.99/9.99 and one-month trials; Apple READY_TO_SUBMIT remains an external release gate. In-app/ASC metadata links, store screenshots, review account, UGC report/block/moderation enforcement, full Privacy Nutrition Label/Data Safety consistency and effective artifact permissions remain separately unverified. Shared room report/block source exists; this is not an operational moderation-response certification. No universal24h response claim.

Requested android-performance: adb available, zero targets. No CPU/frame/heap trace or metric claimed; no binary installed/built. Requested SwiftUI performance audit: no import SwiftUI, UIHostingController or SwiftUI View found in module sources; main client is React Native, native modules use other architectures. SwiftUI-specific body/ForEach invalidation advice is NOT APPLICABLE; iOS native frame budget remains NOT TESTED without supported hardware/Instruments. No speculative performance optimization made.

Requested vercel:build-agents read; established stack retained, no framework scaffolded. Requested review-agent not present in installed skill catalogs/tools; direct review used, no fictitious subagent sign-off.
