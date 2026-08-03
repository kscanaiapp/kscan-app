# Secure Image Ingestion Gate — Rollback

- **Date**: 2026-08-03 · companion to `secure-image-ingestion-architecture.md`

Every change in this branch is additive or config-gated. Nothing here requires a data migration to undo — each piece can be independently reverted without affecting the others.

## 1. `server.js` gate wiring (`/api/analyze`)

**What changed**: `runIngestionGate()` is called after `extractImageParts()` and before the Gemini/OpenRouter branch; a rejection short-circuits with the same `{result, metadata, products}` response shape the endpoint already used for validation errors.

**Rollback**: revert the `server.js` diff (the `require('./security/ingestion-gate/gate')` import, the `IMAGE_SCANNER_ENABLED`/`IMAGE_VERDICT_SECRET`/`INGESTION_GATE_STATUS_CODES` constants, and the gate-call block in the `/api/analyze` handler). The route returns to its pre-existing behavior (client-asserted MIME check only, no re-encode, no scan). No data implications — nothing from this endpoint is ever persisted either way.

**Partial rollback (keep validation, disable re-encode only)**: uninstall/remove `sharp` from `package.json` and revert `render.yaml`'s `buildCommand`. `reencode.js` detects `sharp`'s absence at `require()` time and reports `SCANNER_UNAVAILABLE` for the re-encode step specifically, which `server.js` maps to a 503 ("temporarily unavailable") rather than crashing — but this means the endpoint would start rejecting all valid images until `sharp` is restored, so this partial rollback is not recommended; prefer the full rollback above if disabling is needed.

## 2. `render.yaml` (`sharp` in `buildCommand`, new env vars)

**What changed**: `buildCommand` gained `sharp`; five new env var declarations (`IMAGE_SCANNER_ENABLED`, `CLAMD_HOST`, `CLAMD_PORT`, `IMAGE_VERDICT_SECRET`) were added, all either defaulted safely (`IMAGE_SCANNER_ENABLED: "false"`) or `sync: false` placeholders that do nothing until a value is set.

**Rollback**: revert `buildCommand` to `npm install express cors dotenv` and remove the five new env var blocks. Since `IMAGE_SCANNER_ENABLED` already defaults to `"false"` and `CLAMD_HOST`/`CLAMD_PORT` are unset by default, simply not deploying this file's change is itself a safe no-op — the risk this document flags is specifically about the **build succeeding** with a new native dependency (`sharp` is a real libvips binary, unlike the dependency-free `express`/`cors`/`dotenv` set), not about runtime behavior. **Verify a Render build succeeds on the free plan before merging** — if it fails or times out, revert this one line; nothing else in this PR depends on the Render deploy actually succeeding immediately (the gate's other checks are covered by the repo's own `node --test` suite regardless of what's deployed).

## 3. Supabase migrations (quarantine bucket, clean bucket, verdicts table)

**What changed**: three new additive migrations — no existing table, bucket, column, or policy was altered or renamed.

**Rollback**: a companion "down" migration would run:
```sql
drop policy if exists "Users can read own scan verdicts" on public.image_scan_verdicts;
drop table if exists public.image_scan_verdicts;

drop policy if exists "Users can read own clean images" on storage.objects;
delete from storage.buckets where id = 'image-ingestion-clean';

drop policy if exists "Users can upload own quarantine images" on storage.objects;
delete from storage.buckets where id = 'image-ingestion-quarantine';
```
None of this touches `style-library-images`, `investor-docs`, or any other pre-existing object. No down migration is included in this PR (not requested; the additive migrations are safe to leave in place even if the feature is never activated — an unused private bucket with no client-facing read/write policy beyond owner-scoped insert/select carries no meaningful exposure).

## 4. `tryon-clothes-pro` request-contract rewrite

**What changed**: the function now requires `person_image_object_id`/`top_garment_object_id`/`bottom_garment_object_id` instead of inline base64 fields.

**Rollback**: revert `supabase/functions/tryon-clothes-pro/index.ts` and `index.test.ts` to their pre-this-branch state (the PR #43-hardened version accepting inline base64). Safe unconditionally: this function has **no live caller** (`services/tryOnClothesPro.ts` is unimported anywhere in the app) and is held back from staging deployment (`security/scripts/staging-deployment-allowlist.js`), so there is no external contract to break in either direction.

## 5. CI (`security-code.yml` secure-upload-gate job)

**What changed**: one new job (`secure-upload-gate`) added to the existing `Security - Code and Dependencies` workflow, wired into `static-security-gate`'s `needs:`/pass-fail evaluation.

**Rollback**: remove the `secure-upload-gate` job block and its two references in `static-security-gate` (the `needs:` list entry and the `PAIR` line). The rest of the security pipeline is unaffected — every other job's `needs:`/`PAIR` entries are unchanged.

## 6. New dependency (`sharp`)

**What changed**: `package.json` gained `sharp` as a dependency; `package-lock.json` gained its resolved transitive entries (a clean, additive diff — verified locally: 412 insertions, 2 deletions, no unrelated package changes).

**Rollback**: `npm uninstall sharp` (or manually remove the `package.json` line and run `npm install` to regenerate the lockfile). This is the same dependency `reencode.js` already tolerates being absent for — no other module in this PR hard-requires it at load time.

## Summary: safest rollback order if something goes wrong post-merge

1. Set `IMAGE_SCANNER_ENABLED=false` (already the default) — instant, no redeploy needed if already deployed with scanning on.
2. Revert the `render.yaml` `buildCommand` line if the Render build is the problem.
3. Revert the `server.js` gate-wiring block if `/api/analyze` itself is misbehaving.
4. Everything else (migrations, `tryon-clothes-pro`, CI job) is inert until explicitly acted upon and can be reverted independently without touching the above.
