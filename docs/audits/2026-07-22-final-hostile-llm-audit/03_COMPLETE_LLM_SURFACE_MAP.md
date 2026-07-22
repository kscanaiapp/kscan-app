# Complete LLM surface map

| Surface | Client route | Backend | Auth | Model policy | State / verification |
| --- | --- | --- | --- | --- | --- |
| Camera Scanner | Home → Scanner → camera | `scan-identify`, image mode | Supabase JWT | 3.6 Flash → Flash-Lite | Source/contract verified; emulator camera hardware unsuitable |
| Uploaded Scanner | Home → Scanner → upload | `scan-identify`, image mode | Supabase JWT | 3.6 Flash → Flash-Lite | Authenticated emulator PASS |
| Single-item analysis | Scanner result pipeline | `scan-identify` | Supabase JWT | 3.6 Flash → Flash-Lite | Live PASS |
| Multi-item detection | Scanner request contract | `scan-identify` | Supabase JWT | 3.6 Flash → Flash-Lite | Unit/contract verified; not separately live exercised |
| Selected-item analysis | Scanner selection contract | `scan-identify` | Supabase JWT | 3.6 Flash → Flash-Lite | Unit/contract verified; not separately live exercised |
| Multi-image analysis | Visual-context collection | canonical Scanner plus bounded context | Supabase JWT | 3.6 Flash where image reasoning occurs | Collection bounds/tests PASS; no hardware run |
| Visual Search | Scanner-derived visual route | `scan-identify` | Supabase JWT | 3.6 Flash → Flash-Lite | Canonical route; runtime covered by uploaded Scanner |
| TextScan | Scanner → Describe an item | `scan-identify`, `textscan` mode | Supabase JWT | 3.5 Flash-Lite; one eligible same-model retry | Authenticated runtime and emulator PASS |
| Recent Scans | Library view | no LLM until explicit Ask Elise | owner-scoped data | n/a | No autonomous provider call |
| Saved Closet | Closet view | no LLM until explicit Elise context | owner-scoped data | n/a | Context source only |
| Elise | Home → Chat with Elise | `stylechat-generate` | Supabase JWT | 3.6 Flash → Flash-Lite | Authenticated emulator PASS |
| StyleChat | Elise session | `stylechat-generate` | Supabase JWT + session ownership | 3.6 Flash → Flash-Lite | Live PASS |
| Signature Style | Elise server prompt assembly | no separate function/call | server-loaded owner data | same Elise call | Tests PASS; QA request had no included profile |
| StyleDNA | Explicit context path | same Elise call | owner-scoped | same Elise call | Kept distinct from Signature Style in tests/source |
| Dressing Room generation | gated client source | `style-outfit-generate` source | intended JWT | 3.6 Flash → Flash-Lite | Dormant; function not deployed |
| Dressing Room scan context | saved/selected item context | no independent call unless Elise/generation requested | owner-scoped | route-dependent | Source/contract only |
| Shared Dressing Room | shared context | deterministic share paths; no automatic LLM | share authorization | n/a | No active provider route found |
| Ask Elise from scan | result action → Elise | `stylechat-generate` | JWT + session | 3.6 Flash → Flash-Lite | Source seam tested; full navigation not completed |
| Ask Elise from saved item | Closet action → Elise | `stylechat-generate` | JWT + owner context | 3.6 Flash → Flash-Lite | Source seam tested; full navigation not completed |
| Meta glasses image | phone/bridge canonical request | `scan-identify` | authenticated bridge | 3.6 Flash → Flash-Lite | Contract/source only |
| Meta glasses text | phone/bridge TextScan request | `scan-identify` text mode | authenticated bridge | 3.5 Flash-Lite | Contract/source only |
| Google XR image | phone bridge | `scan-identify` | authenticated bridge | 3.6 Flash → Flash-Lite | Contract/source only |
| Google XR text/voice | phone bridge | TextScan/Elise as selected | authenticated bridge | Lite for TextScan; 3.6 for Elise | Contract/source only |
| Website | public website | no accepted active LLM endpoint | n/a | n/a | No accepted production AI caller found |
| Vercel Meta demo | public demo | safe mock by default | explicit private live gate | no live call by default | Repaired and deployed |
| Legacy Render `/api/analyze` | obsolete public route | tombstone | none | no provider | Repeated probes return 410 |

Inventory/pricing/links/auth/quota/RLS/navigation remain deterministic and authoritative; no LLM is used for those decisions.
