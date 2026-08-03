# Phase 6 §11 — scanner failure analysis

Deterministic. Derived from the 66 governed provider results already on disk
from the Build 4 Phase 3 live runs (`phase3-dev-control`,
`phase3-dev-candidate`; dataset 0.3.1, 33 development cases each). **No provider
call was made to produce this analysis. Spend: $0.00.**

## Headline

`model_json_unparseable` is not a JSON-formatting failure. It is **response
truncation caused by exhaustion of the output-token budget that the response
and the model's own reasoning share.**

Every invalid case in both runs — 20 of 20 — returned HTTP 200 and terminated
between 2,028 and 2,033 tokens of generation against a certified
`maxOutputTokens` of 2,048. No valid case in either run came within 20 tokens
of that ceiling.

## Counts

| | control (certified-v140) | phase2a-v1.0.0 (rejected) |
|---|---|---|
| cases | 33 | 33 |
| `provider_success` | 27 | 19 |
| `provider_output_invalid` | 6 (18.2%) | 14 (42.4%) |
| failure stage | validation, 6/6 | validation, 14/14 |
| HTTP status on failures | 200 on 6/6 | 200 on 14/14 |
| transport failures, timeouts, rate limits, safety blocks | 0 | 0 |
| provider fallbacks used | 0 | 0 |
| retries | 0 | 0 |

Against the §11 taxonomy: **zero** cases fall in `provider error`, `timeout`,
`safety block`, `empty response`, `markdown fences`, `leading commentary` or
`trailing commentary`. Every failure is a single class — a truncated response —
and the token accounting is what identifies it.

## Token accounting

Reasoning tokens are derived as `totalTokenCount − promptTokenCount −
candidatesTokenCount`, all three read from recorded provider usage metadata.

| | control valid | control invalid | candidate valid | candidate invalid |
|---|---|---|---|---|
| n | 27 | 6 | 19 | 14 |
| mean prompt tokens | 1,700 | 1,688 | 2,700 | 2,699 |
| mean response tokens | 153 | 83 | 152 | 70 |
| response token range | 130 – 186 | 64 – 131 | 112 – 181 | 63 – 93 |
| mean reasoning tokens | 1,260 | 1,949 | 1,413 | 1,961 |
| mean response + reasoning | 1,413 | **2,032** | 1,565 | **2,031** |
| max response + reasoning | 1,983 | 2,033 | 2,025 | 2,033 |

Headroom to the 2,048 ceiling, by case:

| headroom | control | candidate |
|---|---|---|
| under 20 tokens | **6** | **13** |
| 20 – 200 | 2 | 6 |
| 200 – 500 | 7 | 6 |
| over 500 | 18 | 8 |

The under-20 band is exactly the failure set in the control, and all but one of
it in the candidate.

## Root cause

The certified request sets `maxOutputTokens: 2048` and **no `thinkingConfig`**.
The model's reasoning allowance is therefore dynamic and draws on the same
budget as the response. On a hard image the model reasons until it approaches
2,048, then has too little left to close the JSON object, and returns a
syntactically incomplete body with HTTP 200 and no error of any kind.

This explains the historical result that made no sense on its own terms: the
Phase 2A overlay produced *better* answers on the cases it could answer
(subtype +3/−0, material +2/−0, pattern +1/−0, brand hallucinations 0) while
producing far *more* invalid output. Its ~1,000 added prompt tokens raised mean
reasoning from 1,260 to 1,413 and pushed seven further cases across the
ceiling. The overlay's content was not the problem. Its length was.

Observed sensitivity: **roughly one additional invalid case per 125 added
prompt tokens**, over the 33-case development split.

## What this means for prompt-only repair

Every authorized candidate overlay is **appended** — the certified prompt is
never rewritten, by design. So every candidate necessarily adds prompt tokens,
and therefore pushes in the direction that causes this failure. The overlay
mechanism and the dominant failure mode are in direct tension.

Two prompt-only levers remain:

1. Keep the overlay very short, so the added tokens cost less than the
   instruction gains. This is Candidate A.
2. Instruct the model not to deliberate, in the hope its dynamic reasoning
   allowance responds to instruction. Also Candidate A, as its second rule.

If lever 2 does not work, lever 1 alone can only ever be damage limitation, and
the prompt-only hypothesis family is disproven for this failure class.

## Evidence classification

- **OBSERVED** — every count and token figure above. Read directly from
  recorded provider usage metadata in the governed run outputs.
- **INFERRED** — that the mechanism is specifically `finishReason: MAX_TOKENS`
  truncation. The runs predate `finishReason` capture, so the conclusion rests
  on the token arithmetic and the perfect separation between the valid and
  invalid cohorts. It is a strong inference, not a proof.
- **NOT TESTED** — whether prompt instruction can reduce Gemini's dynamic
  reasoning allowance at all. This is the open question Candidate A exists to
  answer, and it requires a provider run.

The benchmark repair at `3b9a4e8` records `finishReason` and derives
`invalidOutputCause`, so the first Phase 6 provider run promotes the inferred
item to **PROVEN** or refutes it. Until then this analysis must not be cited as
proof of the mechanism.

## Recommendation outside the Phase 6 candidate boundary

The highest-value repair for this failure class is **not** a prompt change and
is therefore **not authorized as a Phase 6 candidate**: raise `maxOutputTokens`
above 2,048, or set an explicit `thinkingConfig` budget that reserves room for
the response, or both.

The response itself needs only 130–186 tokens on the cases that succeed. The
entire 18.2% control failure rate is the model spending an unbounded reasoning
allowance and leaving too little to answer with. A bounded reasoning budget
would address the dominant failure directly, where prompt wording can only work
around it.

This is a change to the certified generation configuration in
`supabase/functions/scan-identify/index.ts` — production backend code, out of
Phase 6 scope. It is recorded here and in the Build 6 integration package as a
**product finding for owner decision**, not implemented, not deployed, and not
included in any candidate.
