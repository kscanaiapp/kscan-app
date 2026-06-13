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

## Target Audience Reviewer Note

```text
K Scan is intended for users 18 and older for this first Android release. The app is not directed to children or minors and is not participating in Google Play Families / Designed for Children. The 18+ posture reflects AI-provider, commerce, and privacy scoping; it does not mean the app contains mature content.
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
StyleChat is intended for adult users, is private to the authenticated user, and uses usage limits to protect service reliability. The app does not expose provider API keys in the mobile client.
```

## Dressing Rooms Reviewer Note

```text
Dressing Rooms are private by default. Users can choose to share token-based previews.
```

## AI Processing Reviewer Note

```text
K Scan uses third-party AI services to analyze clothing-focused images and to power StyleChat.
Images may be processed by an external AI provider to return fashion attributes; the app does not
expose provider API keys in the mobile client and does not perform facial recognition, biometric
identification, or person identification. See Data Safety for the corresponding disclosures.
```

## Known Non-Blocking Release Notes

- Final Data Safety answers: see `qa/google-play-data-safety-final-answers-2026-06-12.md` (Prompt 12 — PASS WITH NOTES, Prompt 13 READY).
- Data Safety final packet is canonical for Play Console entry; Play Console entry/submission remain owner actions.
- Complete automated deletion is not claimed.
- Supabase Storage cleanup and StyleChat burst usage cleanup are tracked follow-ups.
- Runtime smoke and AAB/internal-track validation are deferred to the final packaging phase.

## Release Decision

REVIEWER NOTES DRAFT STATUS: PASS WITH NOTES - SAFE FOR OWNER REVIEW BEFORE PLAY CONSOLE ENTRY
