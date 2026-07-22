# 02 — Migration baseline (Step 2A verified)

| Claim | Canonical source |
| --- | --- |
| Default `gemini-2.5-flash` | Confirmed (pre-migration) |
| Precedence `STYLECHAT_GEMINI_MODEL` → `GEMINI_MODEL` → default | Confirmed (removed in Step 2B) |
| History last 6 user/assistant, session+user scoped | Confirmed |
| Same-model completeness retry | Confirmed (`incompleteReasonFor` / `looksIncompleteAssistantReply`) |
| Client-driven persistence | Confirmed |
| Signature Style prefs exist server-side via Closet/reactions | Confirmed (`dressing_room_items` + reactions → `memoryText`) but StyleDNA occupied `signature_style_context` |
| StyleDNA is client `styleDnaContext` satisfaction signal | Confirmed |
| Quota atomic before Gemini; no refund | Confirmed (`increment_stylechat_daily_usage` only) |
| Payload: system_instruction + contents + generationConfig(maxOutputTokens, temperature) | Confirmed; no thinking fields |
| JWT verified in-function + gateway verify_jwt=true | Confirmed |

No material contradiction that blocks Step 2B.
