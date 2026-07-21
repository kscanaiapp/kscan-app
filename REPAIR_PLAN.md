# Elise Backend Foundation Repair Plan

Date: 2026-07-21

This file supersedes the partial handoff plan from 2026-07-20. The accessible `C:\src\KScan-elise-backend-foundation-repair-20260720` folder initially contained only documentation and fixtures, not a Git worktree. The repair path was reconstructed as an isolated clone from `C:\src\KScan-KC05-repair-20260710-144442` at `f73d414745d366c5945fbb776231de6741012888` on `repair/elise-backend-foundation-preupgrade`; the partial handoff files were preserved in `C:\src\KScan-elise-backend-foundation-repair-20260720-partial-handoff-backup`.

## Implemented Scope

R-001 through R-014 were implemented or reduced to specific external gates:

- Active provider path verification and stale function-name tests.
- Installed-client contract fixtures for StyleChat and stylist-speech request, success, and error bodies.
- Backend-only typed Elise configuration with default-off repair flags.
- Flagged visual-context normalization that accepts legacy context, drops malformed optional evidence, preserves provenance, and keeps flag-off legacy behavior strict.
- Optional generation identity using source user message IDs when available.
- Additive migration for assistant source-message uniqueness, generation operation ledger, and idempotent daily quota RPC.
- Speech source consolidation validation around the active `stylist-speech` function and one active client speech service.
- ElevenLabs stable error classification, bounded retry policy, in-flight dedupe, and circuit breaker controls.
- Privacy-safe telemetry helper and outcome events.
- Centralized Signature Style feedback display/write gate.
- Prompt/output hardening helpers.
- Preservation of voice defaults, screen-reader fail-closed behavior, reduced-motion/lifecycle behavior via existing tests.
- Attachment degradation outcome vocabulary and telemetry.
- Canonical targeted Node and Deno test coverage.

## Rollback

All behavior-changing backend repairs are independently gated:

- `ELISE_CONTEXT_NORMALIZATION_V1_ENABLED=false`
- `ELISE_GENERATION_SAFETY_V1_ENABLED=false`
- `ELISE_QUOTA_IDEMPOTENCY_V1_ENABLED=false`
- `ELISE_SPEECH_RESILIENCE_V1_ENABLED=false`
- `ELISE_SPEECH_RETRY_ENABLED=false`
- `ELISE_SPEECH_CIRCUIT_BREAKER_ENABLED=false`
- `ELISE_TELEMETRY_V1_ENABLED=false`
- `ELISE_STRUCTURED_GROUNDING_V1_ENABLED=false`

The migration is additive. Existing installed clients do not need new required request fields or a new mobile build.
