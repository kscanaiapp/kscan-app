# Release: Production Supabase Project Naming (BLOCKER-2)

_Last updated: 2026-07-07 (integration/free-tier-beta-into-style-dna)_

## Current state

The shipping app points at Supabase project ref `wyyuqfdxucjksghsmhry`, which is
currently **named "KScan App Staging"** in the Supabase Dashboard. The name is a
label only — this project is the production backend (all `eas.json` build
profiles, including `production`, target it). A second project,
"K Scan Privacy Controls" (`yzqjvdfgefveprobvvyw`), holds the website waitlist
and website privacy tables and is unaffected.

## Required action (Dashboard-only, no code changes)

1. Open the Supabase Dashboard for project `wyyuqfdxucjksghsmhry`.
2. Go to **Project Settings → General → Project Name**.
3. Change the name:
   - From: `KScan App Staging`
   - To: `K Scan AI Production`
4. Save.

## Why this is safe

- The project **ref** (`wyyuqfdxucjksghsmhry`) does not change.
- API URLs (`https://wyyuqfdxucjksghsmhry.supabase.co`), keys, Edge Functions,
  database contents, and RLS are all keyed to the ref, not the display name.
- No app, `eas.json`, env, or CI changes are needed.

## Status

- [ ] Renamed in Dashboard (owner action — cannot be done via API/CLI)
- [x] Documented; no tracked docs referenced the old display name.
