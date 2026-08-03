# Perimeter Control Map — Phase 3

- **Date**: 2026-08-03

## Scope correction

This phase's brief assumes a Vercel-hosted website in front of some surfaces. Direct repository evidence (two independent research passes: file-existence checks for `vercel.json`/`next.config.js`/`.vercelignore`, and a full case-insensitive grep for "vercel" across the tree) confirms **no Vercel project, config, or deployment exists anywhere in this repository**. The only non-Supabase hosting is **Render.com** (`kscan-app-1.onrender.com`, `server.js`, configured via `render.yaml`/`Procfile`). The public marketing/legal/waitlist website (`kscan.app`/`www.kscan.app`) is a real, separate, internet-reachable surface the mobile app calls directly, but its source and hosting are **not part of this repository** — it cannot be mapped from here, only flagged.

This map documents actual origins and bypass paths as they exist, not a Vercel topology that doesn't exist.

## Control Map

| Surface | Public origin | Primary perimeter | Bypass path | Existing control | Required control |
|---|---|---|---|---|---|
| Supabase Edge Functions (8 deployed) | `yzqjvdfgefveprobvvyw.supabase.co/functions/v1/*` | Supabase platform edge (no CDN/WAF in front) | None — this *is* the direct origin | verify_jwt, in-function auth, quota/concurrency (6 of 8), RLS on underlying tables | Rate limiting for the 3 hand-rolled functions (handle-user-deletion, privacy-correction-request, privacy-data-export); source recovery for the 2 unauditable functions |
| Supabase PostgREST (tables/RPCs) | `yzqjvdfgefveprobvvyw.supabase.co/rest/v1/*` | Supabase platform edge | None — direct origin | RLS policies (verified enabled on all 26 public tables), function-level auth.uid() checks | Fix applied this pass for `get_item_reaction_counts`; no other RPC gaps found |
| Supabase Auth | `yzqjvdfgefveprobvvyw.supabase.co/auth/v1/*` | Supabase platform edge | None — direct origin | Supabase-managed rate limiting/abuse controls (not configurable from this repo) | Confirm dashboard-level rate-limit/CAPTCHA settings (outside this repo's evidence reach) |
| Supabase Storage | `yzqjvdfgefveprobvvyw.supabase.co/storage/v1/*` | Supabase platform edge | None — direct origin | Bucket `public=false` + owner-scoped RLS (style-library-images), zero-policy lockout (investor-docs) | None — correctly configured |
| Render Express app (`server.js`) | `kscan-app-1.onrender.com/*` | **None** — Render has no managed WAF/firewall equivalent to Vercel's, and none is configured for this service | N/A — this is already the direct origin, there is no perimeter in front of it | 15MB body cap on `/api/analyze`; nothing else | **Rate limiting on `/api/analyze`** (this pass's highest-priority fix); consider requiring a lightweight app-attestation or API key if the endpoint must stay reachable from the internet at large |
| `kscan.app` / `www.kscan.app` (external website) | `kscan.app/*` | **Unknown** — not part of this repository | Unknown | Unknown | Out of scope for this repo; flag to the website's own owning team for an equivalent perimeter review |
| Dormant Expo Router `+api` routes | Not currently deployed anywhere | N/A (no deployment target configured) | N/A | None (dormant) | Do not deploy without the same controls as `server.js /api/analyze`; consider deleting dead code |

## Vercel-specific instructions (not applicable)

The brief's Phase 3 asks for: current firewall configuration inspection, managed-rule candidates, custom WAF rule candidates, rate-limit candidates, bot/automation pattern detection, and staging-safe log-only rules — all **Vercel Firewall features**. None of this applies because no Vercel project exists. If a Vercel-hosted website is introduced later (e.g., if `kscan.app` is ever migrated to Vercel, or if this repo's dormant Expo web routes are ever deployed there), this section should be revisited with real Vercel project access.

## Direct-origin discipline

Per the brief: **no website WAF claim is made to cover any Supabase or Render origin.** Every Supabase and Render surface in the control map above is documented as directly internet-reachable with no intermediate perimeter layer — its actual security posture rests entirely on the function/RLS/auth-layer controls listed in the "Existing control" column, not on any external firewall.
