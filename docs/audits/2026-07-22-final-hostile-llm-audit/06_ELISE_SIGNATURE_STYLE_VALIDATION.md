# Elise and Signature Style validation

## Deployment

`stylechat-generate` version 72 is active with `verify_jwt=true` and bundle SHA-256 `e1e34d8…`. It maps to committed and pushed source in canonical history.

## Routing

- Primary: `gemini-3.6-flash`
- Operational fallback: `gemini-3.5-flash-lite`
- Generic `GEMINI_MODEL`: ignored
- Retired models: rejected by explicit model constants/guards

## Authenticated runtime

Final emulator request:

| Request ID | Primary | Served | Fallback | Attempts | Provider | Valid | Quota | Signature Style |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| `d5554274-de66-4bf0-8732-9cadb3162883` | `gemini-3.6-flash` | `gemini-3.6-flash` | false | 1 | ok | true | consumed | false |

The emulator rendered one Elise reply and left the composer usable. An earlier production request also proved operational fallback to Flash-Lite when the primary response was incomplete.

## Signature Style

Source and regression tests prove:

- server-side loading from authenticated owner-scoped data;
- no client-asserted user ownership;
- deterministic bounds and truncation;
- explicit current instructions take precedence;
- the same verified context is used for primary and fallback prompts;
- no independent Signature Style provider call;
- separation from StyleDNA;
- safe behavior when no Signature Style exists.

The final QA-account request recorded `signature_style_included=false`, consistent with the visible “Signature Style is learning” state. Therefore runtime inclusion for a populated profile was not demonstrated in this account, although ownership/bounds and prompt behavior are covered by tests.

## Fallback and quota

Controlled primary and total-failure injections proved one answer maximum, bounded attempts, fallback success remaining consumed, and total provider failure refunding once. ElevenLabs speech failures are separate and do not refund chat quota.
