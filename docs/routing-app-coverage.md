# Routing App Coverage File — DO NOT UPLOAD

## Status: PROHIBITED for K Scan AI

**K Scan AI must never have a Routing App Coverage File attached in App Store
Connect.** Doing so caused Apple to reject Build 32 (1.0.1) with an Invalid
Binary error.

## The Build 32 rejection

Apple's exact validation error was:

```
ITMS-90118: Invalid routing app setting:
To upload a routing app coverage file on App Store Connect,
you must define the app binary as a routing app.
```

### Why it happened

An earlier revision of this document instructed the release owner to upload
`assets/routing-app-coverage.geojson` to
**App Store Connect > App Information > Platform Version Information > Routing
App Coverage File** as a "proactive compliance measure."

That advice was wrong. The Routing App Coverage File is not a general
availability or "regions we operate in" declaration — it is reserved
exclusively for turn-by-turn navigation apps. Apple validates it against the
binary: if a coverage file is present but the binary does not declare itself a
routing app (via `MKDirectionsApplicationSupportedModes`), the upload is
rejected as an invalid binary.

K Scan AI is a fashion discovery and scanning application. It provides no
turn-by-turn navigation, no route guidance, and no vehicle navigation.
Location is used only for foreground, weather-aware styling suggestions in
StyleChat (`services/weather/weatherStylingContext.ts`).

### The fix

There are two mutually exclusive ways to clear ITMS-90118. Only the first is
correct for this product:

1. **Remove the Routing App Coverage File from App Store Connect.**  ← correct
2. Declare the binary as a routing app.  ← **must not be done**

Adding `MKDirectionsApplicationSupportedModes`, Apple Maps routing
capabilities, or any other routing declaration to satisfy the coverage file
would misrepresent the product to App Review and is prohibited.

The superseded GeoJSON asset (`assets/routing-app-coverage.geojson`) has been
deleted from the repository. It was referenced by no code, no configuration,
and no build step — it existed solely to be uploaded to App Store Connect.

## Owner checklist — every iOS submission

- [ ] App Store Connect > App Information > Platform Version Information >
      **Routing App Coverage File is empty**
- [ ] Re-check that field **after** creating the new submission — creating a
      submission can surface a previously attached file
- [ ] `MKDirectionsApplicationSupportedModes` is absent from the compiled
      `Info.plist`
- [ ] No Apple Maps routing entitlement or capability is present

## Guardrail

`__tests__/routingAppCoverage.test.js` fails the build if a routing
declaration or a routing coverage asset is reintroduced into the source tree.

## References

- [Apple — App Store Connect: Platform Version Information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
