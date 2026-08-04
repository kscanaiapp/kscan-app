# StyleChat v0.4 — Live AI Integration: Secure Gemini Beta

> **Status**: Implementation complete. Runtime validation pending Gemini API key configuration and Edge Function deployment.

---

## 1. Architecture

```
Mobile StyleChat UI
  ↓  (tap Send)
useStyleChat (hooks/useStyleChat.ts)
  ↓  generateReply({ sessionId, message })
EdgeStyleChatProvider (services/style-chat/providers/edgeStyleChatProvider.ts)
  ↓  supabase.functions.invoke('stylechat-generate', { body, signal })
  ↓  Authorization: Bearer <user JWT>  ← auto-injected by supabase-js
stylechat-generate (supabase/functions/stylechat-generate/index.ts)
  ↓  auth.getUser() → verify JWT
  ↓  increment_stylechat_daily_usage() → atomic quota check
  ↓  style_chat_messages → last 6 messages
  ↓  dressing_room_items + reactions → compact memory text (≤500 chars)
  ↓  fetch → Gemini Flash REST API (GEMINI_API_KEY server-side only)
Mobile (response)
  ↓  saveStyleChatMessage() → persist assistant row
  ↓  update UI + usage display
```

**NOT this:**
```
Expo App → Gemini API   ← PROHIBITED — key would live in bundle
```

---

## 2. Backend Path Selected

**Supabase Edge Function** (`supabase/functions/stylechat-generate/index.ts`)

Reasons:
- Established pattern: 7 existing Edge Functions in this repo
- Server-side secret storage via `supabase secrets set`
- Authenticated Supabase JWT validation via `auth.getUser()`
- Co-located with RLS/data access for context assembly
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` auto-injected
- No separate backend service needed

Expo Router API routes (`app/api/style-chat/`) are **not** the live AI path. They are deprecated mock stubs retained for reference only.

---

## 3. Secure Proxy

**Function name:** `stylechat-generate`
**File:** `supabase/functions/stylechat-generate/index.ts`
**Runtime:** Deno (Supabase Edge Functions)
**Import:** `npm:@supabase/supabase-js@2` (Deno npm specifier)
**HTTP:** Raw `fetch()` to Gemini REST API — no Gemini SDK dependency

---

## 4. Server-Side Secret Strategy

All secrets live exclusively in Supabase project secrets. The Gemini API key is **never** placed in:
- The Expo app bundle
- Any `EXPO_PUBLIC_` variable
- `.env` files tracked by git
- Documentation or logs

The following variables are auto-injected into every Edge Function by Supabase:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (not used by this function — user JWT client is sufficient)

---

## 5. Required Secrets — Setup Commands

Run once per deployment target. Do not paste real values here.

```bash
# Required for live AI
supabase secrets set GEMINI_API_KEY=<your-gemini-api-key> --project-ref yzqjvdfgefveprobvvyw
supabase secrets set STYLECHAT_GEMINI_MODEL=<stable-flash-model-id> --project-ref yzqjvdfgefveprobvvyw
supabase secrets set STYLECHAT_AI_ENABLED=true --project-ref yzqjvdfgefveprobvvyw
```

To disable Gemini without redeploying:
```bash
supabase secrets set STYLECHAT_AI_ENABLED=false --project-ref yzqjvdfgefveprobvvyw
```

---

## 6. Gemini Model

**Default (code fallback):** `gemini-1.5-flash`

**Configured via:** `STYLECHAT_GEMINI_MODEL` Supabase secret (server-side only)

**Selection rationale:**
- Flash-class only — Pro and reasoning models prohibited for cost/beta control
- `gemini-1.5-flash` was stable GA at time of implementation
- Operator must verify and set `STYLECHAT_GEMINI_MODEL` to the current stable Flash model at deployment time — model availability changes over time
- Do not use any `experimental` or `preview` model for beta

**`maxOutputTokens`:** 200 (enforced server-side)

---

## 7. Kill Switch

**Env var:** `STYLECHAT_AI_ENABLED`

| Value | Behavior |
|-------|----------|
| `true` (or unset) | Live Gemini path active |
| `false` | Returns a safe preview-mode fallback string without calling Gemini |

When kill switch is active, the function returns `status: 'success'` with `model: 'fallback'`. The mobile UI shows this as a normal assistant message — no error state, no crash. The app does not need to be rebuilt to change this.

**Fallback string:**
> "StyleChat AI is temporarily in preview mode. I can still help you think through outfit ideas, but live AI styling is paused right now."

---

## 8. Beta Cap

**Limit:** 25 AI responses per authenticated user per calendar day

This is a beta testing cap only. Paid tier caps (`$0.99`, `$1.99`, higher) will be decided after Android/iOS beta usage data is collected. Do not implement tier-specific caps in v0.4.

---

## 9. Daily Usage Storage

**Decision: Option B — dedicated `style_chat_daily_usage` table**

Rationale: The existing `style_chat_usage` table uses monthly period tracking (`period_start = first of month`) with a unique `(user_id, period_start)` constraint. Adding daily rows (`period_start = current_date`) would coexist but could confuse future developers and the existing monthly RPC. A separate table is cleaner.

**Migration:** `supabase/migrations/202606070005_stylechat_daily_usage.sql`

**Schema:**
```sql
style_chat_daily_usage (
  id            uuid PRIMARY KEY,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  usage_date    date NOT NULL DEFAULT current_date,
  messages_used integer NOT NULL DEFAULT 0 CHECK (messages_used >= 0),
  created_at    timestamptz,
  updated_at    timestamptz,
  UNIQUE (user_id, usage_date)
)
```

**RLS:** Enabled. Users may SELECT their own rows. Writes are server/RPC-only — no direct client INSERT/UPDATE policy.

---

## 10. Atomic Usage Enforcement

**RPC:** `increment_stylechat_daily_usage()` — `SECURITY DEFINER`

**Pattern (atomic, race-safe):**
```sql
-- 1. Ensure today's row exists (no-op on conflict)
INSERT INTO style_chat_daily_usage (user_id, usage_date, messages_used)
  VALUES (auth.uid(), current_date, 0)
ON CONFLICT (user_id, usage_date) DO NOTHING;

-- 2. Atomically increment ONLY if under limit
UPDATE style_chat_daily_usage
  SET messages_used = messages_used + 1
  WHERE user_id = auth.uid()
    AND usage_date = current_date
    AND messages_used < 25
RETURNING messages_used;
-- If UPDATE returns NULL → quota exhausted, do not call Gemini
```

**Returns:** `(messages_used, messages_limit, limit_reached)`

The Edge Function checks `limit_reached` before initiating any Gemini call. If `true`, returns `status: 'limit_reached'` immediately.

**Grant:** `EXECUTE` granted to `authenticated` role only. Revoked from `public`.

---

## 11. UTC Reset Rule

Usage resets at UTC midnight. PostgreSQL `current_date` on Supabase infrastructure uses UTC. A new calendar date produces a new row with `usage_date = current_date`, effectively resetting the count.

`resetAt` in the API response is calculated as next UTC midnight:
```ts
const nowMs = Date.now();
const resetAt = new Date(nowMs - (nowMs % 86_400_000) + 86_400_000).toISOString();
```

---

## 12. Request / Response Contract

### Mobile → Edge Function

```ts
// Body (only these two fields — user ID derived from JWT on server)
{
  sessionId: string;  // UUID of the StyleChat session
  message:   string;  // Current user message text, max 500 chars
}
// Authorization: Bearer <supabase JWT>  ← auto-injected by supabase.functions.invoke()
```

### Edge Function → Mobile

**Success:**
```ts
{
  status: 'success',
  message: {
    sender: 'assistant',
    content: string,      // Sanitized, ≤1000 chars, plain text
    model: string,        // e.g. 'gemini-1.5-flash'
    tokenEstimate: number // promptTokenCount + candidatesTokenCount, or 0
  },
  usage: {
    messagesUsed: number,
    messagesLimit: 25,
    resetAt: string      // ISO 8601 UTC next midnight
  }
}
```

**Limit reached:**
```ts
{
  status: 'limit_reached',
  message: {
    sender: 'system',
    content: "You've reached today's StyleChat beta limit. Come back tomorrow for more styling help.",
    model: '',
    tokenEstimate: 0
  },
  usage: { messagesUsed: 25, messagesLimit: 25, resetAt: string }
}
```

**Error / Gemini failure:**
```ts
{
  status: 'error',
  message: {
    sender: 'assistant',
    content: "I'm having trouble generating styling advice right now. Please try again shortly.",
    model: string,
    tokenEstimate: 0
  },
  usage: { messagesUsed: number, messagesLimit: 25, resetAt: string }
}
```

---

## 13. Context Window Strategy

**Total context sent to Gemini:**
- System prompt (server-side, fixed text, ~400 tokens estimated)
- Style memory text: ≤ 500 characters (compact formatted text)
- Conversation history: last 6 messages from `style_chat_messages` (max 3 user, max 3 assistant, most recent)
- Current user message (max 500 characters)

**Memory text format:**
```
Brands they like: Nike, Levi's, Zara. Common wardrobe: jeans, sneakers, jackets. Preferred colors: navy, white, grey. Budget range: $50–$150
```
Assembled server-side from `dressing_room_items` and `dressing_room_item_reactions`. Bounded to 500 characters.

**What is NOT sent to Gemini:**
- Raw image data or URLs
- Base64-encoded images
- User email, phone, or ID
- Auth tokens
- Protected characteristics (race, religion, gender, body type, health)
- Raw Supabase row objects
- Raw scan results
- Raw Dressing Room payloads
- Full chat history (only last 6 messages)

---

## 14. Prompt Safety Strategy

**System prompt location:** Server-side only, inside the Edge Function constant `SYSTEM_PROMPT`. Not in the mobile bundle.

**Injection defense:**
- User message appended to Gemini `contents[].parts[].text` — never concatenated into the system instruction
- Memory context is appended to the system prompt with a labelled section ("User style context (use as background only)") — memory data is trusted server-side data from the user's own Dressing Room, not user-supplied text
- Gemini `system_instruction` is completely separate from `contents` in the API payload

**Out-of-scope refusal (exact string, enforced by prompt):**
> I am your K Scan styling assistant. I can only provide clothing, look-book, and fashion guidance.

**Scope restriction:** Prompt instructs model to stay within clothing, outfits, wardrobe, color matching, occasion dressing. Refuses medical, legal, financial, mental health, illegal, sexual, or hateful content.

---

## 15. Response Sanitization

Applied server-side in `sanitizeResponse()`:
1. Trim leading/trailing whitespace
2. Strip markdown code fences (` ``` ` patterns)
3. Enforce 1000-character limit; truncate at last word boundary within 50 chars of limit
4. Return trimmed plain text

**Empty/invalid Gemini response:** Returns safe fallback string, status `error`.

**Gemini error status codes:** Logged as warning (status code + first 200 chars of error body). Never forwarded to the client.

---

## 16. Failure Handling

| Failure mode | Behavior |
|---|---|
| Auth header missing | 401 — no processing |
| JWT invalid | 401 — no processing |
| Session not owned by user | 404 — no quota consumed |
| `sessionId` not valid UUID | 400 — no processing |
| Message over 500 chars | 400 — no processing |
| Quota RPC error | 500 — no Gemini call |
| Quota exhausted | `limit_reached` — no Gemini call |
| `GEMINI_API_KEY` not set | 500 error to mobile |
| Gemini non-2xx | Safe fallback, `status: 'error'` |
| Gemini timeout (12s) | Safe fallback, `status: 'error'` |
| Gemini empty response | Safe fallback, `status: 'error'` |
| Mobile network failure | `EdgeStyleChatProvider` returns `fallbackResult()` |
| Mobile client timeout (16s) | `AbortController` fires; `fallbackResult()` returned |

**Quota consumed on Gemini failure?** Yes — quota is reserved before the Gemini call. If Gemini fails after quota reservation, the slot is consumed. This prevents race-condition abuse at the cost of one slot per failed call. Acceptable for v0.4 beta.

---

## 17. Limit-Reached UI Behavior

When `status === 'limit_reached'`:
1. `useStyleChat` calls `setError(STYLE_CHAT_COPY.systemLimitNotice)` — surfaces as UI error/notice
2. Usage count is updated from the server response
3. The limit notice is **not** persisted as an assistant message in `style_chat_messages`
4. `isSending` is cleared via `finally` block
5. The user's message was already persisted before the server call

The user sees the notice inline. On next app open, `readStyleChatDailyUsage()` re-reads the server count. No crash, no infinite loading.

---

## 18. Privacy Exclusions

The following are **never** sent to Gemini:
- User email / phone / ID
- Auth tokens or JWT
- Protected characteristics
- Body measurements or biometric data
- Raw scan images (JPEG/PNG/base64)
- Image CDN URLs
- Raw Dressing Room item rows
- Full Style Library
- Raw product catalog rows

Memory context is limited to aggregated categorical signals (brand names, category names, color names, price range) — no PII.

---

## 19. Token Metadata Strategy

- `usageMetadata.promptTokenCount + usageMetadata.candidatesTokenCount` summed if available
- Stored as `token_estimate` integer in the `style_chat_messages` row via `saveStyleChatMessage()`
- If `usageMetadata` absent: `tokenEstimate = 0` (logged, not surfaced to user)
- `style_chat_messages` already has a `token_estimate` column — no schema change required

Token data is available for future cost telemetry. No cost dashboard implemented in v0.4.

---

## 20. Validation Results

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **PASS** — zero errors |
| Migration SQL static review | **PASS** — syntactically valid, RLS enabled, atomic RPC correct |
| Edge Function JWT auth review | **PASS** — `auth.getUser()` called, no trust of client user_id |
| Edge Function secret handling | **PASS** — `Deno.env.get('GEMINI_API_KEY')`, never in bundle |
| Mobile Gemini endpoint check | **PASS** — no `generativelanguage.googleapis.com` in mobile TS/TSX |
| `EXPO_PUBLIC_GEMINI` search | **PASS** — not found |
| `AIza` key pattern search | **PASS** — not found |
| Kill switch implementation | **PASS** — `STYLECHAT_AI_ENABLED=false` returns fallback |
| Atomic quota before Gemini | **PASS** — `limitReached` checked, Gemini not called if true |
| Context bounds | **PASS** — 500 char memory cap, 6 message history cap |
| Response sanitization | **PASS** — code fences stripped, 1000 char limit enforced |
| Prompt injection defense | **PASS** — user text in `contents`, not `system_instruction` |
| Limit notice not persisted | **PASS** — `limit_reached` path sets error state only, no `saveStyleChatMessage` |
| Mock provider not deleted | **PASS** — `MockStyleChatProvider.ts` unchanged, importable |
| API stubs deprecated | **PASS** — marked with clear deprecation comments |
| Deno compile check | **SKIPPED** — Deno not installed, Docker not running in this environment |
| Edge Function deploy/serve | **SKIPPED** — not deployed; runtime Gemini call not validated |
| Expo Metro smoke test | **ATTEMPTED** — see Known Limitations |

---

## 21. Known Limitations

1. **No live Gemini call validated**: The `GEMINI_API_KEY` has not been configured and the Edge Function has not been deployed to dev. Live path must be validated by the operator after deployment.

2. **Deno compile check skipped**: Deno not installed in the build environment. Edge Function TypeScript is structurally sound and follows the existing function patterns, but Deno-specific APIs (`Deno.serve`, `Deno.env`, `npm:` specifiers) cannot be statically validated without a Deno runtime.

3. **Kill switch does not consume quota**: When `STYLECHAT_AI_ENABLED=false`, the RPC is not called and quota is not checked. This is intentional for the kill switch path but means kill-switch responses don't count against the daily limit.

4. **Quota consumed on Gemini failure**: If the Gemini call fails after quota reservation, the daily slot is consumed. For v0.4 beta this is acceptable to prevent retry abuse.

5. **History interleaving**: The Edge Function merges consecutive same-role messages (concatenates text) to satisfy Gemini's alternating-turn requirement. This is a best-effort approach and may occasionally produce slightly different formatting from what was stored.

6. **`resetAt` timezone note**: `get_stylechat_daily_usage()` RPC returns `(current_date + interval '1 day')::timestamptz` which resolves at the PostgreSQL server timezone (UTC on Supabase). The mobile `resetAt` value from the Edge Function response uses UTC arithmetic directly. Both should agree on UTC midnight.

---

## 22. Future Tier-Cap Strategy

v0.4 enforces a single flat cap of 25/day for all users. After beta usage data is collected:

- Add a `tier` or `subscription_level` column to the relevant user profile table
- Update `increment_stylechat_daily_usage()` RPC to accept a per-tier limit
- Consider separate limits: free tier 10/day, `$0.99` 50/day, `$1.99` 150/day
- Do not implement tier caps in v0.4 — Android/iOS beta data must inform the numbers

---

## 23. Deployment Checklist (operator steps before exposing to beta)

1. Apply migration via the staging controlled pipeline (`scripts/apply-staging-migration.mjs`) — never `supabase db push --project-ref` (unsupported on installed CLI)
2. Set secrets (see §5)
3. Deploy Edge Function via `scripts/deploy-staging-function.mjs` (or `supabase functions deploy stylechat-generate --project-ref yzqjvdfgefveprobvvyw` for an explicitly approved single function)
4. Test kill switch: set `STYLECHAT_AI_ENABLED=false`, send a StyleChat message, confirm fallback string
5. Test live AI: set `STYLECHAT_AI_ENABLED=true`, send a style question, confirm Gemini response
6. Test quota: consume 25 messages, confirm limit notice on 26th (not persisted as assistant row)
7. Test session isolation: two users, confirm each user's quota is independent
8. Verify Edge Function logs show only redacted fields (no full messages, no PII)
