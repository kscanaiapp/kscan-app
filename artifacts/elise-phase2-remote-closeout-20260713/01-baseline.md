# Stage 1 — Baseline

- Branch: `feature/elise-home-layer`
- Starting HEAD: `729c166367bc45ebab4b800b0502902c727de9ed`
- Expected HEAD matches: `YES`
- Tracked status entries: `0`
- Preserved pre-existing untracked entries: `857`
- Supabase CLI: `2.109.1`
- Linked project: `wyyu...mhry`
- `APP_PROJECT_MATCHES_CLI_PROJECT: YES`
- `REMOTE_HISTORY_ALIGNED_THROUGH_20260709130346: YES`
- Remote ledger entries: `43`
- Remote ledger maximum version: `20260709130346`
- Later authorized versions already applied: `0`
- `public.user_stylist_preferences`: absent

The current Supabase change notices were reviewed. The relevant current Data
API behavior requires explicit table grants in addition to RLS; the stylist and
prerequisite migrations already use explicit grants.
