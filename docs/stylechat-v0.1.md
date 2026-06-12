# StyleChat v0.1 — Implementation Note

Branch: `feature/stylechat-v0.1`  
Base commit: `e58b11e fix(android): bump versionCode for Play upload`  
Status: mock-only skeleton, no live LLM, migration not applied  
**Superseded by:** see `docs/stylechat-v0.2.md` — sessions/messages are now persisted, migration applied, usage RPC wired

---

## What Was Built

### Mobile Routes
- `app/style-chat/index.tsx` — session list / landing screen
- `app/style-chat/[sessionId].tsx` — active chat screen

### Components (`components/style-chat/`)
- `StyleChatHeader.tsx` — header with premium badge
- `StyleChatBubble.tsx` — user and assistant message bubbles
- `StyleChatInput.tsx` — fixed bottom input with send button
- `StyleChatUiBlock.tsx` — renders structured `uiBlocks` from assistant replies
- `StyleChatSessionList.tsx` — session list with empty state and new-session CTA

### Hooks
- `hooks/useStyleChat.ts` — core chat hook; wires mock provider, manages messages, error, and sending state
- `hooks/useStyleChatUsage.ts` — in-memory usage counter (v0.1 only; see below)

### Mock Provider and Types (`services/style-chat/`)
- `types.ts` — all StyleChat type contracts (`StyleChatMode`, `StyleChatMessage`, `StyleChatSession`, `StyleChatProvider`, etc.)
- `MockStyleChatProvider.ts` — deterministic mock provider; 600–900ms simulated delay; no network calls
- `buildStyleChatContext.ts` — placeholder context builder; returns empty arrays; safe to extend later

### Constants
- `constants/styleChat.ts` — feature flags, limits, all user-facing copy strings

### API Stubs
- `app/api/style-chat/session+api.ts` — `POST /api/style-chat/session`
- `app/api/style-chat/message+api.ts` — `POST /api/style-chat/message`

### Migration SQL
- `supabase/migrations/202606070001_style_chat.sql` — tables, RLS, indexes (not applied; see below)

---

## Provider Swap Point

`hooks/useStyleChat.ts` contains a single module-level provider instance:

```ts
// hooks/useStyleChat.ts
const provider = new MockStyleChatProvider();
```

This is the only place in the codebase that instantiates a chat provider. No UI component imports the mock directly. To connect a real LLM or API backend, replace this one line with a provider that implements `StyleChatProvider` from `services/style-chat/types.ts`:

```ts
export interface StyleChatProvider {
  generateReply(input: StyleChatInput): Promise<StyleChatResult>;
}
```

Nothing else in the hook or components needs to change for the initial provider swap.

---

## Premium and Usage Placeholders

### `constants/styleChat.ts`

```ts
export const STYLE_CHAT_PREMIUM_REQUIRED = false;
export const STYLE_CHAT_MONTHLY_MESSAGE_LIMIT = 50;
export const STYLE_CHAT_NEAR_LIMIT_THRESHOLD = 5;
```

- `STYLE_CHAT_PREMIUM_REQUIRED` — set to `false` for beta; flip to gate behind a paywall or feature flag
- `STYLE_CHAT_MONTHLY_MESSAGE_LIMIT` — monthly cap shown in UI; v0.1 enforces this in-memory only
- `STYLE_CHAT_NEAR_LIMIT_THRESHOLD` — `isNearLimit` becomes true when remaining messages ≤ this value

### `hooks/useStyleChatUsage.ts`

In-memory only for v0.1. Usage resets on every app restart. Does not read or write to Supabase. Replace with a Supabase query against `public.style_chat_usage` and a server-side increment (Edge Function or RLS-protected route) before counting usage in production.

---

## API Stub Warning

**Neither API stub is production-safe.**

| Route | File |
|---|---|
| `POST /api/style-chat/session` | `app/api/style-chat/session+api.ts` |
| `POST /api/style-chat/message` | `app/api/style-chat/message+api.ts` |

Both stubs:
- Are mock-only (no LLM calls, no database writes)
- Simulate a 600–900ms response delay via local `setTimeout`
- Return static preview copy
- Have no authentication enforcement

Before connecting any real provider or enabling production use, both stubs must be updated to verify a Supabase JWT (`Authorization: Bearer <token>`) on every request. Without auth, any caller can hit the message route without a valid session. The stubs are clearly annotated in-file:

```
// Not production-safe. Auth must be added before enabling real LLM integration.
```

The mobile UI currently uses `MockStyleChatProvider` directly in `useStyleChat.ts` and does not call these routes. The stubs exist as a backend contract placeholder.

---

## Migration Note

**File:** `supabase/migrations/202606070001_style_chat.sql`  
**Status: not applied to any Supabase project (local or remote).**

Tables created by the migration:
- `public.style_chat_sessions`
- `public.style_chat_messages`
- `public.style_memory_events`
- `public.style_chat_usage`

RLS was statically reviewed during the v0.1 audit:
- All four tables have RLS enabled
- Users are restricted to their own rows via `auth.uid() = user_id`
- `style_chat_usage` and `style_memory_events` are client-read-only (no client insert/update policies)
- No public access exists

However, static SQL review does not prove runtime migration success. The migration still needs to be applied and validated against a real Supabase project before any production use. Run `supabase db push` or apply via the Supabase dashboard when ready.

---

## Remaining Follow-ups

These are required before StyleChat exits mock/preview status:

1. **Physical-device keyboard test** — iOS and Android keyboard avoidance behavior (`KeyboardAvoidingView`) needs device confirmation; `behavior="padding"` on iOS and `behavior="height"` on Android are structurally correct but unverified on hardware.

2. **Apply migration** — run `supabase db push` against the target project; validate RLS policies at runtime.

3. **Server-side auth** — add Supabase JWT verification to both API stubs before wiring any real provider.

4. **Session and message persistence** — `useStyleChat.ts` manages messages in local state only; wire to `style_chat_sessions` and `style_chat_messages` tables after migration is live.

5. **Persistent usage tracking** — replace `useStyleChatUsage` in-memory counter with server-side reads/writes against `style_chat_usage`; increment must happen server-side to prevent client manipulation.

6. **LLM adapter only after cost controls** — implement the `StyleChatProvider` interface against a real LLM only after server-side auth, usage limits, and rate limiting are in place.
