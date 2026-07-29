# Phase 0E — Owner decisions

Only unresolved owner decisions. Resolved technical work is not listed here.

---

## 1. Dataset source

- [ ] Internal project-owned garment photography authorized
- [ ] Tester-owned garment photography authorized with written permission
- [ ] Licensed image procurement authorized
- [ ] Authorized Build 2 correction fixtures permitted
- [ ] Limited synthetic development imagery permitted

**Recommended: internal project-owned photography** (~9–10 h for ~45 garments).

Operational impact: it is the only channel that resolves ownership, privacy,
real multi-angle sets and verifiable exact-product evidence in one pass. Licensed
stock cannot supply exact-product evidence and many licences now exclude AI/ML
evaluation use. Retailer product pages need legal review before a single capture.

All eight existing QA fixtures are `excluded_pending_provenance` and none may
enter an evaluation manifest until permitted use is documented, so **no dataset
work can start until at least one channel is authorized.**

---

## 2. Storage

- [ ] Private project-controlled object storage
- [ ] Temporary encrypted local volume

**Recommended: private object storage.**

| | Object storage | Encrypted local volume |
|---|---|---|
| Security | Encryption at rest, restricted IAM, no public access | Only as strong as one workstation |
| Setup time | Hours | Minutes |
| Accessibility | Any authorized reviewer | **Single workstation** |
| Auditability | Access logs | **None** |
| Retention | Lifecycle expiry enforced | Manual, therefore unreliable |
| Migration | — | Migration to object storage required later |

The deciding factor is accessibility: a local volume **cannot support two
independent reviewers**, which the holdout requires under either staffing option.
Choosing it forces a mid-phase migration.

Logical reference format if object storage is selected:
`storage://build4-scanner-evals/{caseId}/{viewId}`

---

## 3. Reviewers

- [ ] Full independent development and holdout review — **~26 h**
- [ ] Development single-review plus independently reviewed holdout — **~16.5 h**

**Recommended: full independent review**, if the ~9.5 h delta is available. The
first baseline is the reference every later candidate is compared against;
single-reviewer error in it propagates silently into every future comparison.

Limitations if the single-review option is chosen:

- development ground truth carries **single-reviewer confidence**, and the
  baseline report must state that in the metrics section, not a footnote;
- intra-rater consistency **may not be described as inter-reviewer agreement** —
  a reviewer can be perfectly self-consistent and consistently wrong;
- the 15 holdout cases still require two independent reviews. Not waivable.

No qualification percentage is proposed: a threshold set before calibration data
exists has no referent. Recommendation is to set it from the observed
distribution, with `brand` and `exactProduct` near total agreement because their
admissible-evidence rules are close to mechanical.

Also open:

- [ ] Fund 15–20 **separate** calibration images so reviewers do not calibrate on
      the evaluation set itself (~0.5 h extra capture)

---

## 4. Credential

- [ ] Dedicated evaluation Gemini credential, separate from the production application credential
- [ ] Maximum call count — proposed **200**
- [ ] Maximum dollar ceiling — proposed **$10.00** (modelled worst case $4.05, expected $1.28)
- [ ] Expiry date — required, not optional
- [ ] Revocation owner — assign a named person

Permitted models: `gemini-3.6-flash` primary, `gemini-3.5-flash-lite` fallback.

Handling: stored only in an approved secret manager or an ephemeral environment
variable; never committed, never printed, never written to baseline output;
revoked at completion or expiry, whichever is first.

Note: the adapter now executes the certified path end to end **without any
credential**, using a deterministic mock provider. A credential is required only
for the paid accuracy baseline, not for further adapter work.

---

## 5. Containment merge authority — CLOSED

Both authorized merges landed in Phase 0G-R1 via `--ff-only`. Nothing remains
open here.

| Line | Status | Evidence |
|---|---|---|
| master | **INTEGRATED** | `origin/master` = `08f0d0ef`, post-merge export 23 assets / 0 fixtures |
| iOS | **INTEGRATED** | `release/ios-v18-build-prep` = `70c5b7c6`, post-merge export 44 assets / 0 fixtures |
| Android | **VERIFIED CLEAN** | `37b7141`, 45 assets / 0 fixtures, no change required |
| Certified adapter | **COMPLETE** | Populated V2 item through the certified path, zero external requests |

Detail in `phase0g-post-merge-certification.md`.

Two things worth your awareness rather than your decision:

- The iOS push **created** `origin/release/ios-v18-build-prep`; that branch had
  never existed on origin. Nothing was overwritten.
- master still carries 2 pre-existing test failures, attributed over 10 isolated
  runs as deterministic and unrelated to the containment change. They were not
  repaired — out of scope.

## 6. Escalation still open

| Item | Status |
|---|---|
| `bottom_skirt.jpg` provenance | **OPEN** since 2026-07-29 |
| Follow-up if unresolved | 2026-08-05 |
| While unresolved | Excluded from all Build 4 manifests; production asset untouched |
| Automatic deletion | **None.** Repository removal requires a separate authorized decision |

Exclusion is recorded as `excluded_pending_provenance`, not permanent.
Reintroduction requires an explicit provenance decision and a versioned policy
change.
