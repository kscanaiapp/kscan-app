# StyleChat Release Readiness QA - 2026-06-12

Scope: Android beta / Google Play readiness smoke plan for the canonical release candidate.

Do not include passwords, secrets, tokens, provider payloads, raw prompts, or API responses in this note or attached logs.

## Manual Smoke Steps

1. Sign in with a known test account.
2. Open StyleChat from the app home surface.
3. Start a new StyleChat session.
4. Send a normal styling message.
5. Confirm the send button disables while the request is pending.
6. Confirm a StyleChat response appears.
7. Send an empty or whitespace-only message and confirm it is blocked.
8. Trigger or simulate a network, burst-limit, or daily-limit error if possible.
9. Confirm the user-facing error copy is friendly and does not expose internals.
10. Navigate away from StyleChat and back.
11. Confirm the session persists and previous messages reload.
12. Confirm a deletion-pending account is routed to Privacy and cannot use StyleChat.
13. Confirm no secrets, auth tokens, raw prompts, raw messages, raw memory payloads, or full provider responses appear in visible logs.

## Notes

- Runtime smoke was not executed in this prompt.
- AAB, APK, EAS Build, EAS Submit, and Play Console actions were intentionally not run.
