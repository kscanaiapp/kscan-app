# 03 — Model migration

## Policy

- Primary: `STYLECHAT_GEMINI_MODEL` → `gemini-3.6-flash`
- Fallback: `STYLECHAT_GEMINI_FALLBACK_MODEL` → `gemini-3.5-flash-lite`
- `GEMINI_MODEL`: ignored
- Allowlist + retired-prefix guard (`1.5` / `2.0` / `2.5`)
- Client `body.model` ignored

## Payload compatibility

- Removed `temperature` (deprecated for 3.6 / 3.5-lite)
- Thinking config **deferred** (REST field syntax unverified)
- Preserved `maxOutputTokens: 512` and existing prompts

## Files

- `modelRouting.ts` (new)
- `stylechat-generate/index.ts`
