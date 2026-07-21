# Defect and repair ledger

Two defects found. Both P2. Both repaired in this audit.

No BLOCKER, no P0, no P1 findings.

---

## Finding DR-AUDIT-P2-1 — DR-2 provider import silently broke StyleChat test suite

- **Severity**: P2
- **Affected DR phase**: DR-2 (integration/dr2-elise-dressingrooms)
- **Affected feature**: Elise / StyleChat provider (advice metadata passthrough)
- **Location**: `__tests__/styleChatTextRequest.test.js` (test-side loader allowlist) and `services/style-chat/providers/edgeStyleChatProvider.ts` (import site)
- **Observed failure**: 8 tests in `styleChatTextRequest.test.js` failed with `Error: Unexpected provider import: ../../../constants/featureFlags`.
- **Reproduction**: `node --test __tests__/styleChatTextRequest.test.js` (pre-repair).
- **Root cause**: DR-2 commit `e931547 feat(elise): wire stable room attachments for the next mobile build` added an import of `ELISE_ADVICE_METADATA_CLIENT_V1` from `../../../constants/featureFlags` into `edgeStyleChatProvider.ts`. The test file uses a `customRequire` allowlist to sandbox-load the provider; that allowlist was not updated to permit the new import, so the sandbox threw on every provider-load site.
- **Why it matters**: Production behavior is unaffected — the flag defaults OFF and only gates an optional passthrough branch. However, the failed tests obscured whether other DR-era regressions existed in the StyleChat surface and would block CI.
- **Repair performed**: Extended the `customRequire` allowlist in `__tests__/styleChatTextRequest.test.js` to return `{ ELISE_ADVICE_METADATA_CLIENT_V1: false }` for the `../../../constants/featureFlags` specifier, matching production default.
- **Why this repair is correct**: The provider only reads `ELISE_ADVICE_METADATA_CLIENT_V1` in one guarded branch (`edgeStyleChatProvider.ts:508`). The tests exercise the exact-shape v1 payload contract and never enable advice-metadata passthrough; returning `false` preserves the tests' assertions and matches production default.
- **Backward compatibility impact**: none (test-only change).
- **Database impact**: none.
- **Security/privacy impact**: none.
- **Cross-feature impact**: restores full Elise/StyleChat CI signal.
- **Tests added or changed**: modified `__tests__/styleChatTextRequest.test.js`.
- **Focused validation**: `node --test __tests__/styleChatTextRequest.test.js` — all 8 previously-failing tests now PASS.
- **Broad regression validation**: full `node --test __tests__/*.test.js` — 1703/1703 PASS.
- **Deployment impact**: none.
- **Rollback / forward-remediation**: revert the one edited block; no runtime impact.

---

## Finding DR-AUDIT-P2-2 — `elise_generation_operations` missing from account-deletion coverage

- **Severity**: P2
- **Affected DR phase**: DR-2 (Elise integration boundary); pre-DR foundation table, but surfaced by the coverage test at DR audit time.
- **Affected feature**: privacy / account deletion pipeline
- **Location**: `scripts/process-deletion-request.js` (`USER_DATA_RESOURCES` array). Migration source: `supabase/migrations/202607200001_elise_generation_quota_idempotency.sql`.
- **Observed failure**: `USER_DATA_RESOURCES covers all user-linked tables in migrations` (`__tests__/processDeletionRequest.test.js:684`) failed with `Missing user-linked tables in USER_DATA_RESOURCES: [{file: '202607200001_elise_generation_quota_idempotency.sql', table: 'elise_generation_operations'}]`.
- **Reproduction**: `node --test __tests__/processDeletionRequest.test.js` (pre-repair).
- **Root cause**: When the Elise generation-quota table was introduced, its `user_id` foreign key already carried `ON DELETE CASCADE`, so account deletion physically works. But `USER_DATA_RESOURCES` (used for row-count telemetry and deletion coverage reporting) was not updated to declare the table.
- **Why it matters**: Deletion reporting under-reports affected tables and would omit `elise_generation_operations` from the deletion coverage manifest returned to users / auditors. Section 17.J of the audit brief classifies "A new DR table that silently escapes deletion/export policy" as P1-P2 depending on exposure. Because the auth cascade still deletes the rows, the exposure is P2.
- **Repair performed**: Added `{ table: 'elise_generation_operations', column: 'user_id', action: 'auth_delete_cascade', optional: true }` to `USER_DATA_RESOURCES` in `scripts/process-deletion-request.js` (co-located with the `direct_delete_before_auth` block).
- **Why this repair is correct**: The action taxonomy already includes `auth_delete_cascade` for FK-cascade-driven tables; the `optional: true` flag matches the migration's tolerance for environments where the migration hasn't been applied yet.
- **Backward compatibility impact**: none — only affects reporting.
- **Database impact**: none.
- **Security/privacy impact**: improves privacy-pipeline auditability.
- **Cross-feature impact**: restores CI green.
- **Tests added or changed**: none (existing coverage test now passes).
- **Focused validation**: `node --test __tests__/processDeletionRequest.test.js` — PASS.
- **Broad regression validation**: full test suite 1703/1703 PASS.
- **Deployment impact**: none.
- **Rollback / forward-remediation**: revert the one line; test would fail again but production behavior unchanged.

---

## P3 items observed but not repaired

- Idempotency ledger has no TTL/cleanup mechanism (unbounded growth). Non-security scalability item; would require a scheduled cleanup job (out of scope for this audit).
- Reaction DELETE policy checks only `user_id = auth.uid()`, not room access. Intentional (users can always delete their own data), but the comment in `202606240002_dressing_room_item_reactions_participant_rls.sql` would benefit from calling this out explicitly.

Neither meets the "localized, low-risk, directly improves correctness/security/compatibility" bar for optional P3 repair.
