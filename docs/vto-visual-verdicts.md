# Live VTO — Human Visual Quality Verdicts

Section 18 deliverable: the log of human PASS/FAIL/HOLD verdicts for every
hard visual gate (Section 22's Phase 1 static-preview gate, Section 34's
Phase 2 live gate, and any other designated hard visual gate along the
way). The autonomous builder may not self-certify a visual gate — see
`docs/vto-risk-register.md` RISK 9.

## Status: no entries

**Nothing has been rendered yet.** This session built contracts, math,
and pipeline scaffolding (`docs/vto-phase1-status.md` has the full list)
but no compositor, no renderer, and no native camera pipeline exist — see
`kscan-live-vto/native/README.md`. There is no review package to submit
and no gate to cross. This document exists now, empty, so the format is
established before the first real review package is assembled.

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
