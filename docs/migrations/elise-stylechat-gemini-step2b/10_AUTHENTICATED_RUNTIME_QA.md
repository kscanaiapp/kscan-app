# 10 — Authenticated runtime QA

## Status

**EXTERNAL RUNTIME GATE** — `STAGING_USER_JWT` not available in this environment.

## Required checks (operator)

1. Basic Elise conversation
2. Fashion advice + history follow-up
3. Signature Style personalization (`signature_style_included=true` in logs)
4. Explicit request contradicting Signature Style
5. Account without Closet signals
6. StyleDNA remains distinct
7. Session/account switch
8. Normal quota success (`quota_refunded=false`, `served_model=gemini-3.6-flash`)
9. Controlled fallback / refund via staging fault injection
10. Speech/persistence compatibility (text shape unchanged; stylist-speech untouched)

## Log expectations

See handoff packet § Runtime evidence.
