# Build 35 — convergence checkpoint

**Status: source-converged development authority.**
Not a production release candidate, not release-ready, not promoted to any
release line.

This document names the accepted integrated Build 35 source state so later
lanes have one SHA to cite, and records the one non-product defect closed in
the same lane.

---

## 1. Source authority

| | |
|---|---|
| **Branch** | `fix/notifications-final-convergence-v1` |
| **SHA** | `047cce3a8642124826d171d551ce4087051a8663` |
| **Tip commit** | Merge pull request #340 — Commerce Corpus V1 |

### Checkpoint branch

| | |
|---|---|
| **Branch** | `integration/build35-convergence-checkpoint-v1` |
| **Base SHA** | `047cce3a8642124826d171d551ce4087051a8663` |
| **Source delta at creation** | **0 changes** |

The earlier convergence lane merged its feature work directly into
`fix/notifications-final-convergence-v1` rather than into the planned isolated
integration branch. **Those merges are not rewritten, reverted or reordered by
this checkpoint.** The checkpoint is purely additive: a named ref at the
already-accepted SHA, cut so that later work has a stable authority to build on
and so the convergence point is citable after the source branch advances.

No history was rewritten. No force-push was performed on any branch.

---

## 2. Feature convergence

Every entry below was verified as an ancestor of the checkpoint SHA
(`git merge-base --is-ancestor`), not inferred from the existence of a PR.

| Area | Converged work | PR | Head SHA |
|---|---|---|---|
| **Avatar / Elise** | V10 avatar engine source authority certified (staging) | #333 | `ee65cd0c` |
| **Closet** | Closet Experience V1 — wardrobe home, search, sync visibility | #335 | `6153ccf8` |
| **Closet** | Closet Ownership V1 — intake safety, corrections, review workflow | #336 | `572311ed` |
| **Closet** | Closet Intelligence V1 — deterministic wardrobe insights, contract authority | #337 | `f4f7def9` |
| **VTO** | VTO runtime readiness — tracking, capture, recovery, cross-platform contract | #334 | `1c50fbf8` |
| **VTO** | VTO pilot productization — occlusion stability, asset-key and Photoreal negative controls, session recovery | #338 | `60931259` |
| **Commerce** | Commerce V2 — retailer truth, commerce-first cards, Where to Buy | #339 | `9ddd4f78` |
| **Commerce** | Commerce Corpus V1 — deterministic evaluation and negative-control authority | #340 | `5378b219` |
| **PostHog** | PH35-R1 — full containment when configuration is not usable | #384 | `6396088a` |
| **PostHog** | PH35-R2 — anonymous-only, never authenticated identity | #385 | `504b76f9` |
| **PostHog** | PH35-R3 — governed runtime boundary before PostHog | #386 | `d2038058` |

### PostHog guarantees at this checkpoint

Re-verified at the checkpoint SHA by running the probe suites, which observe the
process boundary rather than restating the wrapper's own rules:

- **Disabled config** — no client constructed, no vendor method called, no
  polling interval scheduled, zero network egress.
- **Authenticated identity** — no `identify()`; no Supabase UUID, email, phone,
  JWT, push token or RevenueCat identity reaches the vendor under any
  authentication lifecycle.
- **Governed boundary** — unknown event dropped, unknown property stripped,
  unsafe values stripped, direct feature-vendor capture zero.

---

## 3. Fashion R&D authority

| | |
|---|---|
| **Branch** | `research/build35-fashion-intelligence-rd-v1` |
| **SHA** | `606c81f366e0c5265e3cbb8e41f94898512b4044` |

**Unchanged by this lane.** The R&D spine is a separate authority and was
neither merged into, nor merged from, the checkpoint. No FashionCLIP,
segmentation, barcode/GTIN, Closet, VTO, Commerce, Elise or analytics work was
started here.

---

## 4. Known non-product issue — Windows PostHog harness

**Status: CLOSED by this lane.**

### The defect

The three PostHog probe suites spawn a child process with
`node --import <module> <probe> ...`. Each passed an absolute filesystem path,
built by `path.join`, as the `--import` value. Node resolves that value as a
**URL**, not as a path:

| Platform | Value | Outcome |
|---|---|---|
| POSIX | `/home/u/x.mjs` | no scheme → parsed relative, resolved → child starts |
| Windows | `C:\src\x.mjs` | `C:` parses as a **scheme** → loader rejects it |

```
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in:
file, data, and node are supported by the default ESM loader.
Received protocol 'c:'
```

Every probe child died before executing a line of probe code. Each suite
asserts `result.status === 0`, so **66 of 73** PostHog assertions failed on
Windows for a reason with nothing to do with PostHog — while the same suites
stayed green on Linux and in CI. The governed local suite was not trustworthy
on Windows.

### The repair

The raw-path construction was duplicated verbatim across the three suites with
no shared seam. The narrowest one was added —
`__tests__/helpers/posthogProbeSpawn.js` — and all three route through it. The
`--import` value is now a real `file:` URL from `pathToFileURL`, the
standards-correct representation of a local path as a module specifier: it
emits `file:///C:/...` for drive paths, keeping the drive letter in the URL
*path* rather than in scheme position, and percent-encodes spaces, `#`, `?` and
non-ASCII. The probe entry point and its arguments stay as paths, which is what
Node resolves the positional argument as on every platform.

No literal `C:\`, no manual `file://` concatenation, no `process.platform`
branch.

### What did not change

- No assertion, expectation or negative control weakened or removed.
- No test skipped or excluded on any platform.
- `config/test-failure-baseline.json` untouched — the baseline was **not**
  widened to absorb the failures.
- **No PostHog runtime, provider or wrapper source modified.** The diff is
  confined to `__tests__/`.

### Negative control

`__tests__/posthogProbeHarnessCrossPlatform.test.js` keeps the defect from
returning. The loader's URL parsing is identical on every platform — only
`path.join` differs — so it drives Windows-shaped input through a real child
process and reproduces the Windows failure without a Windows runner. Its first
case asserts a raw drive-letter specifier is *still* rejected, so the repaired
cases prove the fix rather than a loader that stopped caring.

| Condition | Result |
|---|---|
| Broken raw path (mutant, not committed) | **FAIL as expected** — 66/73, every failure `ERR_UNSUPPORTED_ESM_URL_SCHEME` |
| Fixed file URL | **PASS** — 106/106 across all four PostHog suites |

66 is exactly the unexpected-failure count the prior convergence report recorded
on Windows, confirming a single shared root cause across the three files.

---

## 5. Build 34 audit — PR #363 disposition

`docs(audit): push notification / Watchlist delivery hostile audit` is a
**Build 34** audit of `release/kscan-pre-freeze-v1`, not Build 35 code. It was
**not merged into this checkpoint** and must not be: the two lines are separate
authorities.

Its findings were reconciled finding-by-finding against the Build 34
notification / Watchlist repair train merged after the audit was filed
(PRs #370, #374, #376, #377, #378, #380, #381, #391). The full ledger with
per-finding source evidence is posted on PR #363 itself.

Summary:

| Class | Findings |
|---|---|
| **CLOSED** by later merged repair | F-01, F-03, F-05, F-06, F-07, F-10, F-11 |
| **PRODUCTION_HOLD** | F-02, F-04 |
| **REQUIRES EXTERNAL CERTIFICATION** | F-08, F-09 |
| **DEFERRED_BY_DESIGN / recorded** | F-12, F-13, F-14, F-15, F-16 |

No actionable Build 34 **source** defect remains open. The audit is retained as
historical evidence.

Two distinctions are deliberately preserved rather than collapsed:

- **F-02** — a staging-scoped GitHub workflow existing is **not** a production
  scheduler. Its cron remains commented out and
  `docs/watchlist-backend-readiness-02-staging-certification.md` records
  `ACTIVE_SCHEDULER_EXISTS = NO` in every environment.
- **F-04** — the production backend absence is an intentional hold pending Apple
  approval, recorded as **PRODUCTION_HOLD**, not as "defect fixed".

**No Build 34 source was repaired in this lane.** Reconciliation only.

---

## 6. Release safety

| | |
|---|---|
| Production touched | **NO** |
| Production deploy | **NO** |
| Staging feature deploy | **NO** |
| EAS build | **NO** |
| EAS submit | **NO** |
| Apple-reviewed build changed | **NO** |
| Migration applied | **NO** |
| Credential created, rotated or read | **NO** |
| History rewritten / force-push | **NO** |

---

## 7. Verification at this checkpoint

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **PASS** (exit 0) |
| `node scripts/run-all-tests.js` | 8594 tests — **13 known, 0 unexpected** (exit 0) |
| `node scripts/check-dependency-reachability.js` | **PASS** — no unapproved critical/high, no path drift |
| PostHog containment / identity / boundary / governance / harness | **106/106 pass** |
| `git status --porcelain` | clean |

The governed known-failure baseline holds 19 recorded identities; 13 were
observed and 6 have since been fixed, which the runner permits. The baseline
file was not edited.

Verification ran on Linux. The Windows failure mode is covered by the committed
cross-platform regression test rather than by a Windows runner; see §4 for why
that is equivalent for this defect class.
