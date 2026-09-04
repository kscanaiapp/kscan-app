# People fixtures — empty by design

**No real human footage or imagery exists in this directory, and none was
added in this session.**

Section 31 requires, for any controlled human footage used as a fixture:
explicit test-purpose consent, a fixture ID, a date, permitted use, and a
storage location, all logged in `docs/fixture-consent-log.md`. This cloud
sandbox session has:

- no camera,
- no physical device,
- no consenting human subject available to it.

So there is nothing to log, and nothing belongs in this directory yet.
`docs/fixture-consent-log.md` exists as the (currently empty) log this
directory's future contents must be entered into before any capture is
added here — do not add a file to this directory without a corresponding
row in that log.

Section 31 also prohibits scraping public pose datasets without reviewing
commercial licensing, and states synthetic augmentation "does not replace
real body diversity" — so this directory is not a candidate for synthetic
substitutes either. The evaluation package's synthetic BodyFrame generator
(`packages/evaluation/src/syntheticFixtures.ts`) lives entirely outside
this directory for exactly that reason: it produces landmark coordinates,
never imagery, and is clearly marked non-substitutive in its own header.

---

## Update — synthetic person fixtures (2026-09-04)

Section 9 of the static-preview pass authorizes **synthetic** person fixtures
for validating rendering mechanics. Those now exist, but they are *generated
in code*, not stored here: see
`packages/static-renderer/src/fixtures/person.ts`
(`generateSyntheticPerson`), which draws a procedural torso and emits the
exactly-known `BodyFrame` and foreground mask alongside it.

Rendered copies appear under `evidence/static-preview/*-00-person-fixture.png`
and are labelled **SYNTHETIC — NOT HUMAN** everywhere they are cited.

This directory's rule is unchanged: it holds real human footage, of which
there is none, and none may be added without a consent-log row first.
