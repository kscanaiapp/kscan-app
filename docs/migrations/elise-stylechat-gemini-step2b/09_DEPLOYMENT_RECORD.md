# 09 — Deployment record

## Secrets

```bash
supabase secrets set \
  STYLECHAT_GEMINI_MODEL=gemini-3.6-flash \
  STYLECHAT_GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite \
  --project-ref wyyuqfdxucjksghsmhry
```

(Scanner/TextScan secrets untouched.)

## Deploy

```bash
supabase functions deploy stylechat-generate \
  --project-ref wyyuqfdxucjksghsmhry
```

JWT: preserve **verify_jwt=true** (default; do not pass `--no-verify-jwt`).

## Order executed

1. Quota migration applied
2. Secrets set
3. stylechat-generate deployed only
