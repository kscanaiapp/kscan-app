#!/usr/bin/env bash
# Runs scripts/f03/verify-watchlist-schema.sql against <dbname> and fails the
# run if any assertion reports FAIL.
set -uo pipefail
PGROOT="${F03_PGROOT:-/var/lib/postgresql/f03}"
PGBIN="${F03_PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${F03_PGPORT:-5433}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${1:?usage: verify.sh <dbname>}"
out="$(su postgres -c "$PGBIN/psql -h $PGROOT -p $PGPORT -U supabase_admin -d '$DB' -X -q -f '$REPO_ROOT/scripts/f03/verify-watchlist-schema.sql'" 2>&1)"
echo "$out"
fails="$(echo "$out" | grep -c '| FAIL |')"
total="$(echo "$out" | grep -cE '\| (PASS|FAIL) \|')"
echo "---"
echo "SCHEMA_CHECKS_TOTAL=$total"
echo "SCHEMA_CHECKS_FAILED=$fails"
if [[ "$total" -eq 0 ]]; then
  # Zero assertions is never a pass: it means psql could not run the battery
  # (missing database, connection failure, syntax error) and the run proved
  # nothing at all.
  echo "SCHEMA_VERIFY=FAIL (no assertions executed)"; exit 1
fi
if [[ "$fails" -ne 0 ]]; then echo "SCHEMA_VERIFY=FAIL"; exit 1; fi
echo "SCHEMA_VERIFY=PASS"
