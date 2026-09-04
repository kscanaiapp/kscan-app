# LiveVTO sandbox app — status

**Not run in this session.** No `npm install && expo start` was executed
here; there is no camera, no simulator, and no physical device attached to
this cloud sandbox to render anything into. `App.tsx` is illustrative
source showing how the pieces built so far (`@kscan-live-vto/contract`'s
guidance/command/event types, `@kscan-live-vto/garment-contract`'s
`.ksgarment` schema) are meant to compose in a real Expo dev-client app —
it is not proof that any of it renders or behaves correctly on a device.

To actually exercise this (outside this session, on a machine with Xcode
or Android Studio and a physical device):

1. `cd kscan-live-vto && npm install`
2. Register the `LiveVTO` Expo module (see `native/expo-module.config.json`
   — this has not been wired into any `app.json`/`Podfile`/`settings.gradle`
   anywhere, including this sandbox's own `app.json`, which does not yet
   exist).
3. Build a dev client: `npx expo run:ios` / `npx expo run:android` — never
   Expo Go (Section 10: native views aren't supported there).

This app is never added to the production `kscan-app` root
`package.json`/workspaces — see `kscan-live-vto/README.md`.
