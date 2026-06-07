# StyleChat v0.2 — Persistence & Auth

Branch: `feature/stylechat-v0.2`  
Base: `feature/stylechat-v0.1` @ `14299d7 feat(stylechat): add mock premium chat framework`  
Status: Supabase-persisted, RLS-enforced, mock provider only — no live LLM

---

## What Changed from v0.1

v0.1 was a mock-only UI skeleton. Sessions and messages existed only in React state and were lost on app restart.

v0.2 replaces that with:

- Sessions and messages persisted to Supabase on every send
- Session list loaded from Supabase on screen focus
- Messages loaded from Supabase on session mount
- Atomic usage increment via server-side Postgres RPC
- Optimistic UI (instant bubble) + real persist (replace with DB row)
- All auth enforced via RLS — unauthenticated users cannot create or read data
- `MockStyleChatProvider` still generates replies — no live LLM

---

## Migration Status

**Applied:** Yes, to dev project `yzqjvdfgefveprobvvyw` ("K Scan Privacy Controls").  
**Production:** Not applied — do not apply without a separate production deployment plan.

Two migrations were applied:

| File | Applied |
|---|---|
| `supabase/migrations/202606070001_style_chat.sql` | Yes — all 4 tables |
| `supabase/migrations/202606070002_style_chat_usage_rpc.sql` | Yes — RPC function |

Tables created:
- `public.style_chat_sessions` — RLS: users manage own rows
- `public.style_chat_messages` — RLS: users read/insert own rows
- `public.style_memory_events` — RLS: users read own rows only
- `public.style_chat_usage` — RLS: users read own rows only; writes via RPC only

RLS was statically reviewed in v0.1 audit and confirmed applied at runtime in v0.2.

---

## Supabase Project / Environment

| Field | Value |
|---|---|
| Project | "K Scan Privacy Controls" |
| Project ID | `yzqjvdfgefveprobvvyw` |
| Region | us-west-1 |
| Environment | Development |
| URL | `https://yzqjvdfgefveprobvvyw.supabase.co` |

---

## Repository / Service Files

### New
- `services/style-chat/styleChatRepository.ts` — all Supabase I/O for StyleChat
- `hooks/useStyleChatSessions.ts` — session list hook with `useFocusEffect` reload

### Modified
- `hooks/useStyleChat.ts` — rewired to repository; owns session+message load+persist
- `components/style-chat/StyleChatSessionList.tsx` — accepts `loading`/`error` props
- `app/style-chat/index.tsx` — uses `useStyleChatSessions`
- `app/style-chat/[sessionId].tsx` — uses updated `useStyleChat(sessionId)`

---

## Persistence Flow

### Session List (`app/style-chat/index.tsx`)
1. Screen mounts → `useFocusEffect` triggers `listStyleChatSessions()`
2. Shows loading spinner → sessions list or empty state
3. "NEW SESSION" → `createStyleChatSession()` → navigate to `[sessionId]`
4. On back navigation, screen re-focuses → session list auto-reloads (picks up new/updated sessions)

### Active Chat (`app/style-chat/[sessionId].tsx`)
1. Screen mounts → parallel: `getStyleChatSession()`, `listStyleChatMessages()`, `readStyleChatUsage()`
2. User types → send → optimistic user bubble appended immediately
3. `saveStyleChatMessage({ sender: 'user', ... })` → DB row returned → replaces optimistic entry
4. `MockStyleChatProvider.generateReply()` → 600–900ms delay
5. Optimistic assistant bubble appended
6. `saveStyleChatMessage({ sender: 'assistant', ... })` → DB row → replaces optimistic entry
7. `increment_style_chat_usage()` RPC called atomically
8. On failure: optimistic entries removed, inline error shown with RETRY

---

## Auth and RLS

### Enforcement
- `requireUserId()` in `styleChatRepository.ts` calls `supabase.auth.getSession()` on every operation — user_id is never passed from the UI
- All queries include `.eq('user_id', userId)` as belt-and-suspenders; RLS enforces the same constraint at the database level
- Unauthenticated calls to `requireUserId()` throw `'Sign in to use StyleChat.'` before any Supabase query is made
- Session creation, message reads, message inserts all require an authenticated JWT

### Policy summary
- `style_chat_sessions`: `for all` → `auth.uid() = user_id` (using + with check)
- `style_chat_messages`: select `auth.uid() = user_id`; insert `with check auth.uid() = user_id`
- `style_memory_events`: select-only, `auth.uid() = user_id`
- `style_chat_usage`: select-only, `auth.uid() = user_id`

### Limitation
Full two-user cross-access test was not performed in this milestone. RLS static review confirms the policies are correct. Runtime validation with two distinct authenticated users is recommended before production.

---

## Usage Tracking

**Status: Fully server-side via Postgres RPC.**

The `increment_style_chat_usage()` RPC function:
- Runs as `SECURITY DEFINER` (bypasses RLS but enforces `auth.uid()` internally)
- Does an atomic `INSERT ... ON CONFLICT DO UPDATE` — no read/modify/write race
- Uses calendar-month boundaries (`period_start` = first of month, `period_end` = last of month)
- Returns `(messages_used, messages_limit)` after increment
- Revoked from `public`, granted to `authenticated` only

The client cannot reset or freely update `messages_used`. The `style_chat_usage` table has no client insert/update policy — writes only go through the RPC.

If the RPC call fails (network error), `useStyleChat` falls back to a local `+1` increment so the UI count stays roughly correct for that session. The authoritative count is re-read from Supabase on the next mount.

---

## API Stub Status

The v0.1 mock stubs remain in place and are unchanged:
- `app/api/style-chat/session+api.ts`
- `app/api/style-chat/message+api.ts`

The mobile persistence flow does **not** use these stubs. All session/message I/O goes through `styleChatRepository.ts` → Supabase directly.

The stubs remain as documented backend contract placeholders. They are clearly marked "Not production-safe" in-file. They should not be called from the mobile app for any v0.2 flow.

---

## Known Limitations

1. **Message pagination not implemented.** All messages for a session are fetched on mount. If a session exceeds ~100 messages, this will become a performance concern. Add cursor-based pagination before enabling long-lived conversations.

2. **Session title is always "New Styling Session".** v0.2 does not auto-generate titles from conversation content. Rename support or auto-titling is a future enhancement.

3. **`style_memory_events` not written.** Memory event extraction from conversations is not wired. The table exists and is read-only for the client; server-side writes are a future milestone.

4. **Two-user RLS validation not performed.** RLS policies are correct by static review. Runtime cross-user testing is recommended before production.

5. **Keyboard behavior needs physical-device confirmation.** `KeyboardAvoidingView` with `behavior="padding"` (iOS) and `behavior="height"` (Android) is structurally correct and matches the auth screen pattern, but has not been tested on physical hardware for this layout.

---

## Follow-ups Before Live LLM Integration

In priority order:

1. **Physical-device keyboard test** — iOS and Android
2. **Two-user RLS validation** — confirm cross-user access is blocked at runtime
3. **Message pagination** — add before sessions can grow beyond ~100 messages
4. **Cost controls confirmed working** — verify `increment_style_chat_usage` RPC rejects calls after limit in a test scenario before wiring any real provider
5. **Real `StyleChatProvider` implementation** — swap `const provider = new MockStyleChatProvider()` in `hooks/useStyleChat.ts` with a provider that calls a backend route; that route must verify JWT, check usage limit server-side, then call the LLM
6. **Session titles** — auto-generate from first user message or allow rename
7. **`style_memory_events` writes** — wire server-side extraction after LLM is connected
8. **Production migration** — apply both SQL files to production Supabase project with a separate deployment plan
