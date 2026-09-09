#!/usr/bin/env bash
#
# F-03 negative controls (§21 item 30): break the repair, and prove the
# certification turns RED. A green test suite that stays green when the fix is
# removed proves nothing.
#
# NC-1  Revert BOTH repair parts (original unguarded 20260830190000, no
#       reconciliation migration) -> the fresh replay must ABORT at
#       20260830190000 with the missing-type error. This is the loud failure.
#
# NC-2  Keep the guard, remove ONLY the reconciliation migration -> the fresh
#       replay must SUCCEED while the schema battery FAILS on the DEF-WL-01
#       assertions. This is the silent failure, and it is the one that matters:
#       it proves the verifier detects a fresh database that replays cleanly
#       but is missing the actor-isolation hardening.
#
# Nothing here is committed: both controls run against a git stash of the
# repair and restore the working tree on exit.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

GUARDED="supabase/migrations/20260830190000_watchlist_push_token_actor_isolation.sql"
REPAIR="supabase/migrations/20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation.sql"
SCRATCH="$(mktemp -d)"
BASE_REF="${F03_BASE_REF:-origin/release/kscan-pre-freeze-v1}"

# Both repair parts may be uncommitted working-tree state, so they are saved
# and restored by copy. `git checkout --` would restore the INDEX copy, which
# is the pre-repair file -- i.e. it would silently discard the guard.
cleanup() {
  [[ -f "$SCRATCH/guarded.sql" ]] && cp "$SCRATCH/guarded.sql" "$GUARDED"
  [[ -f "$SCRATCH/repair.sql" ]]  && cp "$SCRATCH/repair.sql"  "$REPAIR"
  chmod -R a+rX supabase/migrations
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

cp "$GUARDED" "$SCRATCH/guarded.sql"
cp "$REPAIR"  "$SCRATCH/repair.sql"
rc=0

echo "=============================================================="
echo "NC-1  both repair parts reverted -- fresh replay must ABORT"
echo "=============================================================="
git show "$BASE_REF:$GUARDED" > "$GUARDED" || exit 1
rm -f "$REPAIR"
chmod -R a+rX supabase/migrations
out="$(./scripts/f03/replay.sh f03_nc1 --resolve-aliases 2>&1)"
echo "$out" | grep -vE '^ENGINE_SHIM |^ALIAS_SKIP ' | tail -8
if echo "$out" | grep -q 'REPLAY=FAIL' \
   && echo "$out" | grep -q 'type "public.user_device_push_tokens" does not exist' \
   && echo "$out" | grep -q 'FAILED_MIGRATION=20260830190000_watchlist_push_token_actor_isolation.sql'; then
  echo "NC1=RED_AS_EXPECTED (replay aborts on the original defect)"
else
  echo "NC1=CONTROL_BROKEN (the defect was not detected)"; rc=1
fi

echo
echo "=============================================================="
echo "NC-2  guard kept, reconciliation removed -- replay must PASS"
echo "      while the schema battery must FAIL"
echo "=============================================================="
cp "$SCRATCH/guarded.sql" "$GUARDED"
chmod -R a+rX supabase/migrations
out="$(./scripts/f03/replay.sh f03_nc2 --resolve-aliases 2>&1)"
echo "$out" | grep -E '^REPLAY=|^FAILED_MIGRATION='
verify_out="$(./scripts/f03/verify.sh f03_nc2 2>&1)"
echo "$verify_out" | grep '| FAIL |'
echo "$verify_out" | tail -3
if echo "$out" | grep -q 'REPLAY=PASS' \
   && echo "$verify_out" | grep -q 'DEFWL01_REGISTER_RPC_HARDENED | FAIL' \
   && echo "$verify_out" | grep -q 'INDEX_USER_DEVICE_PUSH_TOKENS_LIVE_TOKEN_UIDX | FAIL'; then
  echo "NC2=RED_AS_EXPECTED (clean replay, hardening silently absent, verifier catches it)"
else
  echo "NC2=CONTROL_BROKEN (a fresh database missing DEF-WL-01 was reported healthy)"; rc=1
fi

echo
echo "NEGATIVE_CONTROL=$([[ $rc -eq 0 ]] && echo PASS || echo FAIL)"
exit $rc
