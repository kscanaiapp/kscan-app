# Live VTO Phase 3 — Source Authority

Section 5 deliverable of the Phase 3 (Visual Realism + Hybrid Generative
Bridge) build plan. Written before any Phase 3 code, per instruction: "Before
coding, document four authorities separately."

This document does not re-derive what Phase 1-2 already established — it
re-verifies each fact directly against source at the start of this session
and records the verification, so drift (if any) is visible rather than
silently inherited.

---

## The four authorities

### 1. PHASE3_RESEARCH_BASE

```
PHASE3_RESEARCH_BASE:   claude/kscan-live-vto-phase1-phase2-lcqyg9  (PR #291 head)
PHASE3_BASE_SHA:        769db5002dff9dbc58eade514bd613488efb1a71
```

This is the isolated Phase 1-2 research line — draft, unmerged, not
production-authorized (PR #291, open, `mergeable_state: clean`). It carries
the entire `kscan-live-vto/` npm workspace: the headless static renderer,
`packages/live-vto-contract`, `packages/body-model`, `packages/asset-pipeline`,
`packages/evaluation`, `packages/garment-contract`, the unbuilt `native/`
scaffold, the protected-path guardrail, and eleven `docs/vto-*.md` files
including a human **PASS** on static preview review package #2 (`37470ca`,
recorded in `docs/vto-visual-verdicts.md`).

**Chosen as the base, not `master`, because Phase 3's entire deliverable set
(temporal segmentation, mask stability, semantic occlusion, edge/lighting/
shadow realism, review corpus) extends that renderer directly.** Branching
Phase 3 from `master` instead would require re-deriving or vendoring the
static-renderer, evaluation, and guardrail machinery Phase 1-2 already built
and got human-PASSed — exactly the "re-litigate architecture without new
evidence" this program is instructed not to do.

### 2. LIVE_VTO_CONTRACT_AUTHORITY

```
LIVE_VTO_CONTRACT_AUTHORITY:  integration/backend-kplus-complimentary-staging-v1
SHA:                          f5ff48c8f764ab3158d1385ea2518e58265f3456
```

**Identical branch to CURRENT_GENERATIVE_VTO_AUTHORITY below.** Phase 1-2's
own audit correction (`docs/source-authority.md`) already established there
is exactly one non-`master` VTO authority — the same branch carries both the
client-side contract types (`types/vto.ts`, `services/vto/*`,
`components/vto/*`) and the governed backend (`supabase/functions/vto-generate/`).
The task instructions list these as two separate fields; this document
answers both with the same branch/SHA rather than inventing a second one that
does not exist in this repository.

**SHA freshly re-verified this session** via `git fetch origin
integration/backend-kplus-complimentary-staging-v1 && git rev-parse
origin/integration/...` — `f5ff48c8f764ab3158d1385ea2518e58265f3456`,
**identical** to the value Phase 1-2 last recorded. No drift since Phase 1-2's
last audit (2026-09-04).

### 3. CURRENT_GENERATIVE_VTO_AUTHORITY

```
CURRENT_GENERATIVE_VTO_AUTHORITY:  integration/backend-kplus-complimentary-staging-v1
SHA:                               f5ff48c8f764ab3158d1385ea2518e58265f3456
RELEVANT MERGED PRs:               #255, #277, #289
```

Re-verified this session by reading source directly (not by re-quoting
Phase 1-2's prose): `supabase/functions/vto-generate/{vtoHandler,vtoContract,
vtoEligibility,vtoEntitlement,vtoFeatureControl,vtoReservation,
vtoResultValidation}.ts`, `types/vto.ts`, `services/vto/{vtoClient,
vtoPersonInput,vtoResultExport}.ts`, `constants/featureFlags.ts`, and the
disclaimer copy in `components/vto/VirtualTryOnSheet.tsx`. Full contract
inventory: `docs/vto-phase3-hybrid-contract.md`.

The retired `tryon-clothes-pro` handler is **not** this authority (confirmed:
`supabase/functions/tryon-clothes-pro/index.ts` on this branch is a
`retiredHandler.ts`-backed refusal). The bridge target is `vto-generate`.

### 4. PRODUCTION_APP_AUTHORITY

```
PRODUCTION_APP_AUTHORITY:  master
SHA:                       688dc35e5bc19bed603eea9835d3f8f12afba3be
VERIFIED:                  at session start, via `git status` / `git log -1`
                            on the branch as checked out — HEAD already sat at
                            this SHA with a clean working tree before this
                            session made any change.
```

This is also the exact commit `PHASE3_RESEARCH_BASE` itself was forked from
(see ancestry below), so Phase 3 inherits Phase 1-2's own verified-current
master baseline rather than re-checking it against a possibly-moved `master`.

---

## Why not "master alone represents current VTO capability"

Restated because it is the single most load-bearing fact this program
inherits, and getting it wrong once already cost Phase 1-2 an audit
correction: **`master` and `integration/backend-kplus-complimentary-
staging-v1` are unrelated histories**, not a fork and a trunk.

```
$ git merge-base origin/master origin/integration/backend-kplus-complimentary-staging-v1
(exit 1 — no common ancestor)
```

Re-run and confirmed this session, exit code identical to Phase 1-2's
finding. Consequently: `components/vto/`, `hooks/useVirtualTryOn.ts`,
`hooks/useVtoAvailability.ts`, `services/vto/`, `types/vto.ts`, and
`supabase/functions/vto-generate/` all exist on the VTO authority branch and
**do not exist on `master` at all**. A diff against `master` alone would show
none of them — not because they are unprotected, but because they are simply
absent from that tree. Phase 3 inherits Phase 1-2's guardrail
(`kscan-live-vto/tools/protected-paths.json`), which protects those paths by
prefix regardless of which branch currently contains matching files.

---

## Ancestry / merge-base — Phase 3 branch

```
BRANCH:              claude/kscan-phase3-realism-bridge-xw9avl
HEAD (after Phase
  1-2 provenance
  merge):            727969f0b9f24f2f8476739e0b5ebb9b98acb8d9
```

This branch started at `master` @ `688dc35e5bc19bed603eea9835d3f8f12afba3be`
(identical commit to PRODUCTION_APP_AUTHORITY above — confirmed via
`git status` at session start: the branch existed, tracked `origin`, and its
tip already equalled that SHA with nothing uncommitted). One merge commit was
then made, bringing in `PHASE3_RESEARCH_BASE` in full:

```
$ git merge origin/claude/kscan-live-vto-phase1-phase2-lcqyg9 --no-ff
Merge made by the 'ort' strategy.
 (all kscan-live-vto/*, docs/vto-*.md, and .github/workflows/live-vto-protected-paths.yml
  from PR #291, unmodified by the merge itself)
```

Verified post-merge:

```
merge-base(HEAD, PHASE3_RESEARCH_BASE) = 769db5002dff9dbc58eade514bd613488efb1a71
                                          (PHASE3_RESEARCH_BASE is now a direct ancestor)
merge-base(HEAD, master)               = 688dc35e5bc19bed603eea9835d3f8f12afba3be
is-ancestor(master, HEAD)              = yes
is-ancestor(PHASE3_RESEARCH_BASE, HEAD) = yes
```

**No cherry-pick was used and no commit was rewritten.** A direct merge was
chosen over cherry-picking individual commits because the entire
`PHASE3_RESEARCH_BASE` tree (not a subset of its commits) is Phase 3's
starting point, and a merge commit records that provenance mechanically and
verifiably (two real parents) rather than as a claim in a doc. No file was
modified as part of the merge — `git show --stat HEAD` shows only additions,
identical in list to `git diff master...PHASE3_RESEARCH_BASE --stat` from
before the merge.

**`integration/backend-kplus-complimentary-staging-v1` (authorities 2 and 3)
is deliberately NOT merged into this branch.** It is read-only source
material for the hybrid-bridge contract inventory (`docs/vto-generate-*`,
`services/vto/*`, `types/vto.ts`, etc., read via `git show <ref>:<path>`
without checkout). Merging it would pull an entire unrelated production
release line into an isolated research branch for no benefit Phase 3 needs —
the same conclusion Phase 1-2's `docs/vto-integration-candidate.md` §6
already reached about PR #291, and it applies identically here.

---

## What this means for Phase 3 mechanically

- Everything Phase 1-2 built under `kscan-live-vto/` is present in this
  branch's working tree, byte-identical to `PHASE3_RESEARCH_BASE`, and
  untouched by anything in this document.
- New Phase 3 files are additive: new packages/modules under
  `kscan-live-vto/packages/`, new `docs/vto-phase3-*.md` files, extensions to
  `kscan-live-vto/tools/render-static-review.js` and
  `kscan-live-vto/tools/protected-paths.json`'s exception list, and (if
  needed) one additional additive CI check — mirroring exactly how Phase 1-2
  itself extended the guardrail when it added new `docs/` files.
- No file belonging to `PRODUCTION_APP_AUTHORITY` or to
  `CURRENT_GENERATIVE_VTO_AUTHORITY` is imported, copied, vendored, or
  modified by this branch. Both remain read-only reference material.
