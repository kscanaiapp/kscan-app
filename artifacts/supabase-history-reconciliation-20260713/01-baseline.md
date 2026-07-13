# Immutable baseline

Captured before any remote mutation.

- Branch: `feature/elise-home-layer`
- Starting HEAD: `0d0bcafa911ec732b50fec3c376dc3d7a9904827`
- Starting short HEAD: `0d0bcaf`
- Tracked worktree changes at start: `0`
- Pre-existing untracked entries at start: `857`
- Supabase CLI: `2.109.1`
- Linked project: `wyyu...mhry`
- `.env`, `.env.production`, and `eas.json` all resolve to the linked project.
- `APP_PROJECT_MATCHES_CLI_PROJECT: YES`
- One Android target was online. The installed debug build had cached endpoint
  evidence for `10.0.2.2:54321`; it was not treated as a remote-target build.

## Initial migration history

- Remote-only: `20260709130346` (`android_backend_runtime_fixes`)
- Unrelated local pending:
  - `20260711000001`
  - `20260711000002`
  - `20260711000003`
  - `20260711195508`
  - `20260712000001`
  - `20260712010000`
  - `20260712020000`
  - `20260714000002`
- Authorized stylist pending:
  - `20260713000001`
  - `20260714000001`
  - `20260714000003`
  - `20260715000001`

## Remote catalog fingerprint

This fingerprint covers catalog metadata only; no application row data was
queried.

| Catalog | Count | MD5 |
|---|---:|---|
| Public columns | 392 | `2c16cf69bec15e2e74e5420e09e94c52` |
| Public constraints | 136 | `f1ed47e585661d6a99d14dfb47107f81` |
| Public policies | 89 | `ffb4b507b801603f44440c2494a05fbf` |
| Public triggers | 23 | `21634ef69e664c1955dfd2c99626e5af` |
| App-role table grants | 352 | `40af23f4dec294d5047898bf3f5aef98` |
| Public functions | 22 | `0cfb650f10bb343a3a1ecde969becc38` |
| Remote migration ledger | 43 | `024736201b89abbb92f5e62a1b8b89cc` |

The remote `public.user_stylist_preferences` table was absent at baseline.
Consequently there were no table constraints, RLS policies, grants, triggers,
or foreign keys for that table.
