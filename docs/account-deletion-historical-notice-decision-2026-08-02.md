# Historical deletion-request notice decision record

Prepared: 2026-08-02  
Decision status: owner action required  
Automated historical-row changes performed: **none**

## Known scope

The owner-provided staging brief identifies six historical deletion-request
rows whose initial deletion-notice state has not been independently verified.
This document does not contain user IDs, email addresses, request IDs, or row
contents, and it does not claim a direct production query was performed.

Migration `20260802193330_account_deletion_notice_claim_guard.sql` adds:

- `initial_deletion_notice_verified`, default `false`;
- `notification_review_required`, default `true`.

Both fresh and stale purge claims require the first value to be true and the
second to be false. The migration intentionally has no backfill that marks an
existing row verified. Consequently, the six historical rows remain excluded
from automated hard purge unless an authorized owner reviews each row and
records a decision.

## Permitted owner decisions

Choose exactly one outcome per row under an approved change ticket:

1. **Notice verified:** retain independent proof that the initial notice was
   successfully queued/delivered, then explicitly set notice verified and
   clear notification review. Do not use application logs alone if they do not
   establish the provider outcome.
2. **Restore or cancel:** use the supported restoration/cancellation workflow
   when deletion should no longer proceed. Do not directly rewrite lifecycle
   state solely to bypass the guard.
3. **Legal hold/manual investigation:** keep notification review required and,
   when legally approved, apply a request-scoped hold with reason, actor, and
   review date.

If proof is missing or ambiguous, keep the fail-closed defaults. Do not resend
a notice, contact a user, infer successful delivery, or enable purge from this
record alone.

## Required decision evidence

For each row, record outside Git:

- deletion request ID and authorized reviewer identity;
- selected outcome and sanitized rationale;
- provider receipt or case reference, when notice is verified;
- timestamp and approved change/case number;
- before/after guard values;
- lifecycle ledger event and alert evidence, where applicable.

Production remains untouched until separately approved. This record is a
decision template, not authorization to update any environment.
