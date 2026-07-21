# DR-2 Platform Parity Matrix

Architecture: shared React Native/Expo. `android/` present. No checked-in `ios/` native project (Expo-managed).

| Capability | SHARED SOURCE | ANDROID SOURCE | IOS SOURCE | ANDROID STATIC | IOS STATIC | ANDROID RUNTIME | IOS RUNTIME | PHYSICAL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| owned room ref | SHARED SOURCE VERIFIED | ANDROID SOURCE VERIFIED (via RN) | IOS SOURCE VERIFIED (via RN) | ANDROID STATIC VERIFIED (app.json) | IOS STATIC VERIFIED (app.json) | NEXT-BUILD GATE | NEXT-BUILD GATE | PHYSICAL GATE |
| shared room ref | SHARED SOURCE VERIFIED | same | same | same | same | NEXT-BUILD GATE | NEXT-BUILD GATE | PHYSICAL GATE |
| attachment semantics | SHARED SOURCE VERIFIED | same | same | same | same | NEXT-BUILD GATE | NEXT-BUILD GATE | PHYSICAL GATE |
| adviceMetadata optional | SHARED SOURCE VERIFIED | same | same | same | same | NEXT-BUILD GATE | NEXT-BUILD GATE | PHYSICAL GATE |
| stale-response cancel | SHARED SOURCE VERIFIED (`sendScopeVersion`) | same | same | — | — | NEXT-BUILD GATE | NEXT-BUILD GATE | PHYSICAL GATE |
| content:// file:// ph:// | contract excludes wire URIs | ANDROID URI notes | IOS URI notes | — | — | NEXT-BUILD GATE | NEXT-BUILD GATE | PHYSICAL GATE |
| flags OFF / old client | SHARED SOURCE VERIFIED | same | same | — | — | NEXT-BUILD GATE | NEXT-BUILD GATE | PHYSICAL GATE |

PRODUCTION: no deploy. Evidence: `__tests__/dr2PlatformParity.test.js`.
