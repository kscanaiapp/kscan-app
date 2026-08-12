# Build 29 Session Replay Readiness

## Verdict

**NOT_AUTHORIZED for Build 29** and **READY_FOR_LATER_IMPLEMENTATION only after privacy owner decisions**.

As of the Sentry provider integration a replay-capable SDK IS installed
(`@sentry/react-native` 8.22.0). Capability is therefore no longer the reason
replay is off — policy is. The Sentry wizard enabled replay by default
(`replaysSessionSampleRate: 0.1`, `replaysOnErrorSampleRate: 1`); that
configuration was removed and replaced with two independent barriers.

Build 29 does not activate replay. Staging replay is off. Production replay is off. Error monitoring remains independent of replay scaffolding.

## Capability discovery

| Question | Result |
| --- | --- |
| Does the current monitoring provider support mobile replay? | Yes — Sentry (`k-scan-ai/react-native`) supports mobile replay. |
| Does the installed SDK support replay? | Yes — `@sentry/react-native` 8.22.0 ships `mobileReplayIntegration`. |
| Camera/gallery blocking available? | Provider-claimed, NOT validated by K Scan privacy review. |
| Image blocking available? | Provider-claimed, NOT validated by K Scan privacy review. |
| Text masking available? | Provider-claimed, NOT validated by K Scan privacy review. |
| Error-linked replay available? | Yes, via `replaysOnErrorSampleRate` — deliberately not configured. |
| Sampling configuration available? | Yes — deliberately not configured. |
| Retention controls available? | Provider-side only; no K Scan retention decision has been made. |
| Environment isolation available? | Yes — the provider is authorized on the staging line only. |
| Kill switch available? | Yes, and it is engaged. See "How replay is held off" below. |

## How replay is held off

Two independent barriers, either of which alone is sufficient:

1. **Replay is never requested.** `buildProviderOptions` emits no
   `replaysSessionSampleRate`, no `replaysOnErrorSampleRate`, and no
   `_experiments` block. The SDK installs `mobileReplayIntegration` only when
   one of those sample rates is a number, so the integration is never created.
2. **Replay is stripped if it ever appears.** `filterProviderIntegrations` runs
   over the SDK's own default integration list at init time and removes anything
   matching `/replay|screenshot|viewhierarchy/i`. `Screenshot` and
   `ViewHierarchy` are refused for the same reason replay is: they attach
   rendered app surfaces to ordinary error events.

`beforeSend` additionally returns `null` for `replay_event` and `replay_video`.
This is defence-in-depth against a future SDK change, **not** a third barrier:
the SDK does not route replay envelopes through `beforeSend` at all, so that
check would not intercept a replay produced by the current version. The two
barriers above are what actually hold replay off.

Certified by `__tests__/observabilitySentryProvider.test.js`:
`replayCanActivate` proves sample rates in either location are detected, and
that the shipped options set cannot activate capture.

## Never-record policy

Any later replay design must prevent capture of these surfaces and data classes before staging activation:

- Scanner source images and camera frames
- gallery/photo-library thumbnails
- Mirror Selfies, garment crops, person/face information
- Closet images and storage references
- Elise attachments, messages, prompts, and AI responses
- Dressing Room images, messages, notes, and private collaboration content
- emails, passwords, tokens, authorization headers, signed URLs, and storage paths
- account-deletion/export/correction contents
- checkout, payment, and private commerce information

Face blur or Privacy Lens is not sufficient replay protection. Replay requires its own masking/blocking enforcement and hostile privacy validation.

## Required gates for a later phase

1. Owner selects or approves a monitoring provider/account/project and any paid plan.
2. Privacy review confirms masking/blocking semantics for React Native native views, camera/gallery views, images, text inputs, WebViews, and custom native modules.
3. Replay defaults off for malformed/missing configuration and stays off in production.
4. Environment-specific destinations and retention controls are verified.
5. Error reporting is proven to function when replay is disabled or fails.
6. Authorized staging activation is tested on physical iOS and Android devices for privacy, performance, storage, and network cost.
7. Production activation receives a separate explicit decision.

## Build 29 decision

- **Build 29 replay implemented:** no
- **Disabled configuration invariant:** yes (`replayEnabled: false`)
- **Development replay enabled:** no
- **Staging replay enabled:** no
- **Production replay enabled:** no
- **Wizard-default replay configuration:** removed
- **Build 29 blocker:** no
