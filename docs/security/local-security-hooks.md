# Local security hooks (pre-commit / pre-push)

## Install (one command)

```
npm install
```

This runs the `prepare` lifecycle script (`node scripts/setup-git-hooks.js`),
which points git at the versioned `.githooks/` directory
(`git config core.hooksPath .githooks`). No manual per-developer setup step
and no new dependency (no husky/lint-staged) — plain git hooks, consistent
with the rest of this repo's hand-rolled `security/scripts/` style. Re-run
any time with `npm run setup:hooks`. No-ops automatically in CI
(`process.env.CI`).

## pre-commit (~3s budget)

Runs on every `git commit`, scoped to staged files only:

1. Obvious secret detection — fast pattern grep on added lines (private key
   headers, AWS/OpenAI/GitHub/Slack token shapes, `service_role` + JWT
   co-occurrence). Not a Gitleaks replacement — that runs in full in CI
   (`security-code.yml`).
2. Production write-target detection — blocks the production Supabase ref
   (`wyyuqfdxucjksghsmhry`) appearing in deploy-effective files (workflow
   YAML, `supabase/config.toml`, `.env*`, `app.json`, `eas.json`), excluding
   lines that are clearly a rejection/guard check rather than a target.
3. Malformed environment file detection — blocks committing a real `.env*`
   file (only `.example`/`.sample`/`.template` variants are allowed).
4. Lightweight lint — `node --check` on staged JS files.
5. High-risk migration pattern detection — warns (does not block) on
   `DROP TABLE`/`TRUNCATE`/`DISABLE ROW LEVEL SECURITY` in staged migration
   files; CI's `Migration validation` job is the real gate.
6. Workflow YAML syntax check when `.github/workflows/*.yml` changes.

## pre-push (broader)

Scoped to files changed in the range being pushed:

1. TypeScript validation (`tsc --noEmit`) when `.ts`/`.tsx` files changed.
2. Security test suite (`npm run test:security`) when `security/` or
   `__tests__/security/` changed.
3. `security/scripts/detect-destructive-migrations.js` when migrations
   changed.
4. Edge Function contract tests (`npm run test:edge-parity`) when
   `supabase/functions/` changed.
5. Production-reference guard (same heuristic as pre-commit, over the full
   push range).
6. `npm run verify:security` when workflow or `security/scripts/` files
   changed.
7. Non-blocking reminder when pushing directly to `master` or
   `staging/production-parity`.
8. Non-blocking warning if `package.json` changed without
   `package-lock.json`.

## Overriding

`git commit --no-verify` / `git push --no-verify` skip these local checks in
a genuine emergency. They do not skip the required GitHub PR/push checks in
`security-code.yml`, `security-staging-gate.yml`, or `security-promotion-gate.yml`
— those always run server-side regardless of local hook state.
