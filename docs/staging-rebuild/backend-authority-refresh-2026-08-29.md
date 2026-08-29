# Backend authority refresh — B34-DEF-001 (2026-08-29)

Supplements `backend-authority-manifest.md` (2026-08-05 snapshot, now stale
on version numbers) rather than replacing it. This is the Build 34
maintenance-pass refresh: identifying the canonical authority, inventorying
what is actually deployed, and closing the gaps the earlier snapshot left
open.

## The canonical backend authority already exists

`rebuild/staging-v2-backend` (this branch's parent) is not something this
pass invented — its own commit history and `backend-authority-manifest.md`
already establish it as the deliberate "K Scan AI Staging in-place rebuild"
lineage. What this pass found and corrected: its own deployment tooling
disagreed with its own stated purpose.

## What was found broken

`scripts/edge-function-manifest-lib.js`'s `APPROVED_PROJECT_REF` constant
declared production (`wyyuqfdxucjksghsmhry`), inherited unchanged from the
mobile (Android) line. This branch's own `supabase/config.toml` has always
declared staging (`yzqjvdfgefveprobvvyw`). Running the existing parity gate
on this branch failed immediately:

```
Project reference mismatch: config.toml declares "yzqjvdfgefveprobvvyw", manifest approves "wyyuqfdxucjksghsmhry".
```

Corrected `APPROVED_PROJECT_REF` to staging, matching this branch's actual,
documented, deliberate deploy target. Production remains read-only.

## Governance widened from 3 to 17 functions

`GOVERNED_FUNCTIONS` covered only `scan-identify`, `stylechat-generate`,
`style-outfit-generate`. Extended to every function this branch's own tree
carries source for (excluding `_shared`, not itself deployable):

`handle-user-deletion`, `kickscrew-sneaker-description`, `nike-shoe-details`,
`privacy-correction-request`, `privacy-data-export`,
`process-account-deletions`, `product-search-deals`,
`resend-restoration-email`, `restore-account`, `scan-identify`,
`search-vinted-secondhand`, `shared-room-image-url`, `staging-health`,
`style-outfit-generate`, `stylechat-generate`, `stylist-speech`,
`tryon-clothes-pro`.

Extending coverage surfaced a real, reproducible bug in specifier
extraction (see "Bug found while extending coverage" below) — exactly the
kind of drift-detector-catches-a-real-bug outcome this gate exists for.

## Fail-closed deployment guard: `config/backend-authority.json`

`scripts/deploy-edge-functions.js` now refuses to run at all (Step 1 of 7)
unless `config/backend-authority.json` exists in the checkout and declares
`"role": "backend-deployment-authority"`. This is what makes a mobile
integration branch's copy of `supabase/functions` mechanically
distinguishable from the real deploy authority, rather than merely
documented-and-hoped-for. Mobile branches intentionally do not carry this
marker (or carry it with a non-authoritative role) — see
`docs/BACKEND_DEPLOYMENT_AUTHORITY.md` on the iOS/Android maintenance
branches.

## Bug found while extending coverage

`extractSpecifiers`'s regex-based import scanner used `[^'"]+` (matches
newlines) inside its capture groups. Two of the newly-governed functions
exposed this:

- `process-account-deletions/index.ts:201` — a TypeScript index-access type
  `['storage']['from']` contains the literal string `'from'`; the scanner
  read `from` + the closing `'` as the START of an import specifier and
  then consumed everything (including several lines of real code) up to the
  next unrelated quote character elsewhere in the file.
- `shared-room-image-url/index.ts:135` — a JSDoc comment reading `from
  "doesn't exist at all"` triggered the same class of false match from
  inside prose.

Fixed by (a) restricting all four specifier patterns to single-line matches
(`[^'"\n]+`) and (b) stripping block comments before extraction runs
(deliberately NOT stripping `//` line comments, since a real remote
specifier is routinely written as `'https://esm.sh/...'` and a naive
`//`-strip would truncate it at the scheme's own double slash). Three
regression tests committed in `__tests__/edgeFunctionSourceParity.test.js`.

Net effect on the pre-existing test suite: 25 failures before this patch,
19 after (`npm run test:all`) — a real reduction, not a regression. The
remaining 19 are unrelated pre-existing issues (e.g. the deliberately
deferred `shared_room_item_contributions` migration — see
`supabase/migrations-deferred/README.md` and prior project memory) that
this patch did not touch and is not authorized to fix.

## Phase 1 live staging inventory (read-only, 2026-08-29)

Every governed function's live version and `ezbr_sha256` on staging
(`yzqjvdfgefveprobvvyw`), fetched via `list_edge_functions`:

| Function | Live version | Last-deploy `entrypoint_path` origin |
|---|---|---|
| scan-identify | v50 | `/tmp/user_fn_.../source/functions/scan-identify` (ad-hoc CLI checkout) |
| stylist-speech | v55 | `/tmp/user_fn_.../source/supabase/functions/stylist-speech` (ad-hoc CLI checkout) |
| stylechat-generate | v110 | `/tmp/user_fn_.../source/supabase/functions/stylechat-generate` (ad-hoc CLI checkout) |
| style-outfit-generate | v44 | `/home/runner/work/_temp/kscan-candidate-*/supabase/functions/style-outfit-generate` (GH Actions ephemeral checkout) |
| handle-user-deletion | v66 | `/tmp/user_fn_.../source/supabase/functions/handle-user-deletion` (ad-hoc CLI checkout) |
| process-account-deletions | v46 | `/tmp/user_fn_.../source/supabase/functions/process-account-deletions` (ad-hoc CLI checkout) |
| privacy-correction-request | v50 | GH Actions ephemeral `kscan-candidate-*` checkout |
| privacy-data-export | v49 | GH Actions ephemeral `kscan-candidate-*` checkout |
| restore-account | v45 | GH Actions ephemeral `kscan-candidate-*` checkout |
| resend-restoration-email | v45 | GH Actions ephemeral `kscan-candidate-*` checkout |
| staging-health | v47 | GH Actions ephemeral `kscan-candidate-*` checkout |
| kickscrew-sneaker-description | v62 | `/src/KScan-staging-v2-backend` (this branch, direct checkout) |
| nike-shoe-details | v43 | `/src/KScan-staging-v2-backend` (this branch, direct checkout) |
| product-search-deals | v52 | `/src/KScan-staging-v2-backend` (this branch, direct checkout) |
| search-vinted-secondhand | v43 | `/src/KScan-staging-v2-backend` (this branch, direct checkout) |
| shared-room-image-url | v43 | `/src/KScan-staging-v2-backend` (this branch, direct checkout) |
| tryon-clothes-pro | v43 | `/src/KScan-staging-v2-backend` (this branch, direct checkout) |

Interpretation: only 6 of 17 governed functions' most recent deploy actually
came from a checkout of this exact branch. The rest came from ad-hoc CLI
temp checkouts or GitHub Actions ephemeral checkouts of unconfirmed
commit/branch. **No deploy was run as part of this maintenance pass** — this
table is read-only evidence for the owner that a "redeploy from this
branch" would very likely change bytes on staging for 11 of the 17
functions, which is exactly the risk DEF-001 flagged. Confirming whether
that would be a fix (this branch is newer/correct) or a regression (staging
already has an intentional newer patch this branch lacks) requires a
content diff per function against each live `ezbr_sha256`, which this
read-only pass did not attempt for all 17 — recommended as owner-directed
follow-up before any real deploy from this branch.

## Explicitly not governed here (and why)

Recorded in `config/backend-authority.json`'s `notGoverned` block:

- **Website privacy stack** (`privacy-controls`, `public-sale-share-opt-out`) —
  documented in `backend-authority-manifest.md` as deliberately untouched;
  source lives outside this repository's `supabase/functions` tree.
- **Staging tooling** (`product-match`) — deployed and real, but no source
  directory exists for it under `supabase/functions` in this branch.
- **Apple credential functions** (`apple-credential-link`,
  `apple-revoke-credential`) — live deployment provenance shows a GitHub
  Actions checkout of this same repository (`kscanaiapp/kscan-app`), but
  neither exists in this branch's or either mobile branch's current
  `supabase/functions` tree. Origin commit/branch unconfirmed; flagged for
  owner follow-up rather than guessed at.
- **Wearable functions** (`wearable-bridge`, `wearable-save`,
  `wearable-open-on-phone`, `wearable-scan`) — deployed from a different
  repository entirely (`kscan-glasses-webapp`, confirmed via each
  function's `entrypoint_path`). Not governed here by design.

## What this pass did NOT do

- No Edge Function was deployed (staging or production).
- No migration was applied.
- No secret or feature flag was changed.
- Production (`wyyuqfdxucjksghsmhry`) was only ever read via
  `list_edge_functions`/`list_migrations` — never written.
