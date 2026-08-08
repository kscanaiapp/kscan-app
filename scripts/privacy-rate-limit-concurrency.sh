#!/bin/bash
set -euo pipefail
USER_A='00000000-0000-0000-0000-000000000471'
LIMIT=5
WORKERS=12

psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
  "delete from public.privacy_request_rate_limits where user_id='${USER_A}' and action='account_deletion';"

rm -f /tmp/rl_*.out
for i in $(seq 1 "$WORKERS"); do
  psql -U postgres -d postgres -tA -c \
    "select allowed::text || chr(124) || request_count::text from public.reserve_privacy_request_rate_limit('${USER_A}'::uuid,'account_deletion',${LIMIT},60);" \
    > "/tmp/rl_${i}.out" &
done
wait

echo "--- results ---"
cat /tmp/rl_*.out
echo "--- table ---"
psql -U postgres -d postgres -c \
  "select action, window_start, request_count from public.privacy_request_rate_limits where user_id='${USER_A}' and action='account_deletion';"

allowed=$(grep -h '^true|' /tmp/rl_*.out | wc -l | tr -d ' ')
max_count=$(psql -U postgres -d postgres -tA -c \
  "select coalesce(max(request_count),0) from public.privacy_request_rate_limits where user_id='${USER_A}' and action='account_deletion';")

echo "allowed=${allowed} max_count=${max_count} workers=${WORKERS} limit=${LIMIT}"
if [ "$allowed" -eq "$LIMIT" ] && [ "$max_count" -eq "$WORKERS" ]; then
  echo CONCURRENCY_PASS
  exit 0
fi
echo CONCURRENCY_FAIL
exit 1
