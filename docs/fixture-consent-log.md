# Live VTO — Fixture Consent Log

Section 31 requires every piece of controlled human footage used as a Live
VTO fixture to carry: explicit test-purpose consent, a fixture ID, a date,
permitted use, and a storage location, logged here before the footage is
used.

## Status: empty

**No real human footage exists in this program as of this document's last
update.** This cloud sandbox session had no camera, no physical device,
and no consenting human subject available to it — see
`fixtures/people/README.md` and `docs/vto-phase1-status.md`. Every golden
sequence built so far (`fixtures/sequences/`) is synthetic BodyFrame data,
which this log does not cover (Section 31's consent requirement is scoped
to real human footage; synthetic landmark generation involves no person).

## Log format

When real footage is captured, add one row per fixture before it is used
by any test, pipeline, or review package:

| Fixture ID | Date | Subject consent obtained | Permitted use | Storage location | Notes |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |

- **Fixture ID** — matches the `sequenceId`/fixture filename used
  elsewhere in the repo (e.g. `fixtures/sequences/manifests/<id>.json`).
- **Subject consent obtained** — who obtained it, how (written/verbal +
  reference), and confirmation it names Live VTO R&D use specifically.
- **Permitted use** — e.g. "internal engineering evaluation only, not for
  ML training beyond this program, not for external publication."
- **Storage location** — exact path or system; footage must stay out of
  the `kscan-app` production repository regardless (Section 31: "never
  bundled into production").

## Rules this log exists to enforce (Section 31)

- Fixtures are isolated-development-only; never bundled into production.
- Never used for unrelated ML training without separate authorization.
- No scraping public pose datasets without a commercial-licensing review.
- Synthetic augmentation (lighting/noise/compression/background variation)
  may supplement real footage; it does not replace real body diversity as
  a fixture source.
