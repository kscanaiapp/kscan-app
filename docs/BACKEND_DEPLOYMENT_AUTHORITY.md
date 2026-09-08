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

> **That branch is not published (GOV-KPLUS-001, re-confirmed by RP-108 on
> 2026-09-07).** `git ls-remote --heads origin` returns no
> `rebuild/staging-v2-backend`, and it resolves locally in no checkout this lane
> could reach — so the ref named above as the canonical deployment authority
> cannot be verified by anyone from a fresh clone.
> `scripts/verify-backend-authority.js` reports this as
> `CANONICAL_BRANCH_UNRESOLVABLE` rather than hiding it, and escalates it to a
> hard failure the moment a checkout actually claims the authority role.
>
> **Repair 05 (2026-09-08) independently re-confirmed this from a fresh
> `git fetch`**, and additionally enumerated every branch that currently
> self-declares `role: "backend-deployment-authority"` in its own copy of
> `config/backend-authority.json` — 12 found, all frozen 2026-08-29 through
> 2026-08-31. 11 are already ancestors of `release/kscan-pre-freeze-v1` (their
> content reached mainline through the ordinary Build 34 convergence and holds
> no distinct authority); the 12th is a stale merge 605 commits behind. See
> `docs/staging-rebuild/repair05-canonical-authority-reconfirmation-2026-09-08.md`
> for the full search and the resulting convergence plan.
>
> RP-108 deliberately did **not** repair this by re-pointing `canonicalBranch`
> at some other published branch. There is no evidence in this repository that
> any published branch holds that authority, and writing one in would be
> manufacturing a governance claim the contract does not support — a worse
> outcome than an honest, visible gap. Closing it is an owner action: publish
> the branch, or re-point the field at a ref whose authority the owner can
> actually attest to.

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
`"role": "integration-convergence-non-authoritative"`.
`scripts/deploy-edge-functions.js`'s Step 1 requires
`"role": "backend-deployment-authority"` before it will run at all — it fails
here, every time, by design. This is not merely documentation: attempting to
deploy from this branch fails closed before any other check runs, regardless
of whether this branch's own manifest happens to be internally consistent.

The guard compares that field exactly, so the role string in this document has
to be the one actually in the file. It said `mobile-integration-non-authoritative`
until RP-108 (2026-09-07); the config had moved to
`integration-convergence-non-authoritative` and this page was not updated with
it. Anyone verifying the guard by reading this page was checking for a string
that no longer existed.

## What to do instead

If you need to deploy an Edge Function, do it from a checkout of
`rebuild/staging-v2-backend` (or its own maintenance branches), following
its own `scripts/deploy-edge-functions.js` and
`config/backend-authority.json`. If this mobile branch has made a change
that needs to reach the backend, port that change onto the authority
branch deliberately — do not deploy from here.
