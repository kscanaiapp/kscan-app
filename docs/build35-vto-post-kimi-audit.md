# Build 35 VTO post-Kimi integration audit

Authority inspected on 2026-10-04:

- Integration: `de75f643fac91a91d60e82b8748601dfc1760a4c`
- PR #499 start: `c766c3acfbc139001f14a728847d6cad44e35c98`
- PR #455: head `6887e9c27cf843cd7082db34b6692be7457ca3ab`,
  base `fix/notifications-final-convergence-v1`
- PR #457: head `9fb931cccca84594d9d425da35240bd3215bc94f`,
  base `fix/notifications-final-convergence-v1`

PR #499 was merged locally with the authoritative integration branch. The Kimi
commit remains an ancestor; no historical branch was merged or cherry-picked.

## PR #455 classification

| Feature | Classification | Resolution |
| --- | --- | --- |
| Result/product/request identity gate | STILL_VALUABLE_PORT | Pure exact-identity gate added; mismatches render no result actions. |
| Primary Shop hierarchy | STILL_VALUABLE_PORT | Shop is the sole primary result action when Commerce supplies a destination. |
| No shop link | STILL_VALUABLE_PORT | No disabled/dead Shop action; bounded unavailable copy is shown. |
| Save this try-on | STILL_VALUABLE_PORT | Existing Dressing Room path retained with VTO-specific copy and confirmed-write semantics. |
| Watch | STILL_VALUABLE_PORT | Optional callback returns to the host's existing Watch authority after collapsing VTO. |
| Try again | STILL_VALUABLE_PORT | Explicit only; respects retryability and bounded Retry-After cooldown. |
| Try another piece | STILL_VALUABLE_PORT | Added as a tertiary exit while preserving the session photo. |
| Original/photo comparison | ALREADY_PRESENT | Existing Kimi/current comparison toggle retained; historical redesign not imported. |
| Progress truth | STILL_VALUABLE_PORT | Real request states name stages; time can only add “still working.” |
| Retry-After handling | STILL_VALUABLE_PORT | Provider header is parsed, bounded, carried through the contract, and never auto-retried. |
| Request-in-flight behavior | STILL_VALUABLE_PORT | Distinct non-retryable failure; no second paid request is invited. |
| Save confirmation | STILL_VALUABLE_PORT | Success appears only after the durable Dressing Room write confirms. |
| Modal behavior | STILL_VALUABLE_PORT | Selective collapse/close callbacks added while preserving current actor-scope and navigation guards. |
| Result telemetry | STILL_VALUABLE_PORT | Content-free viewed/shop/watch/save/try-another/exit events added. |
| Failure wording | STILL_VALUABLE_PORT | Quota, duplicate request, provider busy, and legacy rate-limit meanings are separated. |
| Historical full result presentation | OBSOLETE | Kimi/current visual structure wins; no wholesale restoration. |
| Historical modal implementation without current actor guards | CONFLICTS_WITH_CURRENT_AUTHORITY | Rejected; only narrow callback/copy changes were adapted. |

PR #455 remains open. Its still-valid product behavior is represented here, but
the obsolete-base PR must be closed or otherwise resolved by the owner after
review of this branch.

## PR #457 reference audit

- Eligible ProductShelf and shipped scan-result products already expose the
  current `TryItOnEntry`; no duplicate VTO CTA was added.
- Scan results retain `surface="scan_result"`, first-use education, and their
  existing watch-modal awareness blocker.
- ProductShelf intentionally does not opt into first-use education. It receives
  only a small Watch handoff from the VTO result and continues to use its own
  Shop destination and Watch modal.
- Product/request identity is carried through the canonical garment builder and
  the new result gate. Awareness still cannot start generation.
- The historical ProductShelf layout, compare presentation, card sizing, and
  broader Commerce redesign remain independent value in #457 and were not
  imported into this lane.

PR #457 remains open for owner disposition.

## Open-PR overlap inventory

The intended file set also overlaps these currently open PRs:

- #499: the current branch and its existing K+/VTO/scan-result files.
- #458: generated Edge manifest only.
- #457: `components/ProductShelf.tsx`.
- #456: Edge governance/config files only.
- #455: the VTO decision-loop files listed above.
- #427: `components/ProductShelf.tsx`.
- #188: `supabase/config.toml`.

No code was copied from #458, #456, #427, or #188. Their overlap is recorded so
later convergence can resolve generated/config or ProductShelf conflicts
deliberately.

## Dependency/security observation

No package dependency was added. The changed runtime paths use existing React
Native, Supabase, and platform WebCrypto APIs. GitHub's detailed Dependabot API
was unavailable to the current token (HTTP 403), so `npm audit --omit=dev` was
used as the local observation: it reports existing transitive/direct findings,
but none is introduced specifically by this lane. Dependency upgrades remain
outside this scoped integration pass.
