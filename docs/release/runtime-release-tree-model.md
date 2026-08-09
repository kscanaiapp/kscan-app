# Runtime release-tree model

`RUNTIME_RELEASE_TREE` is the SHA-256 digest of the sorted Git tree entries (`mode type object<TAB>path`) selected by the rules below. It compares content identity, not commit ancestry.

## Included prefixes

All tracked files under these prefixes are included:

`android/`, `ios/`, `app/`, `assets/`, `components/`, `config/`, `constants/`, `contexts/`, `contracts/`, `data/`, `hooks/`, `lib/`, `modules/`, `server/`, `services/`, `src/`, `stores/`, `supabase/functions/`, `supabase/migrations/`, and `types/`.

This deliberately includes native projects, app/server source, every Edge Function file (including colocated tests/config), every migration, runtime data/assets, and Build 2.5 files already present in a candidate. It does not hide quarantined or ambiguous runtime source.

## Included exact files

`.easignore`, `.easignore.txt`, `.env.example`, `.env.e2e.example`, `app.js`, `app.json`, `index.js`, `eas.json`, `metro.config.js`, `package.json`, `package-lock.json`, `Procfile`, `render.yaml`, `server.js`, `store.config.json`, `tsconfig.json`, and `supabase/config.toml`.

Any root `app.config.js`, `app.config.ts`, `app.config.mjs`, or `app.config.cjs` is also included.

## Intentionally outside the projection

- `.github/` branch governance and workflow metadata
- `docs/` explanatory records
- root `__tests__/` deterministic regression tests
- `security/` policies, validators, reports, and release evidence
- `.maestro/`, `maestro/`, and `qa/` test harness inputs
- repository administration/developer tooling that is not shipped or deployed

These exclusions cannot make a runtime conflict disappear: build/deploy manifests, dependencies, environment examples, app/server/native source, migrations, Supabase configuration, and Edge Functions are explicitly included. A merge conflict still prevents creation of the predicted merge tree and blocks before digest comparison.

The executable authority is `security/scripts/compute-runtime-release-tree.js`; regression coverage is in `__tests__/security/releaseTreeEquivalence.test.js` on staging and `__tests__/security/masterPromotionBootstrap.test.js` on master.
