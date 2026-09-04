# Live VTO — Human Visual Quality Verdicts

Section 18 deliverable: the log of human PASS/FAIL/HOLD verdicts for every
hard visual gate (Section 22's Phase 1 static-preview gate, Section 34's
Phase 2 live gate, and any other designated hard visual gate along the
way). The autonomous builder may not self-certify a visual gate — see
`docs/vto-risk-register.md` RISK 9.

## Verdicts

### 1 — Static preview review package #1 — FAIL

```
LANDMARK:              Static preview review package #1 (rigid + deformation +
                       compositing + occlusion + lighting)
SHA:                   ee298587
DATE:                  2026-09-04
FIXTURES:              6 synthetic cases, 2 synthetic garments
REVIEWER:              Human (program owner)
VERDICT:               FAIL
PRIMARY BUCKET:        DEFORMATION
REQUIRED CHANGES:      Repair the existing control-point/target topology
                       responsible for:
                         1. vertical chest/logo compression
                         2. centre hem notch
                         3. shoulder-cap undercoverage
                         4. hard garment-edge compositing
                       Preserve affine MLS unless evidence AFTER topology
                       repair shows the deformation algorithm itself is
                       defective. Re-render the same six cases, retain
                       before/after artifacts and metrics, produce review
                       package #2.
ACCEPTED LIMITATIONS:  Synthetic fixtures, precomputed masks, headless
                       evaluation renderer — all unchanged and not at issue.
NOTES:                 Rigid attachment, mirroring, occlusion semantics and
                       lighting restraint were not the failure. The named
                       defects are all downstream of how control-point
                       targets are derived.
```

Response: `docs/vto-static-preview-review.md` (package #2). Root cause found
and recorded there — the `waist` target was pinned to the anatomical waist
landmark while the garment's waist control point is a point at 76% of the
garment's own length, which compressed everything above it and dragged the
mid-hem upward. One defect, two symptoms.

### 2 — Static preview review package #2 (topology repair) — PASS

```
LANDMARK:              Static preview review package #2 (topology repair)
SHA:                   37470ca
DATE:                  2026-09-04
FIXTURES:              6 synthetic cases, 2 synthetic garments
REVIEWER:              Human (program owner)
VERDICT:               PASS
ACCEPTED LIMITATIONS:  Armpit gap with arms away/crossed (no gusset geometry
                       modelled). Residual aspect deviation on the stress
                       bodies — 1.155 broad, 0.864 narrow (bounded, not
                       eliminated). The broad fixture is deliberately outside
                       a realistic human range (stress case, not typical).
                       Lower torso reads slightly boxy — linear taper below
                       TORSO_WIDTH_HOLD_T, no drape model. All four carried
                       forward from `docs/vto-static-preview-review.md`'s
                       "Still open" section unchanged; none were required
                       changes for this PASS.
REQUIRED CHANGES:      None for this gate.
NOTES:                 All four package #1 defects (vertical chest/logo
                       compression, centre hem notch, shoulder-cap
                       undercoverage, hard garment-edge compositing) verified
                       repaired. Affine MLS confirmed unmodified — byte-
                       identical to package #1; the repair was entirely in
                       control-point/target topology. This PASS licenses
                       continued isolated Phase 1 work (the Section 34-style
                       emulator-native validation lane) but is a synthetic,
                       headless-renderer result only — it does not certify
                       device rendering, real garments, or real bodies, and
                       does not itself authorize Phase 2 live garment
                       rendering.
```

## Entry format (Section 18)

For each hard visual gate reviewed, append:

```
LANDMARK:              <e.g. "Phase 1 static preview gate (Section 22)">
SHA:                    <commit SHA the review package was built from>
DATE:
FIXTURES:               <which golden sequences / captures were reviewed>
REVIEWER:
VERDICT:                PASS | FAIL | HOLD
ACCEPTED LIMITATIONS:
REQUIRED CHANGES:
NOTES:
```

A dependent visual phase may not cross a hard gate without a recorded
PASS here. Per Section 18, the agent may continue unrelated independent
work while awaiting review, and should record a blocker here rather than
rewriting indefinitely if a visual problem is repeatedly blocked.
