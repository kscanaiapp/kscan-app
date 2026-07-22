# Model and provider inventory

## Approved active provider

Google Gemini is the only active LLM provider in the accepted Supabase release path.

| Workload | Primary | Retry/fallback | Payload status |
| --- | --- | --- | --- |
| Scanner image reasoning | `gemini-3.6-flash` | `gemini-3.5-flash-lite` operational fallback | Live valid |
| TextScan | `gemini-3.5-flash-lite` | one same-model retry for eligible transient failure | Live valid |
| Elise / StyleChat | `gemini-3.6-flash` | `gemini-3.5-flash-lite` operational fallback | Live valid |
| Dormant outfit source | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | Source/tests only |

`GEMINI_MODEL` does not control these routes. Each workload uses its explicit allowlisted model constant. Retired Gemini 1.5, 2.0, and 2.5 identifiers cannot become active through environment override.

## Other providers

- ElevenLabs: separate `stylist-speech` provider; not an LLM routing fallback and does not affect chat quota refunds.
- OpenRouter: found only in the obsolete Render analysis implementation and removed from the active route. No accepted Supabase workload uses it.
- Render: not an approved LLM provider or canonical backend. The public analysis route is a non-processing 410 tombstone.
- Kimi/Moonshot: no approved active caller found.

## Legacy evidence

The retired Render source previously selected an OpenRouter `llama-4-scout` path and a Gemini 2.0 fallback. That behavior was a P1 because it was public, unauthenticated, paid, and outside the accepted architecture. The route is now registered as a tombstone before body parsing and provider code is not registered.

## Gemini request compatibility

The active function tests cover model identifiers, endpoint construction, structured response handling, bounded tokens, retry classification, and canonical response validation. No speculative thinking configuration was added. Controlled production probes returned valid canonical responses from both approved model tiers.
