# This is not the backend deployment authority (B34-DEF-001)

This branch (an Android/iOS mobile integration line) carries its own copy
of `supabase/functions` and `config/edge-function-manifest.json`. That copy
exists so this branch's own Edge Function source can be verified for
cross-branch parity against the other mobile platform branch (see
`docs/edge-function-deployment.md` if present, and
`scripts/check-edge-function-parity.js`). **It is not, and must never be
assumed to be, the canonical source for what should be deployed to
staging or production.**

## The canonical backend deployment authority

Branch **`rebuild/staging-v2-backend`** in this same repository
(`kscanaiapp/kscan-app`). See its
`docs/staging-rebuild/backend-authority-manifest.md` and, from the Build 34
maintenance pass, `docs/staging-rebuild/backend-authority-refresh-2026-08-29.md`.

## Why this matters

Read-only inventory of live staging (`yzqjvdfgefveprobvvyw`) on 2026-08-29
showed governed Edge Functions deployed from at least five different
origins: ad-hoc Supabase CLI temp checkouts, a GitHub Actions ephemeral
checkout, a direct checkout of `rebuild/staging-v2-backend`, and (for
functions outside this repository's governance entirely) a completely
different repository (`kscan-glasses-webapp`). A developer who runs
`node scripts/deploy-edge-functions.js` from a mobile integration branch,
believing its `supabase/functions` tree is "the backend," risks silently
rolling staging back to whatever this branch's copy happens to contain.

## The mechanical guard

`config/backend-authority.json` in this checkout declares
`"role": "mobile-integration-non-authoritative"`. `scripts/deploy-edge-functions.js`'s
Step 1 requires `"role": "backend-deployment-authority"` before it will run
at all — it fails here, every time, by design. This is not merely
documentation: attempting to deploy from this branch fails closed before
any other check runs, regardless of whether this branch's own manifest
happens to be internally consistent.

## What to do instead

If you need to deploy an Edge Function, do it from a checkout of
`rebuild/staging-v2-backend` (or its own maintenance branches), following
its own `scripts/deploy-edge-functions.js` and
`config/backend-authority.json`. If this mobile branch has made a change
that needs to reach the backend, port that change onto the authority
branch deliberately — do not deploy from here.
