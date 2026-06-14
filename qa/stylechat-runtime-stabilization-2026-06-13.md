# StyleChat Runtime Stabilization - 2026-06-13

## Branch / HEAD
- Branch: `feature/purple-gold-electric-theme`
- HEAD: `d393a47248a309f4d7234a594c10745ffff725b7`
- Commit: not committed; patch left for owner review.

## Files Modified
- `supabase/functions/stylechat-generate/index.ts`
- `services/style-chat/providers/edgeStyleChatProvider.ts`
- `services/style-chat/styleChatErrors.ts`
- `hooks/useStyleChat.ts`
- `hooks/useStyleChatSessions.ts`
- `app/style-chat/[sessionId].tsx`
- `components/style-chat/StyleChatInput.tsx`
- `qa/stylechat-runtime-stabilization-2026-06-13.md`

## Discovery Findings
- StyleChat frontend: `app/style-chat/index.tsx`, `app/style-chat/[sessionId].tsx`, `components/style-chat/StyleChatInput.tsx`, `components/style-chat/StyleChatSessionList.tsx`.
- StyleChat service/hook files: `hooks/useStyleChat.ts`, `hooks/useStyleChatSessions.ts`, `services/style-chat/providers/edgeStyleChatProvider.ts`, `services/style-chat/styleChatRepository.ts`.
- StyleChat Edge Function: `supabase/functions/stylechat-generate/index.ts`.
- Current provider path: mobile sends text-only `{ sessionId, message }` to `stylechat-generate`, which calls Gemini via `STYLECHAT_GEMINI_MODEL` or default `gemini-1.5-flash`.
- Current response parsing before patch: first candidate, first text part only; no `finishReason` handling; no incomplete-shape validation; no retry.
- Current frontend response contract: preserved as `{ status, message, usage }`.
- Current message state handling: optimistic user bubble, persisted user replacement, provider call, optimistic assistant bubble, persisted assistant replacement; duplicate sends blocked by `isSendingRef`.
- Current retry behavior: UI retry removed last user message then resubmitted; Edge Function had no model retry.
- Current error handling before patch: hooks could store raw thrown messages such as `TypeError: Network request failed`; session list rendered hook error directly.
- Current safe-area / keyboard handling before patch: `useSafeAreaInsets` was installed and used horizontally, but StyleChat composer did not own bottom inset padding.
- Current logs that might expose user content: modified StyleChat Edge Function logs use short ids, counts, status codes, booleans, character counts, token estimates, and elapsed time; no raw prompt/message/base64/email/token/full user id logging was found or added.
- Pre-edit TypeScript status: `npx tsc --noEmit --pretty false` passed.

## Root Cause Summary
1. Abrupt assistant responses were possible because the Edge Function accepted the first returned text part without checking text shape or `MAX_TOKENS` finish state.
2. Raw offline/network errors could leak because StyleChat hooks stored exception messages directly.
3. Android 3-button navigation overlap was possible because the composer only used safe-area insets for left/right padding.

## Edge Function Response Integrity Changes
- Added the explicit completion instruction contract to the system prompt.
- Increased Gemini output budget from `200` to `320` tokens without changing provider routing or model names.
- Joined all Gemini text parts from the first candidate instead of reading only `parts[0]`.
- Added normalized assistant text validation and incomplete-response detection.
- Added exactly one retry when the first response appears incomplete or Gemini reports `MAX_TOKENS`.
- Added a polished fallback response when retry fails or remains incomplete.
- Preserved the existing `{ status, message, usage }` response shape.

## Frontend Error Handling Changes
- Added `services/style-chat/styleChatErrors.ts` with safe extraction and friendly StyleChat error mapping.
- Mapped offline/network failures to `Connection lost. Check your internet and try again.`
- Updated chat session and session-list hooks to store friendly messages instead of raw thrown errors.
- Updated the Edge provider to preserve safe Edge fallback content and map client-side network/timeout failures.
- Preserved send disabling, duplicate-send prevention, auth/session behavior, and existing message flow.

## Safe-Area / Composer Changes
- Kept the existing StyleChat layout.
- Reused existing `react-native-safe-area-context`; no dependency added.
- Added dynamic bottom padding to `StyleChatInput` so the input/send controls sit above Android system navigation.

## Logging / Privacy Review
- StyleChat remains text-only. The mobile provider sends only `{ sessionId, message }`; no raw images/base64 are sent to the chat provider.
- Edge context uses bounded text history plus compact style signals; no image data routing was added.
- No raw user messages, raw prompts, base64, emails, tokens, full user ids, or API keys are logged in the modified Edge Function.
- Provider routing and model defaults were not changed.
- No Supabase schema, migrations, RLS policies, auth flows, account deletion flows, commerce routing, image-analysis routing, environment variable behavior, or release signing files were changed.

## Validation Commands Run
- `git branch --show-current`: `feature/purple-gold-electric-theme`
- `git status --short`: only StyleChat patch files plus pre-existing untracked QA artifacts.
- `git log --oneline -8`: inspected; HEAD is `d393a47 style(auth): refine V6.2 login screen`.
- Mandatory discovery searches: run for frontend/services, Edge Function, and logging posture.
- Pre-edit `npx tsc --noEmit --pretty false`: pass.
- Post-edit `git diff --check`: pass; line-ending warnings only.
- Post-edit `git diff --stat`: pass; tracked diff reported.
- Post-edit `npx tsc --noEmit --pretty false`: pass.
- Targeted Jest: skipped because Jest is not installed/configured in this repo (`node_modules/.bin/jest.cmd` absent).
- `deno fmt --check supabase/functions/stylechat-generate`: failed due formatter style mismatch across the existing file; not applied to avoid broad formatting churn.
- `deno check supabase/functions/stylechat-generate/index.ts`: pass.
- Manual Edge static checks: pass. No Node-only APIs added, imports remain compatible with existing Edge Function style, no raw secret usage added, provider defaults unchanged, no raw user-content logging added.

## Manual Runtime Test Checklist
1. Open StyleChat authenticated.
2. Send a normal styling question. Expected: complete polished response, no abrupt cutoff.
3. Send a short yes/no styling question. Expected: short valid response is not forced into fallback.
4. Send 3 messages quickly. Expected: send button disables during request; no duplicate sends.
5. Turn Wi-Fi off and send. Expected: friendly offline message: `Connection lost. Check your internet and try again.` No raw TypeError appears.
6. Turn Wi-Fi back on and send again. Expected: StyleChat recovers.
7. Ask for a longer outfit answer. Expected: response finishes with punctuation and a complete thought.
8. Android 3-button nav device. Expected: composer/input/send controls stay above system navigation.
9. Check logs. Expected: no raw prompts, raw messages, emails, tokens, full user ids, or base64 images in logs.

## Remaining Issues
- Runtime validation deferred to owner; no emulator or physical device test was performed in this pass.
- `deno fmt --check` is not a clean gate unless the project elects to adopt Deno formatter output for this Edge Function.
- Pre-existing untracked QA artifacts remain outside this patch.

## Rollback
- Not committed: `git checkout -- supabase/functions/stylechat-generate/index.ts services/style-chat/providers/edgeStyleChatProvider.ts hooks/useStyleChat.ts hooks/useStyleChatSessions.ts app/style-chat/[sessionId].tsx components/style-chat/StyleChatInput.tsx`
- Remove new files if desired: `services/style-chat/styleChatErrors.ts`, `qa/stylechat-runtime-stabilization-2026-06-13.md`
- If staged later but not committed: `git restore --staged <file>` then restore/remove the exact file.

## Final Status
PASS WITH NOTES - runtime validation deferred to owner; manual test checklist provided.
