# Google Play Reviewer Notes Draft - 2026-06-12

Scope: Android release candidate `release/android-1.0.0` at local commit `4b93bda20d824c285910eff201d1a7bd0fd0a3d6`.

Passwords/secrets included in this note: no.

Do not paste real reviewer passwords into repository files.

## App Access

```text
Reviewer Account: [Operator to provide in Play Console]
Email: demo@kscan.app or operator-provided account
Password: [Operator to provide in Play Console - do not store in repo]
```

Do not submit a deletion request using the primary demo account if that account is needed for multiple review rounds. Use a disposable reviewer account for destructive lifecycle testing.

## Core Test Path

1. Install app.
2. Sign in with provided reviewer credentials.
3. Open Home / scan flow.
4. Open StyleChat.
5. Open Dressing Rooms.
6. Open Privacy screen.
7. Confirm data export/correction request options.
8. Confirm account deletion request path.
9. Submit deletion request only if using a disposable reviewer account.
10. After request, confirm pending-deletion status and limited access behavior.

## API Limits Warning

```text
StyleChat uses standard anti-abuse usage limits to protect service reliability. If rapid repeated requests are sent, the reviewer may see a friendly limit message. This is expected behavior and not an app crash.
```

## Account Deletion Reviewer Note

```text
Users can request account deletion in the app from the Privacy screen or through the web delete-account path. Once a request is submitted, the app marks the account as pending deletion, limits normal app access, and provides a clear sign-out path. Requests are processed through our account lifecycle workflow, generally within 30 days, subject to legal, security, and operational requirements.
```

## Image Upload Reviewer Note

```text
K Scan is intended for clothing-focused images. Users should avoid uploading faces, bystanders, or sensitive personal information.
```

## AI / StyleChat Reviewer Note

```text
StyleChat is private to the authenticated user and uses usage limits to protect service reliability. The app does not expose provider API keys in the mobile client.
```

## Dressing Rooms Reviewer Note

```text
Dressing Rooms are private by default. Users can choose to share token-based previews.
```

## Known Non-Blocking Release Notes

- Data Safety finalization is still pending owner review.
- Complete automated deletion is not claimed.
- Supabase Storage cleanup and StyleChat burst usage cleanup are tracked follow-ups.
- Runtime smoke and AAB/internal-track validation are deferred to the final packaging phase.

## Release Decision

REVIEWER NOTES DRAFT STATUS: PASS WITH NOTES - SAFE FOR OWNER REVIEW BEFORE PLAY CONSOLE ENTRY
