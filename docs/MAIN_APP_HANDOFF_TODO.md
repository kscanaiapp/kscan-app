# Main Mobile App Handoff TODO

## Goal

Document the future work required in the **main K Scan mobile app repo** to support glasses handoff deep links, without modifying the main repo in this run.

## Deep Link Registration

The main app must register the following `kscan://` schemes in its `AndroidManifest.xml` and/or iOS `Info.plist`:

```
kscan://glasses/handoff/result/{resultId}
kscan://glasses/handoff/save/{itemId}
kscan://glasses/handoff/open/{resultId}
kscan://glasses/session/request
```

## Required Tasks

### 1. Register Deep Link Handlers

- Android: Add `<intent-filter>` with `<data android:scheme="kscan" android:host="glasses" />`
- iOS: Add URL type for `kscan` scheme with `glasses` path prefix
- Expo (if using): Configure `expo-linking` or `expo-router` to handle `kscan://` URLs

### 2. Handle Result Open

- Route: `kscan://glasses/handoff/open/{resultId}`
- Action: Open the full result detail screen in the app
- Show product matches, retailer info, price, and image
- Deep link to the appropriate Dressing Room or Closet context

### 3. Handle Save Request

- Route: `kscan://glasses/handoff/save/{itemId}`
- Action: Save the item to the user's Closet
- Show confirmation toast/notification
- If user is not authenticated, prompt for sign-in

### 4. Handle Session Request

- Route: `kscan://glasses/session/request`
- Action: Return current session state to the glasses app
- Include lightweight session snapshot (no tokens in the response)
- The glasses app can use this to sync scan count, last activity, etc.

### 5. Show Full Result from Glasses

- When a deep link is received, the app should parse the `resultId`
- Fetch the full result from the backend or local cache
- Display the result in the app's native UI (not a webview)
- Support sharing the result to social media or messaging apps

### 6. Receive Placeholder Result IDs

- Result IDs from the glasses app are placeholder refs only (e.g., `result-123`)
- The main app should validate the ID format and reject malformed values
- Placeholder IDs may be replaced with real backend IDs once the full pipeline is live
- For now, the app can show a mock result or a "Coming Soon" placeholder

### 7. Route to Closet / Dressing Room

- Save requests should route to the Closet tab
- Open requests may route to Dressing Room if the item is a fashion look
- Maintain the app's existing navigation stack and state

### 8. Auth / Session Rules

- The main app is the source of truth for auth state
- Glasses app does not hold auth tokens; it requests session state from the phone
- All auth operations (sign-in, sign-out, token refresh) happen in the main app
- If the glasses app requests an action that requires auth, the phone app should handle it
- Session sharing between glasses and phone will use Supabase in a future phase

## Out of Scope for This Phase

- Real deep-link implementation in the main app (requires main app repo changes)
- Auth token sharing protocol (requires Supabase integration)
- Real-time sync between glasses and phone (requires Supabase realtime)
- Bluetooth/Wi-Fi transport (deep links are sufficient for Phase 2/3)

## Recommended Priority

1. **P1:** Register deep-link handlers and route to appropriate screens
2. **P2:** Handle save and open actions with mock/placeholder data
3. **P3:** Session request and auth state sharing
4. **P4:** Real-time sync and full result hydration

## Notes for Main App Team

- This document lives in the Google glasses repo only
- The main app repo is not modified in this Phase 2/3 run
- When the main app team is ready, they can use this TODO as a specification
- The `kscan://` scheme is reserved and not yet registered in the main app
