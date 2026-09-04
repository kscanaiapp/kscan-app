# Golden sequences — coverage status

Section 17 requires golden sequences covering 20 categories (see
`packages/evaluation/src/fixtureManifest.ts`'s `GOLDEN_SEQUENCE_CATEGORIES`).

## Covered today: 3 of 20, all synthetic

| category | manifest | backing |
|---|---|---|
| `centered-subject` | `manifests/synthetic-centered-001.json` | synthetic (seed 7) |
| `tracking-loss` | `manifests/synthetic-tracking-loss-001.json` | synthetic (seed 7, loss window never recovers) |
| `tracking-reacquisition` | `manifests/synthetic-tracking-reacquisition-001.json` | synthetic (seed 7, loss window recovers mid-sequence) |

Regenerate their reports (`reports/<sequenceId>.json`) with:

```
npm run build -w @kscan-live-vto/evaluation
node fixtures/sequences/generate-reports.js
```

The committed `reports/*.json` files are the actual output of that command
against the manifests above — real computed metrics (tracking-confidence
stats, dropped-frame ratio, landmark jitter, tracking-loss/reacquisition
events), not hand-written examples. Given the synthetic, deterministic
seed, running the script again reproduces byte-identical frame data (see
`packages/evaluation/src/__tests__/goldenRunner.test.ts`'s determinism
test) and therefore an identical report.

## Not covered: 17 of 20

`too-close`, `too-far`, `partial-body`, `arm-crossing`, `arms-raised`,
`arms-beside-torso`, `torso-rotation`, `closer-farther-movement`,
`bright-light`, `low-light`, `backlight`, `cluttered-background`,
`clean-background`, `varied-skin-tones`, `varied-body-shapes`,
`varied-current-clothing`, `logo-pattern-garment`.

These require either real camera footage (this cloud sandbox has none —
see `fixtures/people/README.md`) or, for the ones that are plausibly
synthesizable as pure BodyFrame motion (arm-crossing, arms-raised,
torso-rotation, closer-farther-movement), simply more time than this
session's scope than was spent on the pipeline/contract/deformation work
above. `packages/evaluation/src/syntheticFixtures.ts` currently only
implements one pose (`generateCenteredStandingSequence`); extending it
with an arm-raise/arm-cross/rotation/distance-change generator is
straightforward follow-up work, not a blocked one — see
`docs/vto-phase1-status.md`'s next-critical-path-item.

Camera-derived categories (`bright-light`, `low-light`, `backlight`,
`cluttered-background`, `clean-background`, `varied-skin-tones`,
`varied-body-shapes`, `varied-current-clothing`, `logo-pattern-garment`)
are fundamentally about real pixel content and lighting/segmentation
behavior — synthetic BodyFrame series cannot stand in for them at all.
These require a real device session per Section 30/31, which this program
should schedule explicitly rather than attempt to fake here.
