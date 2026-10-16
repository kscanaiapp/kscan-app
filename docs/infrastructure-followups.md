# Infrastructure follow-up ledger

Pipeline and tooling findings that are not product defects. Each entry records
what was observed, its disposition, and the evidence. Append only.

| ID | Finding | Disposition | Evidence |
|---|---|---|---|
| IF-001 | `production-vto-testing-activation.yml` set up the Supabase CLI with `version: latest`; setup failed with a GitHub API rate limit before any activation step ran. | FIXED: pinned `2.109.1` with a guard test. | Failing run 38859068438 (rerun succeeded); PR #607, merge `441c1102`. |
| IF-002 | `vto-e2e.yml` used `version: latest` in **three** setup steps (staging dry run, full certification, cleanup). The same rate limit failed the first staging dry run on 2026-10-16. | FIXED: all three pinned `2.109.1`, guard test requires every `supabase/setup-cli@v1` step in the file to carry the pin. | Failing run 38854284565 (rerun succeeded); this PR. |
| IF-003 | Correction: PR #607's body says `vto-e2e.yml` has "four places". It has three. Four is the combined count across both workflows before #607 (one in the activation workflow, three here). | RECORDED. | Line scan of `vto-e2e.yml`: lines 254, 322, 407. |
| IF-004 | `supabase/setup-cli@v1` is a floating major tag in every workflow. | P7 DOCUMENT ONLY: pinning actions to commit SHAs is a hardening choice for the owner, not a defect repair. | n/a |

After IF-001 and IF-002 no governed workflow resolves the CLI version through
the releases API.