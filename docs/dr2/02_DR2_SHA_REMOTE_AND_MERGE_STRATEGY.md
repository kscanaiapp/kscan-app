# DR-2 SHA, Remote, and Merge Strategy

## Remote correction
- KC05 root already pointed at GitHub.
- E-4 worktree `.git` pointer repaired from dead `/sessions/...` path to `C:/src/KScan-elise-backend-foundation-repair-20260720`.
- Audited E-4 tip was ahead of GitHub by 2 commits; pushed (no force).

## Strategy
- BASE = DR-1 `955c58b` (authoritative item/provenance/commerce/dedupe).
- MERGE = full audited E-4 `252d1f8` (not cherry-pick of `787f311`/`252d1f8` alone).
- Merge: `git merge --no-ff --no-commit` then commit `merge(dr2): ...`.
- Overlap files: `attachmentContext.ts`, `index.ts` (auto-merged; semantic verification + repairs followed).
