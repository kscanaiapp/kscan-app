#!/usr/bin/env bash
#
# F-03 certification driver. Runs both database histories end to end and the
# negative controls, and prints the summary the lane report quotes.
#
#   History A -- fresh database: empty DB -> replay the whole current tree in
#                canonical order -> schema/security battery -> behaviour probes.
#   History B -- existing upgraded database: replay in the order the state was
#                ACTUALLY built (hardening after its dependency, under its true
#                staging ledger version), cut before the repair, seed real
#                Watchlist rows, apply ONLY the repair migration, then prove the
#                rows are byte-identical and the schema is correct.
#   Controls  -- remove the repair and prove the tests turn red.
#
# Local and disposable. No hosted Supabase project is contacted.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1
PGROOT="${F03_PGROOT:-/var/lib/postgresql/f03}"
PGBIN="${F03_PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${F03_PGPORT:-5433}"
REPAIR="20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation.sql"
SNAPDIR="$(mktemp -d)"; trap 'rm -rf "$SNAPDIR"' EXIT
rc=0
chmod -R a+rX supabase/migrations scripts/f03 2>/dev/null

pg() { su postgres -c "$PGBIN/psql -h $PGROOT -p $PGPORT -U supabase_admin -d $1 -X -q ${*:2}"; }
note() { printf '\n== %s ==\n' "$1"; }

note "HISTORY A -- fresh database replay"
out="$(./scripts/f03/replay.sh f03_certify_fresh --resolve-aliases 2>&1)"
echo "$out" | grep -E '^MIGRATIONS_APPLIED=|^ENGINE_SHIMMED=|^ALIAS_SKIPPED=|^FIRST_MIGRATION=|^LAST_MIGRATION=|^FAILED_MIGRATION=|^REPLAY='
echo "$out" | grep -q 'REPLAY=PASS' && echo "FRESH_REPLAY=PASS" || { echo "FRESH_REPLAY=FAIL"; rc=1; echo "$out" | grep -A4 '^FAIL '; }

note "HISTORY A -- schema and security battery"
./scripts/f03/verify.sh f03_certify_fresh 2>&1 | tail -3 || rc=1

note "HISTORY A -- behaviour probes"
pg f03_certify_fresh "-v ON_ERROR_STOP=1 -f $REPO_ROOT/scripts/f03/upgrade-fixture.sql" >/dev/null 2>&1
if pg f03_certify_fresh "-v ON_ERROR_STOP=1 -f $REPO_ROOT/scripts/f03/behaviour-test.sql" 2>&1 | grep -q 'BEHAVIOUR=PASS'; then
  echo "FRESH_BEHAVIOUR=PASS"; else echo "FRESH_BEHAVIOUR=FAIL"; rc=1; fi

note "HISTORY B -- reconstruct the existing upgraded database"
out="$(./scripts/f03/replay.sh f03_certify_upgrade --resolve-aliases --historical-order --until 20260909115726 2>&1)"
echo "$out" | grep -E '^MIGRATIONS_APPLIED=|^LAST_MIGRATION=|^REPLAY='
echo "$out" | grep -q 'HISTORICAL_ORDER' && echo "HISTORICAL_STATE_RECONSTRUCTED=YES" || { echo "HISTORICAL_STATE_RECONSTRUCTED=NO"; rc=1; }
echo "$out" | grep -q 'REPLAY=PASS' || { echo "HISTORICAL_REPLAY=FAIL"; rc=1; }

note "HISTORY B -- seed pre-upgrade Watchlist fixture"
pg f03_certify_upgrade "-v ON_ERROR_STOP=1 -f $REPO_ROOT/scripts/f03/upgrade-fixture.sql" 2>&1 | tail -2
pg f03_certify_upgrade "-f $REPO_ROOT/scripts/f03/snapshot.sql" > "$SNAPDIR/pre.txt"
grep '^COUNTS' "$SNAPDIR/pre.txt"

note "HISTORY B -- apply ONLY the repair migration"
out="$(./scripts/f03/replay.sh f03_certify_upgrade --keep --only "$REPAIR" 2>&1)"
echo "$out" | grep -E '^MIGRATIONS_APPLIED=|^REPLAY='
echo "$out" | grep -q 'REPLAY=PASS' && echo "EXISTING_UPGRADE=PASS" || { echo "EXISTING_UPGRADE=FAIL"; rc=1; }

note "HISTORY B -- data preservation"
pg f03_certify_upgrade "-f $REPO_ROOT/scripts/f03/snapshot.sql" > "$SNAPDIR/post.txt"
if diff -u "$SNAPDIR/pre.txt" "$SNAPDIR/post.txt"; then
  echo "WATCHLIST_ROWS_PRESERVED=YES"
  echo "PUSH_ROUTE_ROWS_PRESERVED=YES"
  echo "RECEIPT_ROWS_PRESERVED=YES"
else
  echo "DATA_PRESERVED=NO"; rc=1
fi

note "HISTORY B -- re-execution safety (apply the repair a second time)"
out="$(./scripts/f03/replay.sh f03_certify_upgrade --keep --only "$REPAIR" 2>&1)"
pg f03_certify_upgrade "-f $REPO_ROOT/scripts/f03/snapshot.sql" > "$SNAPDIR/post2.txt"
if echo "$out" | grep -q 'REPLAY=PASS' && diff -q "$SNAPDIR/pre.txt" "$SNAPDIR/post2.txt" >/dev/null; then
  echo "REPAIR_IDEMPOTENT=YES"; else echo "REPAIR_IDEMPOTENT=NO"; rc=1; fi

note "HISTORY B -- schema and security battery"
./scripts/f03/verify.sh f03_certify_upgrade 2>&1 | tail -3 || rc=1

note "HISTORY B -- behaviour probes"
if pg f03_certify_upgrade "-v ON_ERROR_STOP=1 -f $REPO_ROOT/scripts/f03/behaviour-test.sql" 2>&1 | grep -q 'BEHAVIOUR=PASS'; then
  echo "UPGRADE_BEHAVIOUR=PASS"; else echo "UPGRADE_BEHAVIOUR=FAIL"; rc=1; fi

note "NEGATIVE CONTROLS"
./scripts/f03/negative-control.sh 2>&1 | grep -E '^NC1=|^NC2=|^NEGATIVE_CONTROL=' || rc=1
./scripts/f03/negative-control.sh >/dev/null 2>&1 || rc=1

printf '\n== F03_CERTIFY=%s ==\n' "$([[ $rc -eq 0 ]] && echo PASS || echo FAIL)"
exit $rc
