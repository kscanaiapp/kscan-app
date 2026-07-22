# Final hostile LLM audit verdict

Audit date: 2026-07-22

Supabase production project: `wyyuqfdxucjksghsmhry`

Canonical application branch: `feature/ai-model-input-security`
Canonical remote SHA at close: `ffd25753a08e1e7077f3672446106c776b8c1fb2`

## Grade

**FAIL**

The active Supabase LLM routes are repaired, reproducible, authenticated, safely attributed, and using the approved Gemini models. Fresh authenticated Android emulator requests proved uploaded Scanner and Elise execution, and an earlier authenticated emulator run proved TextScan. Quota, fallback, refund, and append-only telemetry repairs are live.

The audit cannot issue PASS because the legacy Render service has only been defensively tombstoned. Its administrative shutdown, provider-secret removal, exact live deployment identity, and post-containment paid-provider log evidence cannot be verified while the Render dashboard is signed out. The full required hardware and navigation matrix also remains incomplete: live camera hardware, glasses hardware, account switching/logout isolation, Scanner save/Recent Scans/Ask Elise, and Dressing Room navigation were not all executed end to end.

## Production model map

| Surface | Primary | Fallback | Runtime result |
| --- | --- | --- | --- |
| Scanner image | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | Authenticated emulator PASS |
| TextScan | `gemini-3.5-flash-lite` | same-model retry where eligible | Authenticated PASS |
| Elise / StyleChat | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | Authenticated emulator PASS |
| Signature Style | No independent call | Included in Elise prompt when present | Source/tests PASS; QA request reported absent |
| Dressing Room generation | Dormant source only | Not deployed | Not an active release route |
| Meta / Google XR | Canonical Scanner or TextScan backend | Backend policy | Contract/source only; no hardware run |
| Legacy Render analysis | None | None | Public route returns `410 Gone` |

## Open closure items

- P1: retire or suspend the Render `kscan-api` service, remove its exclusive provider credentials, and retain dashboard/log evidence.
- Audit blocker: complete the remaining required emulator and device/hardware journey matrix.

There is no “PASS with findings” grade, so these evidence gaps require FAIL even though the confirmed production Supabase defects were repaired.
