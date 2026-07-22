# Rollback plan

Rollback must preserve authentication, approved models, and forward-only database history. Never restore the public legacy Render analysis implementation.

## Supabase functions

If Scanner v131 or StyleChat v72 must be replaced:

1. Select the last committed/pushed known-good function tree that still uses the approved explicit models and `verify_jwt=true`.
2. Re-run the relevant unit/contract suite.
3. Deploy only the affected function.
4. Confirm function version, JWT setting, bundle hash, authenticated response, routing event, quota state, and absence of content logging.
5. Record the new forward deployment. Do not deploy from a dirty workspace.

Do not roll back to Scanner v126 or StyleChat v66 merely because they are older; those versions predate repaired attribution/quota evidence.

## Database

Applied migrations are immutable. Rollback means a new forward migration that restores a safe equivalent contract. Do not delete migration rows, edit applied SQL, broaden grants, remove serialization, or make the ledger mutable.

## Mobile gallery/privacy preparation

If the metadata re-encode path causes a release regression, create a new revert/fix commit from canonical source and validate Scanner plus Elise photo intake. A temporary client feature gate may disable only the affected upload control if explicitly approved; do not reintroduce a hidden global blocker while claiming the feature is available.

## Render

Preferred action is retirement. If the tombstone deployment fails, redeploy the committed 410-only handler. Never restore OpenRouter, retired Gemini models, anonymous compatibility behavior, request-body logging, or provider secrets.

## Vercel Meta demo

Rollback only to another safe-mock-default deployment. Do not restore the Render hostname or enable public live mode.
