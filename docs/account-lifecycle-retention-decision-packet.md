# Account-lifecycle evidence retention decision packet

Status: **decision required; no policy selected**  
Scope: account-deletion lifecycle evidence, reviewer access records, dispute exports,
temporary notification envelopes, holds, and backup/archive copies  
Safety state: `account_deletion_evidence_pipeline_ready = false`

This packet presents finite, configurable choices. It does not make a legal or
privacy determination. Legal/privacy, Security, Support/Disputes, and the service
owner must record the selected duration, approver, policy version, and effective
date before the evidence pipeline can be enabled.

## Implementation constraint requiring a decision

The current migration stores one `retention_days` value for the complete
`account_lifecycle` evidence bundle. The access ledger is append-only, and the
current schema does not assign independent expiry dates to access events, dispute
exports, email envelopes, or backup copies.

The approvers must therefore choose one of these models before staging activation:

1. **Single-envelope model:** select one duration for the complete evidence bundle
   and use matching-or-shorter schedules for derivative artifacts.
2. **Category-specific model:** approve the category durations below and authorize
   a follow-up migration that adds independently enforceable expiry metadata and
   purge jobs for each category.

No indefinite default is acceptable. Legal holds are request-specific exceptions,
not a substitute for a finite base policy.

## Duration options

Each row is an independent decision unless the single-envelope model is selected.
“Delete” means hard-delete the artifact and record a sanitized retention event;
it does not delete the minimal append-only audit fact where the approved policy
requires that fact to survive.

| Category | Option | Proposed duration | Privacy risk | Dispute-readiness value | Operational cost | Expiry/deletion behavior | Legal-hold behavior |
|---|---|---:|---|---|---|---|---|
| Active grace-period evidence | A | Grace end + 7 days | Lowest; short post-recovery tail | Covers grace and immediate support corrections | Low | Delete if restored and tail expires; if deletion proceeds, roll into completed/failed evidence policy | Request hold suspends deletion and records reason/approver |
| Active grace-period evidence | B | Grace end + 30 days | More lifecycle metadata retained after recovery | Better support for late recovery disputes | Low | Same transition behavior; bounded daily purge | Hold suspends only the held request |
| Active grace-period evidence | C | Grace end + 90 days | Highest of these options | Strongest late-dispute coverage | Medium | Same transition behavior; bounded daily purge | Hold suspends only the held request |
| Completed deletion evidence | A | 90 days after purge | Lowest post-deletion exposure | Short dispute window | Low | Delete immutable bundle, index object references, and replicas after expiry; retain only approved minimal tombstone | Hold freezes bundle and every replica |
| Completed deletion evidence | B | 365 days after purge | Moderate metadata exposure | Covers common annual dispute/audit cycle | Medium | Same, with quarterly restore sampling before expiry | Hold freezes bundle and every replica |
| Completed deletion evidence | C | 730 days after purge | Greater long-tail exposure | Strong long-tail dispute and regulator response | High | Same, with annual capacity/cost review | Hold freezes bundle and every replica |
| Failed-purge evidence | A | 90 days after final remediation | Shorter incident history | Adequate for prompt remediation reviews | Low | Start clock only when the request reaches a verified safe terminal/remediated state | Hold blocks deletion; unresolved failures never expire merely by age |
| Failed-purge evidence | B | 365 days after final remediation | Moderate incident metadata exposure | Supports annual control testing | Medium | Same; automation must not delete while request remains failed or partially purged | Hold blocks deletion |
| Failed-purge evidence | C | 730 days after final remediation | Higher incident-history exposure | Strongest forensic value | High | Same; annual necessity review | Hold blocks deletion |
| Exported dispute packages | A | 7 days from export | Lowest derivative-copy risk | Enough for short internal handoff | Low | Auto-delete managed export; reviewer must not retain local copies | Case hold may extend to case closure + selected tail |
| Exported dispute packages | B | 30 days from export | Moderate derivative-copy risk | Supports typical investigation cadence | Medium | Auto-delete from managed export store and temporary hosts | Case hold applies to all registered copies |
| Exported dispute packages | C | 90 days from export | Highest derivative-copy risk | Supports extended external dispute exchange | High | Auto-delete unless a documented case remains open | Case hold applies to all registered copies |
| Reviewer access logs | A | 365 days | Lower employee-access metadata exposure | One annual audit cycle | Low | Bounded deletion or cryptographic anonymization after expiry, if legally approved | Hold preserves relevant case/request events |
| Reviewer access logs | B | 730 days | Moderate access-history exposure | Two audit cycles and stronger abuse investigation | Medium | Same | Hold preserves relevant events |
| Reviewer access logs | C | 2,190 days | Long employee/request-linkage exposure | Strong long-term access accountability | High | Same, with annual necessity review | Hold preserves relevant events |
| Temporary completion-email envelopes | A | 24 hours after send/terminal failure | Lowest contact-data exposure | Minimal delivery troubleshooting | Low | Delete payload and raw email; retain only sanitized delivery status/reference | Hold should normally attach to sanitized delivery fact, not raw envelope |
| Temporary completion-email envelopes | B | 7 days after send/terminal failure | More contact-data exposure | Better retry and provider investigation | Low | Same | Explicit case hold required for raw envelope |
| Temporary completion-email envelopes | C | 30 days after send/terminal failure | Highest email-envelope exposure | Long provider-dispute window | Medium | Same | Explicit case hold required for raw envelope |
| Legal holds | A | 90-day review cadence; no preset auto-release | Risk grows while hold remains | Strong preservation with frequent necessity review | Medium | Deletion remains suspended until named approver releases hold; overdue review alerts | Hold record includes scope, reason, case, approver, set/review/release timestamps |
| Legal holds | B | 180-day review cadence; no preset auto-release | Higher stale-hold risk | Less operational review load | Low | Same | Same |
| Legal holds | C | Case-end + 30-day release tail, reviewed at least annually | Depends on case duration | Aligns preservation to case lifecycle | Medium | Release is explicit after case closure and tail; never silently expires active case | Same |
| Backup/archive copies | A | Primary expiry + 7 days | Lowest replica overhang | Narrow restore window | Low | Backup purge completes within seven days of primary expiry; restore tests use synthetic/staging data | Hold propagates to identified replicas before primary mutation |
| Backup/archive copies | B | Primary expiry + 30 days | Moderate replica overhang | Better disaster-recovery window | Medium | Purge replicas within 30 days and record completion | Hold propagates to all replicas |
| Backup/archive copies | C | Primary expiry + 90 days | Highest replica overhang | Strongest recovery window | High | Purge replicas within 90 days; quarterly orphan-replica reconciliation | Hold propagates to all replicas |

## Required approval record

Record all of the following in the change ticket and the database policy row(s):

- selected retention model and one selected option per applicable category;
- policy owner and named legal/privacy approver;
- policy version and effective timestamp;
- legal-hold authority, review cadence, and release authority;
- backup system owner and verified maximum purge lag;
- whether a minimal sanitized tombstone may survive artifact deletion;
- dispute-export location and local-copy prohibition;
- reviewer-access-log deletion or anonymization rule;
- exception/escalation channel and maximum remediation time.

## Activation gate

The readiness flag remains false until:

1. the approval record is complete and finite;
2. the chosen model is enforced by schema and bounded purge jobs;
3. legal holds cover primary objects, exports, and replicas;
4. backup expiry is no longer than the approved replica overhang;
5. staging proves expiry, non-expiry, legal hold, failure pause, logging, and
   backup restore with matching checksums;
6. the production approval packet identifies the exact policy rows and rollback.

