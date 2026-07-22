# 99 — Handoff packet

## MIGRATION IMPLEMENTED

- Elise primary `gemini-3.6-flash`, Lite fallback `gemini-3.5-flash-lite`
- `GEMINI_MODEL` removed from Elise routing
- Signature Style preference block from Closet/reactions → live prompt
- StyleDNA separated into `style_dna_context`
- Same-model completeness retry preserved; Lite operational/completeness fallback added
- Request-linked quota consume/refund RPCs + table
- Telemetry: routing_telemetry fields
- Tests: `eliseModelRouting.test.js` + StyleDNA delimiter update

## MIGRATION-REQUIRED REPAIR

- Relabeled StyleDNA prompt delimiters (was incorrectly branded Signature Style)
- Removed generation `temperature` for Gemini 3.x compatibility
- Added `style_dna_context` trust section

## DEFERRED TO HOSTILE AUDIT

- Pre-existing `services/aiSecurity/abuseControls.ts` vs `_shared` byte-sync drift
- Live SQL concurrency matrix for quota RPCs
- Authenticated runtime QA / served_model log proof
- Thinking-level optimization
- Unrelated avatar/voice/history/prompt-quality findings

## EXTERNAL RUNTIME GATE

- Authenticated Elise QA JWT
- Controlled fallback + refund proof in staging logs

## Rollback

```bash
supabase secrets set \
  STYLECHAT_GEMINI_MODEL=gemini-3.5-flash-lite \
  STYLECHAT_GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite \
  --project-ref wyyuqfdxucjksghsmhry
```

Do not restore `gemini-2.5-flash`. Quota refund path can be disabled by code rollback only with supported model secrets still active; do not drop `stylechat_quota_events` destructively.
