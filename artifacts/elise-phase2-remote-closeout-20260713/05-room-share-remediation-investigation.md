# Room-share redemption contract remediation investigation

Date: 2026-07-13

Scope: read-only investigation. No remote DML, DDL, migration-ledger repair, function deployment, or application deployment was performed.

## Result

`PREREQUISITE MIGRATION DEPLOYMENT: HALTED`

`REMOTE_SCHEMA_DIRTY — ROOM_SHARE_REDEMPTION_CONTRACT_INCOMPLETE`

`REMOTE PORTRAIT ENABLEMENT: FAIL — FEATURE MUST REMAIN DISABLED`

The requested `NULL`-to-`10` backfill is not proven safe. The live join function explicitly treats a `NULL` `max_redemptions` value as unlimited. Converting the three legacy rows to `10` would therefore change their effective contract.

For this pass, the evidenced intended state of those three rows is the existing `NULL`/unlimited state; no numeric replacement value is supported by the available history.

## Provenance findings

- No applied migration statement in the available remote ledger creates `public.room_shares.max_redemptions`.
- No repository migration predating the current prerequisite chain creates that column or the live capped join implementation.
- The earliest relevant repository history documents that the active redemption-limit source existed in the deployed database but not in repository migrations.
- Migration `20260708140542` was a temporary closed-beta adjustment for newly created links. It changed the create/share function to insert `10`; it did not add the column or update existing shares.
- The same historical instruction expressly prohibited updating existing live shares without owner approval.
- The exact actor and deployment event that introduced the column cannot be recovered from the repository or migration ledger. The safely supported classification is remote-only/manual schema history outside the canonical ledger.

## Sanitized remote row analysis

Only aggregate characteristics were inspected; no share tokens, user identifiers, or private identifiers were recorded.

| Stored value | Rows | Creation period | Recorded participant redemptions | Interpretation supported by live code |
| --- | ---: | --- | ---: | --- |
| `NULL` | 3 | 2026-06-21 through 2026-06-24 | 0 | Legacy unlimited |
| `2` | 6 | 2026-06-25 through 2026-07-07 | 2 total | Capped at 2 |
| `10` | 1 | 2026-07-08, after the QA adjustment | 0 | Capped at 10 |

The chronological split supports three distinct states: legacy uncapped rows, later two-redemption rows, and a new-link-only ten-redemption QA policy.

## Live enforcement evidence

The current remote `join_room_via_share_token` implementation:

1. reads `target_share.max_redemptions`;
2. counts existing distinct participants;
3. rejects a join only when the maximum is non-`NULL` and the participant count has reached it.

Consequently, `NULL` is not merely missing data under the current live contract. It is an operative unlimited sentinel.

The current create/share implementation inserts `10` for a newly created share. This proves the current new-link default behavior but does not prove that legacy unlimited links should be capped retroactively.

## Remediation decision

No forward-only remediation migration was authored in this pass because its required data transformation is not authorized or semantics-preserving. In particular:

- backfilling the three `NULL` rows to `10` would cap currently unlimited links;
- `SET NOT NULL` would remove the live unlimited representation;
- a simple `CHECK (max_redemptions BETWEEN 1 AND 100)` cannot preserve unlimited behavior once `NULL` is prohibited;
- modifying existing prerequisite migrations would rewrite migration history and still would not resolve the live legacy-row decision.

A future forward-only migration can safely make clean and current environments converge only after the legacy policy is explicitly chosen. The decision must either:

1. preserve legacy unlimited semantics with an explicit replacement representation and corresponding function changes; or
2. authorize a specific cap for the three legacy rows, after which a narrowly targeted backfill, `DEFAULT 10`, `NOT NULL`, and the intended check constraint can be applied atomically with validation.

Until that decision exists, the full local replay and linked twelve-migration dry run are intentionally not rerun: there is no approved remediation migration to replay or evaluate.
