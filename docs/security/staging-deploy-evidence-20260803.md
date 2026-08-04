# Staging controlled deploy evidence (2026-08-03)

## Target
- Project ref: yzqjvdfgefveprobvvyw
- Production ref rejected by preflight (dry-run): wyyuqfdxucjksghsmhry

## Migration
- Applied: 20260804090000_edge_function_errors.sql (internal.edge_function_errors)
- MCP initially recorded timestamp 20260804011505; aligned to filename version 20260804090000
- Local/remote after align: 42/42

## Function
- Deployed: staging-health (shared-room-image-url absent on branch)
- Version: 1
- Status: ACTIVE
- verify_jwt: false
- Method: Supabase MCP deploy_edge_function

## Health probe
- HTTP 200
- Body status: healthy
- checks: runtime=ok, database=ok, migrations=ok, core_tables=ok
- Secret scan: clean (no JWT/service_role/connection strings)

## Dry-run gates
- Missing required staging variables → fail before deploy
- Production project ref → refuse
- DEPLOY_FUNCTIONS=all → reject (unit tests)
- npm run test:staging-deploy → 18/18 pass

## Safety
- Production modified: No
- Blanket db push: No
- EAS build: No