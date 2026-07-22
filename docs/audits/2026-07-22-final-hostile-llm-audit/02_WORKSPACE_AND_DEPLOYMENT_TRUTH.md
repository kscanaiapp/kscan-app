# Workspace and deployment truth

All dirty or ahead workspaces were treated as evidence only. None was reset, cleaned, stashed, overwritten, or used for deployment.

| Workspace | Branch / HEAD | State at audit | Authority classification |
| --- | --- | --- | --- |
| `C:\Users\jsmit\KScan` | `ios/full-submission-readiness-v2` / `0c9086af…` | 8 ahead; 162 tracked changes; 301 untracked | Evidence only; original Step 1 diff source |
| `C:\src\KScan-ai-model-input-security` | `feature/ai-model-input-security` / `65c436ba…` | 11 tracked changes; 17 untracked; local tracking ref stale | Evidence only; original Step 2B workspace |
| `C:\src\KScan-KC05-repair-20260710-144442` | `integration/ios-v16-qa` / `f73d4147…` | no tracked changes; 616 untracked | Evidence only; older QA/backend material |
| `C:\src\KScan-elise-avatar-audit-20260715` | `integration/elise-avatar-voice-merge-20260714` / `e3942614…` | clean | Evidence/reference baseline |
| `C:\Users\jsmit\kscan-glasses-webapp` | `feature/meta-connected-runtime-phase-a` / `c45bcbec…` | 15 ahead; 4 tracked changes | Evidence only; Meta source |
| `C:\Users\jsmit\kscan-google-glasses-canonical` | `feature/google-xr-phone-bridge-phase-a` / `105c2218…` | 9 tracked changes | Evidence only; Google XR source |
| `C:\Users\jsmit\kscan-website` | `main` / `680a57b…` | 32 untracked | Evidence only; website source |
| `C:\src\KScan-final-llm-hostile-integration-20260721` | audit integration branch | generated build output and local audit edits | Non-authoritative integration evidence |
| `C:\src\KScan-enable-private-image-upload-20260721` | clean audit/repair branches | tracked tree clean after commits | Authoritative repair and emulator build workspace |

## Remote truth

- Repository: `https://github.com/kscanaiapp/kscan-app.git`
- Canonical branch: `feature/ai-model-input-security`
- Audited application-code SHA after PR 26: `ffd25753a08e1e7077f3672446106c776b8c1fb2`
- Canonical remote after docs merges PR 27/28: `d3293286eb894fe737cc404091b9fbc6551afe4f`
- The local `origin/feature/ai-model-input-security` reference intermittently failed to refresh with `reference already exists`; `git ls-remote`, `FETCH_HEAD`, GitHub PR data, and tree equality were used as authoritative evidence. This is a local Git tooling issue, not a product defect.

## Supabase deployment truth

| Function | Version | JWT | Bundle SHA-256 | Alignment |
| --- | ---: | --- | --- | --- |
| `scan-identify` | 131 | `true` | `67c1d1d290b878b61204aa353698631d10e7b3f01fd3b5ae0e7d4d90438ab105` | SOURCE AND DEPLOYMENT ALIGNED |
| `stylechat-generate` | 72 | `true` | `e1e34d8025a5b1759dd07bc62a67b50e05a0033a697b103fad9e6369bef44d24` | SOURCE AND DEPLOYMENT ALIGNED |
| `style-outfit-generate` | not deployed | n/a | n/a | SOURCE ONLY, dormant/disabled |

Both live LLM functions map to committed and pushed source from the telemetry repair line (`72a6fab…`) retained in canonical history. Later canonical commits changed mobile integration and reports, not those deployed function bundles.

## Other deployments

- Render: `kscan-api`, host `kscan-app-1.onrender.com`, repository `kscanaiapp/kscan-app`, branch `master`; tombstone source merged at `d1bb36ec…` and still the tip of `origin/master`. Closure probes on 2026-07-22 confirmed live `/api/analyze` → `410` and `/api/health` → `200`. Exact Render dashboard deployment ID remains unverified because the dashboard is signed out; live route behavior and master tip alignment are sufficient to prove the retired analysis path cannot invoke providers.
- Vercel Meta demo: production deployment `dpl_5Y7H5…`; source commit `489bde…`; branch merge `32a63a…`. Live `kscan-glasses-demo.vercel.app` JS bundle contains no Render/OpenRouter hostname and live mode defaults off.
