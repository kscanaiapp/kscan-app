# 01 — Preflight and canonical source

## Parity table

| Path | Branch | HEAD | stylechat size | Relationship |
| --- | --- | --- | --- | --- |
| `C:\src\KScan-ai-model-input-security` | `feature/ai-model-input-security` | `e545286…` | 69k→73k | **Canonical** — matches deployed entrypoint path; trust envelope present |
| `C:\src\KScan-KC05-repair-20260710-144442` | `integration/ios-v16-qa` | `f73d414…` | 67.9k | Step 2A audit baseline; greeting filter |
| `C:\src\KScan-elise-avatar-audit-20260715` | `integration/elise-avatar-voice-merge-20260714` | `e394261…` | 66.8k | Historical v59 artifact match |
| `C:\Users\jsmit\KScan` | `ios/full-submission-readiness-v2` | `0c9086a…` | 52.5k | Stale (`gemini-1.5-flash`); not used |

## Deployed auth

Live MCP: `stylechat-generate` **verify_jwt=true** (version 64 pre-migration).

## Decision

Implement in `C:\src\KScan-ai-model-input-security` because Supabase lists its path as the last deploy source and it contains the current trust-envelope Elise implementation.
