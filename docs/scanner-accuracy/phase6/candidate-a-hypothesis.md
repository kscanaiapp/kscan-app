# Phase 6 — Candidate A hypothesis record

Written before any Candidate A result exists. No Phase 6 provider run has been
executed. This record must not be revised after results are observed; the
post-evaluation section below is filled in once, by the run that produces them.

## Identity

    CANDIDATE ID:                  phase6-scanner-v1.0-a
    HYPOTHESIS FAMILY:             phase6-scanner-v1.0
    OVERLAY ID:                    phase6-decisive-specificity-v1
    OVERLAY ARTIFACT:              tools/scanner-evaluation/adapter/phase6-scanner-v1.0-a-overlay.v1.json
    CANONICAL RENDERED PROMPT:     certified prompt (sha256 6f2f4dd1c3c2e2d76dffb49fc24283ddfaf49a836f527c02ed2b82ef19b7dd1d)
                                   + overlay text (sha256 b470706f3788912ee9d447a68bc9716a13c3f247a13fac0e5348b5be682e4764)
    MECHANISM:                     append. The certified prompt is never rewritten.
    MODEL CONFIGURATION:           certified-v140 (unchanged: gemini-3.6-flash, fallback
                                   gemini-3.5-flash-lite, temperature 0, maxOutputTokens 2048,
                                   responseMimeType application/json, certified responseSchema)

## Failure class targeted

    PRIMARY:    output_budget_exhausted — response truncated because generation
                and internal reasoning share one 2,048-token ceiling.
    SECONDARY:  generic-vocabulary answers on subtype, material and pattern.

## Observed evidence

Deterministic, from the 66 governed provider results already on disk
(`phase3-dev-control`, `phase3-dev-candidate`, dataset 0.3.1, 33 development
cases each). No new provider call was made to produce this analysis.

| | control (certified-v140) | phase2a-v1.0.0 (rejected) |
|---|---|---|
| mean prompt tokens | 1,698 | 2,700 |
| invalid | 6 / 33 (18.2%) | 14 / 33 (42.4%) |
| HTTP status on every invalid case | 200 | 200 |
| output + reasoning tokens, valid cases | mean 1,413, max 1,983 | mean 1,565, max 2,025 |
| output + reasoning tokens, invalid cases | **2,029 – 2,033, every case** | **2,028 – 2,033, every case** |
| cases finishing within 20 tokens of the 2,048 ceiling | 6 | 13 |
| cases with >500 tokens of headroom | 18 | 8 |

Every invalid case in both runs — 20 of 20 — terminated between 2,028 and 2,033
tokens against a certified `maxOutputTokens` of 2,048. No valid case in either
run came within 20 tokens of that ceiling. The certified request sets no
`thinkingConfig`, so the model's reasoning budget is dynamic and competes with
the response for the same allowance.

The two runs differ by one thing: overlay length. Adding ~1,000 prompt tokens
moved seven further cases across the ceiling. That is a rate of roughly one
additional invalid case per 125 added prompt tokens.

Classification of this evidence: **OBSERVED** for the token-accounting figures,
which are read directly from recorded provider usage metadata. **INFERRED** for
the truncation mechanism itself, because the runs predate `finishReason`
capture. The benchmark repair committed at `3b9a4e8` records
`finishReason` and derives `invalidOutputCause`, so the first Phase 6 control run
promotes this to **PROVEN** or refutes it.

## Hypothesis

Phase 2A's measured accuracy gains on valid pairs (subtype +3/−0, material
+2/−0, pattern +1/−0, brand hallucinations 0) came from its instruction to name
the specific fashion term. Its reliability collapse came from its length, not
its content.

If that separation is real, an overlay carrying the same specificity
instruction at roughly a fifth of the length, plus an explicit instruction to
answer without deliberating, should retain most of the accuracy gain while
holding invalid output at or near the control's 18.2%.

## Exact prompt change

Appended after the certified prompt, verbatim, 769 characters (~192 tokens):

1. A specificity rule — use the specific fashion term the image supports;
   do not answer with a generic word when a specific term is visible.
2. A decisiveness rule — read the image and answer at once; do not deliberate,
   weigh alternatives, or reason step by step; where a detail is not visible,
   give the contract's defined absent value rather than reasoning toward a
   guess.

No field is added, renamed or removed. No enum, type or nesting changes. The
overlay names no field absent from the certified provider contract, which
`assertOverlayDiscipline()` enforces mechanically.

## Predictions

    EXPECTED PRIMARY METRIC:    invalid-output rate on the 33-case development split
    EXPECTED DIRECTION:         no worse than control
    EXPECTED EFFECT RANGE:      6 to 8 invalid cases (18.2% – 24.2%).
                                Point prediction 7.5, from 6 control failures plus
                                192 added prompt tokens at the observed rate of one
                                additional failure per 125 tokens.
    EXPECTED VALIDITY EFFECT:   approximately neutral; materially better than
                                phase2a-v1.0.0's 14
    EXPECTED ACCURACY EFFECT:   subtype and material improve on valid pairs, by less
                                than Phase 2A's margin because the overlay carries
                                fewer of its rules
    EXPECTED SUPPRESSION EFFECT: slight increase. Rule 2 tells the model to give the
                                absent value rather than reason toward a guess, which
                                is the intended behaviour but does raise abstention.
                                Watch the unknown and null rates; a gain that is only
                                a suppression artifact fails the promotion gate.
    EXPECTED LATENCY EFFECT:    neutral to slightly better. Less deliberation is fewer
                                generated tokens.
    EXPECTED COST EFFECT:       +1% to +3% per case from the added prompt tokens,
                                partly offset by shorter reasoning.

## Primary risk

Rule 2 is an instruction about *how much to think*, and the reasoning budget is
set by the provider, not by the prompt. If Gemini's dynamic thinking allowance
ignores the instruction, the overlay contributes only its ~192 added prompt
tokens and the candidate is strictly worse than control on reliability with a
small accuracy gain. That outcome would show as invalid ≥ 8 with unchanged
mean reasoning tokens, and it would be evidence that **prompt-only repair
cannot address this failure class at all** — the family's disproof, not merely
this candidate's.

The secondary risk is that rule 2 suppresses answers the evidence supported,
converting an accuracy problem into an abstention problem. The suppression
metrics exist to catch exactly that, and the promotion gate treats a
suppression-driven gain as a failure.

## Post-evaluation (to be completed by the run that produces results)

    HYPOTHESIS SUPPORTED:   not yet evaluated
    OBSERVED RESULT:        not yet evaluated
    FAILURE EXPLANATION:    not yet evaluated

## Contingent variants — designed, deliberately not rendered

Candidates B and C are not built. Building all three before the first is
measured would spend the authorized budget on variants whose design should
depend on A's result.

- **phase6-scanner-v1.0-b — specificity only.** Rule 1 without rule 2, ~110
  tokens. Justified only if A improves accuracy but its suppression rises past
  the gate, which would implicate rule 2 specifically.
- **phase6-scanner-v1.0-c — minimal decisiveness.** Rule 2 alone in one
  sentence, ~35 tokens. Justified only if A's reliability lands worse than
  predicted, to establish whether *any* appended text is affordable at this
  ceiling.

If A shows that reasoning-token consumption does not respond to prompt
instruction, neither variant is justified and the family is rejected under
§16.
