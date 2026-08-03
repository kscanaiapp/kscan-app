# Deployed provider-function drift — captured evidence

Captured 2026-08-03 from production project `wyyuqfdxucjksghsmhry`.

Four deployed Edge Functions have source that **matches no commit in this
repository**. This directory holds the exact diffs, so the reconciliation below
is a review of real changes rather than a reconstruction from memory.

## How this was captured

```bash
supabase functions download <slug> --project-ref wyyuqfdxucjksghsmhry
```

writes the deployed source to disk. Each file was then hashed with
`git hash-object --no-filters` and looked up with `git cat-file -e`: the blob
exists for every `scan-identify` and `stylechat-generate` file, and for none of
these four. The `.diff` files here are `diff -u --strip-trailing-cr` against
this branch's `HEAD` — CR-normalized, because the deployed copies use CRLF and
an unnormalized diff shows every line as changed and hides the real delta.

## What actually changed

| function | deployed ver | delta | assessment |
|---|---|---|---|
| `product-search-deals` | 71 | +11 lines: static import of `assertAccountActiveIfAuthenticated`, and a guard call at the top of the POST handler | **keep** — a real fix |
| `search-vinted-secondhand` | 7 | +11 lines: the same guard, same reason | **keep** — a real fix |
| `kickscrew-sneaker-description` | 70 | secret renamed `RAPIDAPI_KEY` → `KICKSCREW_RAPIDAPI_KEY` (3 lines) | **keep** — separates provider credentials |
| `nike-shoe-details` | 68 | deleted a 2-line header warning: *"Experimental provider. Upstream RapidAPI endpoint returned 404 … Do not wire into production flows until a supported URL or endpoint is confirmed."* | **investigate before keeping** |

The first three are the same class of change: someone hit a production failure,
fixed it correctly, deployed, and never committed. The comment in the deployed
`product-search-deals` explains the cause precisely — the `--use-api` bundler
does not follow `await import()` of the shared guard, so a dynamic import left
the module unbundled and the function 500'd.

The fourth is different and is the one to look at hardest. A warning saying
"do not wire this into production" was removed from a deployed function, and
nothing in the repository records who decided the upstream endpoint was fixed,
or whether it was. Deleting a caveat is not evidence that the caveat stopped
being true.

## Why this blocks a Phase 7 release

Not because these particular changes look dangerous — three of the four are
improvements. Because **the repository is not currently a description of what is
running**, and every downstream guarantee assumes it is:

- the edge-function parity gate governs three functions and cannot see these
- a redeploy from a clean checkout would silently REVERT all four, reopening
  the account-guard hole and the 500
- code review, rollback and incident response all read the repository first

Deploying a new endpoint on top of unreconciled hotfixes means the first
incident is debugged against source that does not exist.

## Reconciliation plan

Sequenced so that at no point is the deployed state less safe than it is now.

1. **Confirm the capture.** Re-download all four and re-diff; if a diff has
   changed since 2026-08-03, someone is still hot-patching and that must be
   resolved first.
2. **Review each delta on its merits.** Three are straightforward. For
   `nike-shoe-details`, establish whether the upstream endpoint actually works
   before accepting the warning's removal — and if it does not, restore the
   warning rather than the code.
3. **Commit the deltas to the app line** as an explicit
   `fix(edge): reconcile deployed provider hotfixes` change, with these diffs
   cited. Do not squash them into unrelated work; the commit is the record.
4. **Decide the relationship to `security/provider-edge-auth-hardening`.** That
   branch is a much larger rewrite of the same four functions and is NOT what is
   deployed. Reconciling to the current deployed state first gives that branch a
   truthful base to rebase onto; doing it in the other order means reviewing a
   rewrite against a fiction.
5. **Bring the four into the governed manifest.** Add them to
   `GOVERNED_FUNCTIONS`, regenerate `config/edge-function-manifest.json`, and
   confirm `check-edge-function-parity.js` passes. From that point the gate
   catches the next hotfix.
6. **Redeploy from the reconciled source** so deployed bytes and committed bytes
   agree, and re-verify with the download-and-hash method above.

Steps 3, 5 and 6 are owner-approved actions. Nothing in this branch performs
any of them.

## Not in scope here

This branch does not modify, deploy, or reconcile these functions. The
`product-match` endpoint does not call any of them — it reaches
`kicksCrewProvider.ts`, `farfetchProvider.ts` and `shoppingProvider.ts` inside
the `scan-identify` closure, which are governed and verified byte-for-byte
against production.
