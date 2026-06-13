# AGENTS.md — K Scan AI App

## Project Overview
K Scan AI is a visual commerce application focused on fashion discovery and shopping.
Core positioning: "See it. Say it. Get it. Shop in seconds."

This repository is the K Scan mobile app codebase.

## Technical Stack
- React Native with Expo
- TypeScript
- Supabase backend/auth/storage
- Fashion recognition and commerce workflow centered around the Style-Parse engine

## Coding Expectations
- Make precise, minimal, high-confidence changes.
- Do not make broad rewrites unless explicitly requested.
- Preserve existing app structure and design language.
- Do not fabricate features, metrics, retailer integrations, or backend capabilities.
- Explain root cause before making significant fixes.
- When practical, run relevant validation or test commands after changes.
- Clearly report:
  1. What was changed
  2. Which files were changed
  3. What was tested
  4. What still needs manual verification

## K Scan Design Direction
- Maintain a premium luxury fashion-tech feel.
- Preferred aesthetic: Obsidian, Chrome, Deep-Space Purple, and Cyan accents.
- Avoid generic startup UI where possible.
- Preserve mobile readability, spacing, and polish.

## Backend and Infrastructure Caution
- Do not alter Supabase auth, storage policies, database assumptions, environment-variable handling, or production integration logic without explicitly flagging it.
- Do not hardcode secrets or API keys.
- Treat environment variable names and deployment settings as sensitive.

## App Review Priorities
When asked to audit or improve the app, prioritize:
- Scan flow reliability
- Permission handling
- Loading/error states
- Supabase upload and storage logic
- Product match response handling
- Graceful handling of no-match and non-fashion cases
- Mobile UI polish
- Testability and maintainability

## Preferred Codex Working Style
For any non-trivial task:
1. Inspect the relevant files first.
2. State the likely root cause or implementation plan.
3. Make the change.
4. Run a validation step when feasible.
5. Summarize the result clearly.