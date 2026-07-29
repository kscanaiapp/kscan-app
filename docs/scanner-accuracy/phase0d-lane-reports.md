# Phase 0D — Lane reports

Companion to the Phase 0D final report. Evidence and specifications per lane.

---

## Lane A.1 — QA fixture reference map (read-only)

Every reference to `constants/qaFixtures.js` and `assets/qa_fixtures/`, classified.

| Reference | Classification | Notes |
|---|---|---|
| `constants/qaFixtures.js` | **production static dependency** | The defect. Held eight `require()` calls, collected into the production module graph. |
| `app.js:48` `import { QA_FIXTURES }` | **production runtime** | The single consumer. The QA panel itself is gated behind `QA_TOOLS_ENABLED`. |
| `constants/build.js` | development runtime | Ties `QA_TOOLS_ENABLED` to `__DEV__ === true`. |
| `scripts/qa-fixtures.js` | test only | Tooling over the fixture directory; not in the app graph. |
| `__tests__/qaFixturesProductionGate.test.js` | test only | Present on gated branches. Asserts runtime deadness, **not** asset exclusion. |
| `assets/qa_fixtures/*.jpg` | production static dependency | Reached via the requires above. |

**Dynamic requires: none.** All eight were static, which is why Metro collected
them regardless of any guard.

### Branch reachability

| Branch | Source gate | Contains `918d2a3` |
|---|---|---|
| `origin/master` (`9bb0b57`) | **UNGATED** | no |
| `release/ios-v18-build-prep` (`435e4ba`) | **UNGATED** | no |
| `integration/ios-v19-ipad-optimization-candidate` (`b14566c`) | **UNGATED** | no |
| `release/android-v27-build-prep` (`37b7141`) | GATED | **no** |
| `integration/android-v27-closet-release-candidate` (`37b7141`) | GATED | **no** |

Two branches are gated **without** containing `918d2a3` — they carry equivalent
logic from a different commit. That is exactly why commit presence is
supplementary evidence only: searching for the commit would have mislabelled
them, in both directions.

### Why the source gate is not containment

The `__DEV__ ? [require(...)] : []` guard leaves the runtime path dead and the
images shipped. Metro collects asset dependencies while building the module
graph; the dead branch is eliminated later, at minification. A test that
evaluates the module with `__DEV__ = false` passes while the assets are still in
the bundle.

**Only an export settles it**, which is what Lane A.2 did.

---

## Lane A.2 — Containment evidence

| Field | Value |
|---|---|
| Branch | `fix/qa-fixture-production-containment` |
| Base | `release/ios-v18-build-prep` |
| Base SHA | `435e4bae1df0c6d50c22cdad42a80eb5d460ff69` |
| Commit | `4c72012` |
| App version / iOS build / Android versionCode | `1.0.1` / `17` / `23` |
| Base clean at branch time | yes, 0 dirty files |

### Export command

No governed export script exists in `package.json`, and `metro.config.js` was
the Expo default. Command chosen and recorded:

```bash
npx expo export --platform ios --output-dir <dir>
```

Justification: `expo export` is Expo's production export — development mode is
off by default — and it produced the same `dist/` + `metadata.json` +
content-hashed `assets/` structure as the pre-existing Phase 0C artifacts, so
the comparison is like-for-like. **No EAS profile was passed**, because
`npx expo export` does not accept or apply one.

`node_modules` in the containment worktree is a **real directory** copied from a
release worktree with a matching `package-lock.json`, not a junction. A
junctioned `node_modules` silently truncates an export and would have
invalidated the comparison.

### Result

| Export | Assets | `fixtureAssetsPresent` |
|---|---|---|
| Pre-repair | 52 | **8** |
| Post-repair | 44 | **0** |

A difference of exactly eight. Pass condition `fixtureAssetsPresent = 0` met.

Gates run on the branch: **1880 tests, 0 failures**, `git diff --check` clean,
worktree clean.

**Not merged. Not deployed.**

---

## Lane C — Credential provisioning specification

**No credential is requested or used by this phase.** This is the spec for the
owner to fill.

| Field | Requirement |
|---|---|
| Credential owner | *owner to assign* |
| Provider project | A dedicated evaluation project, **separate from the production application credential**, so evaluation spend is attributable and revocable without touching production |
| Permitted models | `gemini-3.6-flash` (primary), `gemini-3.5-flash-lite` (fallback) — nothing else |
| Permitted environment | The isolated adapter only. Never the mobile app, never an Edge Function |
| Maximum call count | 200 (enforced by `--max-calls`; `CallBudget.consume` throws rather than exceeding) |
| Approved dollar ceiling | *owner to set* — modelled worst case $4.05, requested $10.00 |
| Start / expiry date | *owner to set*; expiry is required, not optional |
| Revocation owner | *owner to assign* |
| Emergency revocation | Revoke in the provider console; the run aborts on the next call and every completed case is already durable |

Storage and handling:

- stored only in an approved secret manager or an ephemeral environment
  variable for the run;
- **never committed, never printed, never written to baseline output** — the
  adapter ledger is asserted by test to contain no credential, prompt, image
  bytes or token;
- revoked after baseline completion or at the approved expiry, whichever is first.

**No unsupported provider feature is assumed.** Provider-side budget alerts and
API restrictions are recommended *where supported*; no API-side spend cap or
custom request header is invented, and none is relied on. The enforcement that
actually holds is local: the hard call ceiling and the absence of any default
transport.

---

## Lane B — Storage options

**Do not begin photography until the owner selects one.** No vendor is
hardcoded.

### Option 1 — Project-controlled private object storage *(preferred)*

Logical reference format: `storage://build4-scanner-evals/{caseId}/{viewId}`

### Option 2 — Encrypted local volume *(temporary)*

Full-disk or volume encryption, access restricted to the authorized workstation
account, **no synchronization to consumer cloud services**, opaque filenames,
temporary retention, with a documented migration path to Option 1.

### Comparison

| Dimension | Object storage | Encrypted local volume |
|---|---|---|
| Security | Encryption at rest, restricted IAM, no public access | Encryption at rest; security is only as good as one workstation |
| Accessibility | Any authorized reviewer | Single workstation — blocks a second reviewer outright |
| Auditability | Access logs | **None** |
| Cost | Cents/month at this volume | Zero |
| Setup time | Hours (provisioning, IAM, lifecycle) | Minutes |
| Retention | Lifecycle expiration enforced automatically | Manual, therefore unreliable |
| Backup | Provider durability + versioning | Whatever the workstation has |
| Operational risk | Misconfigured public access — the classic failure | Loss, theft, or accidental sync into a consumer cloud |

**Recommendation: Option 1.** Option 2 cannot support two independent reviewers,
which is precisely what the holdout requires under either staffing option — so
choosing it now would force a migration mid-phase.

---

## Lane B — Acquisition schedule

Evidence-based, and **no completion dates are promised**: every week below is
gated on people, garments, storage and reviewer capacity the owner has not yet
confirmed. Durations are effort estimates, not calendar commitments.

| Week | Work | Effort | Gated on |
|---|---|---|---|
| 1 | Source-channel approval, storage selection, garment inventory, participant authorization, capture-guide approval | ~4 h owner + ~2 h setup | **Owner decisions** |
| 2 | Internal photography, privacy review, EXIF removal, hashing, manifest creation | ~9–10 h | Week 1, garment availability |
| 3 | Independent labeling, adjudication, coverage repair, dev/holdout assignment | ~16.5–26 h | Reviewer staffing |
| 4 | Freeze candidate dataset, complete dry-run, prepare paid baseline authorization | ~2 h | Weeks 2–3 |

Variance to be reported weekly once the plan is authorized.

### Real-image thresholds

| Real governed cases | Consequence |
|---|---|
| **75** | Full first baseline as specified |
| **50–74** | Optional **PILOT BASELINE**, owner approval required, and it must **never** be represented as the final first baseline |
| **< 50** | **No paid accuracy baseline may run.** Adapter and harness testing continue; the exact sourcing shortfall is reported |

Synthetic cases count toward **neither** the 50-case real-image minimum nor the
holdout.

### Multi-image policy

A true multi-image set requires **independently captured views that can carry
different evidence** — front and back, product and label, item and logo detail,
item and material detail, or genuinely different angles.

Crops, compression variants, lighting transforms and degradations of one image
are `transformation_derivatives`. They may test preprocessing robustness,
parsing, grouping and adapter mechanics. They do **not** count toward true
multi-image coverage, independent evidence reconciliation, or the holdout
multi-image requirement.

The reason is not bookkeeping: two crops of one photograph share every
photographic accident — the same lighting, the same occlusion, the same
mis-focus. Counting them as independent angles would inflate cross-angle
agreement, which is the exact quantity the multi-image metric exists to measure.

Synthetic multi-angle imagery stays separately labelled and cannot substitute
for real independent views in the baseline.

---

## Fixture provenance and escalation tracking

All eight fixtures remain **`pending_provenance`**. None may enter the Build 4
evaluation dataset until provenance and permitted use are documented.

`bottom_skirt.jpg` is excluded from every Build 4 dataset manifest, from
baseline planning, from candidate comparisons, and from derived evaluation
imagery. The factual escalation record is preserved at
`phase0c-fixture-escalation.md`. **The production asset is neither deleted nor
modified from the research branch.**

**This exclusion is not characterized as permanent.** It stands until provenance
and permitted use are affirmatively resolved, which is an owner decision.

| Field | Value |
|---|---|
| Escalation date | 2026-07-29 (Phase 0C report) |
| Owner-decision status | **OPEN** |
| Follow-up | After 7 calendar days if unresolved — i.e. 2026-08-05 |
| While unresolved | Exclusion continues |
| Automatic deletion | **None.** No asset is deleted after any elapsed time; repository removal requires a separate authorized decision |
