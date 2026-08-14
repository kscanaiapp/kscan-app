/**
 * One-time, in-memory hand-off of the "deletion request accepted" confirmation
 * across the sign-out transition.
 *
 * WHY THIS EXISTS (IOS-03): the deletion confirmation lived only in an Alert on
 * the Privacy screen. Acknowledging it signs the user out and replaces the route
 * with /auth, so the moment the confirmation is dismissed every trace of it is
 * gone and the user is left on a login screen with nothing to show the request
 * landed. A tester cannot distinguish "accepted" from "silently failed".
 *
 * Deliberate constraints:
 *   * MEMORY ONLY. Nothing is written to AsyncStorage or any route parameter,
 *     so a deletion request can never be inferred from device storage, a deep
 *     link, or a crash log.
 *   * NO PII. The notice carries no email address, no user id, and no
 *     restoration token — only whether the lifecycle was already active and an
 *     optional grace-period date already shown to this user.
 *   * CONSUMED EXACTLY ONCE. `consume()` clears as it reads, so the notice
 *     appears on the auth screen for this completed action and never again on
 *     an unrelated later visit. A cold start begins with no notice.
 */
export type AccountDeletionNotice = {
  /** True when the backend reported an already-active deletion lifecycle. */
  alreadyRequested: boolean;
  /**
   * Grace-period end, ISO-8601, only when the backend supplied a valid one.
   * Never fabricated — absent means the copy must stay generic.
   */
  gracePeriodEndsAt: string | null;
  /**
   * Whether the backend actually delivered the restoration email for THIS
   * action. `true` => sent, `false` => accepted but not sent (offer resend),
   * `null` => no claim available (e.g. an already-active lifecycle, where this
   * call sent nothing). Never coerce `null` to `false`: "unknown" and "failed"
   * produce different, and differently truthful, copy.
   */
  restorationEmailQueued: boolean | null;
};

let pendingNotice: AccountDeletionNotice | null = null;

/**
 * Record that the server accepted a deletion request. Call this ONLY after the
 * service has proven acceptance — never on a failed or unaccepted response.
 */
export function setAccountDeletionNotice(notice: AccountDeletionNotice): void {
  pendingNotice = {
    alreadyRequested: notice.alreadyRequested === true,
    gracePeriodEndsAt:
      typeof notice.gracePeriodEndsAt === 'string' && notice.gracePeriodEndsAt
        ? notice.gracePeriodEndsAt
        : null,
    restorationEmailQueued:
      notice.restorationEmailQueued === true
        ? true
        : notice.restorationEmailQueued === false
          ? false
          : null,
  };
}

/** Read and clear. Returns null when there is nothing to show. */
export function consumeAccountDeletionNotice(): AccountDeletionNotice | null {
  const notice = pendingNotice;
  pendingNotice = null;
  return notice;
}

/** Drop any pending notice without showing it (e.g. a failed retry). */
export function clearAccountDeletionNotice(): void {
  pendingNotice = null;
}

/**
 * User-facing copy for an accepted deletion request.
 *
 * Accuracy rules, verified against the deployed contract:
 *   * "accepted" means an ACTIVE deletion lifecycle exists — never that the
 *     account has been purged. Purge is a later terminal event.
 *   * The restoration-email sentence is driven ONLY by
 *     `restorationEmailQueued`. handle-user-deletion reports whether the mail
 *     provider actually accepted the message, so this copy claims an email was
 *     sent only when that is true, says plainly that it could not be sent when
 *     it is false, and makes no email claim at all when it is null. Telling the
 *     user to look for an email that never arrives is exactly what made the old
 *     confirmation unverifiable.
 *   * A grace-period date is shown only when the backend supplied a valid one.
 *     A malformed or absent value falls back to generic wording — never an
 *     invented date.
 */
export function buildAccountDeletionNoticeMessage(notice: AccountDeletionNotice): string {
  const lead = notice.alreadyRequested
    ? 'Your account deletion request is already active.'
    : 'Your account deletion request was received.';

  let graceCopy = ' Your account is scheduled for deletion and can still be restored during the grace period.';
  if (notice.gracePeriodEndsAt) {
    const parsed = new Date(notice.gracePeriodEndsAt);
    if (!Number.isNaN(parsed.getTime())) {
      graceCopy = ` Your account is scheduled for deletion and can still be restored until ${parsed.toLocaleDateString()}.`;
    }
  }

  let emailCopy = '';
  if (notice.restorationEmailQueued === true) {
    emailCopy =
      ' We emailed you a restoration link — open it before then to keep your account.';
  } else if (notice.restorationEmailQueued === false) {
    emailCopy =
      ' We could not send your restoration email. You can request a new restoration link from the sign-in screen.';
  } else {
    emailCopy =
      ' You can request a restoration link from the sign-in screen.';
  }

  return `${lead}${graceCopy}${emailCopy}`;
}
