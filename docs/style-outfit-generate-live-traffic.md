# style-outfit-generate — which paths carry live traffic

Status: current as of Phase 6 (2026-07-30). Applies to the deployed function
`style-outfit-generate` in project `wyyuqfdxucjksghsmhry`.

This document exists **outside the edge bundle on purpose**. The correction below
belongs in the deployment record, not in `index.ts`: that file's bytes are part of
the deployed bundle hash, so editing a comment there forces a new function version.
During an active audit that is the wrong trade — it would mean deploying to
production to synchronise prose. Keep operational truth here; keep `index.ts`
byte-identical to what is deployed.

## The correction

The banner in `supabase/functions/style-outfit-generate/index.ts` says:

> Its only client caller, services/styleOutfits.ts, is still gated OFF by
> AI_STYLIST_BACKEND_ENABLED, so the unversioned path carries no live traffic

**That is false, and it has already caused one production incident.**

`eas.json` sets the gate open in the shipping profile:

| EAS profile   | `EXPO_PUBLIC_AI_STYLIST_BACKEND_ENABLED` |
|---------------|------------------------------------------|
| `production`  | **`"true"`**                             |
| `preview`     | absent (→ off)                           |
| `development` | absent (→ off)                           |

So production builds of the legacy AI Stylist call `generateOutfits()` in
`services/styleOutfits.ts`, which invokes this function's **unversioned** path.
The claim looks true from a dev or preview build, which is how it survived review.

### Why it matters

The Phase 5 HTTP 401 incident was exactly this misreading. An authentication change
on the unversioned path was reasoned about as traffic-free and shipped; it broke live
AI Stylist requests for production users. See the hotfix commits `ada2dfe` and
`f89ba25`, and the client session preflight in
`services/authenticatedFunctionSession.ts`.

**Treat any change to the unversioned path as user-facing.** Verify against the
`production` profile in `eas.json`, never against a dev build.

## What is genuinely dark

The **versioned** private Dressing Room path (`schemaVersion:
"private-dressing-room-elise-v1"`) carries no traffic from released clients. Its
client gate is `PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE` and its parent flags, and
none of them appear in any EAS profile — `production` included. That path is
reachable only by an explicitly opted-in local build.

This asymmetry is the point: one contract in this function is live, the other is not.

## Verifying this document

```bash
node -e "const j=require('./eas.json');for(const [n,p] of Object.entries(j.build))console.log(n, p.env?.EXPO_PUBLIC_AI_STYLIST_BACKEND_ENABLED ?? '(absent)')"
```

If the `production` row ever reads `(absent)` or `"false"`, this document is stale
and the `index.ts` banner becomes correct again. Update both together.
