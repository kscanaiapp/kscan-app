#!/usr/bin/env node
/**
 * TS-02 — hostile concurrency harness for the account-deletion purge worker.
 *
 * Closes a COVERAGE GAP. The lease/claim protocol was believed correct but had
 * never been raced. This harness runs REAL CONCURRENT SESSIONS against a
 * disposable local database: each simulated worker is its own psql connection,
 * so `for update skip locked`, lease expiry and the ownership predicates are
 * exercised by the scheduler rather than described in prose.
 *
 * DISPOSABLE AND LOCAL ONLY. It seeds fixtures, mutates them, and truncates its
 * own rows at the end. It refuses to run against anything but a local database.
 *
 *   node scripts/hostile-deletion-concurrency.js --container <db container>
 *
 * Exit code 0 = HOSTILE_TEST_PASS, 1 = CONFIRMED_DEFECT.
 */

const { execFile } = require('node:child_process');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const CONTAINER = arg('container', 'supabase_db_kscan-phase5-dbgate');
const DOCKER = arg(
  'docker',
  'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
);
const WORKERS = Number(arg('workers', 6));

if (!/^supabase_db_/.test(CONTAINER)) {
  console.error(`Refusing to run: ${CONTAINER} is not a local Supabase database container.`);
  process.exit(2);
}

/** Run one SQL statement in its own connection. Each call is a separate session. */
function psql(sql, { tuplesOnly = true } = {}) {
  return new Promise((resolve, reject) => {
    const flags = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
    if (tuplesOnly) flags.push('-tA');
    flags.push('-c', sql);
    execFile(DOCKER, flags, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}\n${stderr}`));
      resolve(String(stdout).trim());
    });
  });
}

const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const USER_A = '00000000-0000-0000-0000-000000000401';
const USER_B = '00000000-0000-0000-0000-000000000402';
const REQ_A = '00000000-0000-0000-0000-0000000004a1';
const REQ_B = '00000000-0000-0000-0000-0000000004b1';

/**
 * Rebuild the fixture from scratch.
 *
 * Two accounts, each with one deletion request already past its grace period so
 * the claim query considers them due. The worker flags are enabled and dry-run
 * is off, because both are hard gates inside claim_deletion_requests_for_purge.
 */
async function seed() {
  await psql(`
    delete from public.deletion_state_transitions
      where request_id in ('${REQ_A}','${REQ_B}');
    delete from public.deletion_requests where id in ('${REQ_A}','${REQ_B}');
    delete from public.profiles where id in ('${USER_A}','${USER_B}');
    delete from auth.users where id in ('${USER_A}','${USER_B}');

    insert into auth.users (id, email) values
      ('${USER_A}', 'ts02-a@example.invalid'),
      ('${USER_B}', 'ts02-b@example.invalid');

    insert into public.profiles (id, account_status)
      values ('${USER_A}', 'pending_deletion'), ('${USER_B}', 'pending_deletion')
      on conflict (id) do update set account_status = excluded.account_status;

    -- requested_at is set explicitly: it defaults to now(), and a grace period
    -- that ended before the request was made violates the schema's own ordering
    -- constraint.
    insert into public.deletion_requests
      (id, user_id, status, requested_at, deactivated_at, grace_period_ends_at, attempt_count)
    values
      ('${REQ_A}', '${USER_A}', 'deactivated', now() - interval '40 days', now() - interval '40 days', now() - interval '10 days', 0),
      ('${REQ_B}', '${USER_B}', 'deactivated', now() - interval '40 days', now() - interval '40 days', now() - interval '10 days', 0);

    insert into public.app_config (key, value)
      values ('account_deletion_worker_enabled', '{"enabled": true}'::jsonb)
      on conflict (key) do update set value = '{"enabled": true}'::jsonb;
    insert into public.app_config (key, value)
      values ('account_deletion_worker_dry_run', '{"enabled": false}'::jsonb)
      on conflict (key) do update set value = '{"enabled": false}'::jsonb;
  `, { tuplesOnly: false });
}

async function requestRow(id) {
  const row = await psql(`
    select status || '|' || coalesce(worker_id,'-') || '|' ||
           coalesce(attempt_count::text,'-') || '|' ||
           case when worker_lease_expires_at is null then '-'
                when worker_lease_expires_at > now() then 'live' else 'expired' end || '|' ||
           case when purged_at is null then '-' else 'purged' end
    from public.deletion_requests where id = '${id}';`);
  const [status, workerId, attempts, lease, purged] = row.split('|');
  return { status, workerId, attempts: Number(attempts), lease, purged };
}

async function main() {
  console.log(`TS-02 hostile deletion concurrency — container ${CONTAINER}, ${WORKERS} concurrent workers\n`);

  // ── 1. Simultaneous claims ────────────────────────────────────────────────
  console.log('1. Simultaneous claim attempts on the same due requests');
  await seed();

  const workerIds = Array.from({ length: WORKERS }, (_, i) => `ts02-worker-${String(i).padStart(4, '0')}`);
  const claimed = await Promise.all(
    workerIds.map((id) =>
      psql(`select string_agg(id::text, ',') from public.claim_deletion_requests_for_purge('${id}', 5, interval '5 minutes');`)
        .then((out) => ({ id, rows: out ? out.split(',').filter(Boolean) : [] }))
        .catch((error) => ({ id, rows: [], error: error.message })),
    ),
  );

  const allClaimed = claimed.flatMap((entry) => entry.rows);
  const distinct = new Set(allClaimed);
  check(
    'each due request is claimed at most once across all concurrent workers',
    allClaimed.length === distinct.size,
    `claimed ${allClaimed.length} rows, ${distinct.size} distinct`,
  );
  check(
    'both due requests were claimed by someone (the race did not starve them)',
    distinct.has(REQ_A) && distinct.has(REQ_B),
    [...distinct].join(','),
  );

  const ownerOf = new Map();
  for (const entry of claimed) for (const row of entry.rows) ownerOf.set(row, entry.id);

  const stateA = await requestRow(REQ_A);
  check('a claimed request moves to purging', stateA.status === 'purging', stateA.status);
  check('a claimed request records exactly one owning worker', stateA.workerId === ownerOf.get(REQ_A), `${stateA.workerId} vs ${ownerOf.get(REQ_A)}`);
  check('a claimed request holds a live lease', stateA.lease === 'live', stateA.lease);

  // ── 2. A second claim cannot steal a live lease ───────────────────────────
  console.log('\n2. A live lease cannot be stolen');
  const thief = 'ts02-thief-0001';
  const stolen = await psql(`select count(*)::int from public.claim_deletion_requests_for_purge('${thief}', 5, interval '5 minutes');`);
  check('a later worker claims nothing while the leases are live', Number(stolen) === 0, `claimed ${stolen}`);
  const afterTheft = await requestRow(REQ_A);
  check('the original worker still owns the request', afterTheft.workerId === stateA.workerId, afterTheft.workerId);

  // ── 3. A stale actor cannot complete or fail someone else's request ───────
  console.log('\n3. A stale worker cannot mutate a request it no longer owns');
  const staleWorker = 'ts02-stale-000001';
  const stalePurge = await psql(`select public.mark_deletion_request_purged('${REQ_A}', '${staleWorker}');`);
  check('a stale worker cannot mark another worker\'s request purged', stalePurge === 'f', stalePurge);
  const staleFail = await psql(`select public.schedule_deletion_retry_or_fail('${REQ_A}', '${staleWorker}', 'STALE', 'stale actor');`);
  check('a stale worker cannot fail another worker\'s request', staleFail === 'f', staleFail);
  const staleBeat = await psql(`select public.heartbeat_deletion_request_lease('${REQ_A}', '${staleWorker}', interval '5 minutes');`);
  check('a stale worker cannot extend another worker\'s lease', staleBeat === 'f', staleBeat);
  const afterStale = await requestRow(REQ_A);
  check('the request is unchanged after every stale attempt', afterStale.status === 'purging' && afterStale.purged === '-', `${afterStale.status}/${afterStale.purged}`);

  // ── 4. Expired lease is reclaimable, exactly once ─────────────────────────
  console.log('\n4. An expired lease is reclaimed by exactly one worker');
  await psql(`update public.deletion_requests set worker_lease_expires_at = now() - interval '1 minute' where id in ('${REQ_A}','${REQ_B}');`, { tuplesOnly: false });

  const reclaimers = Array.from({ length: WORKERS }, (_, i) => `ts02-reclaim-${String(i).padStart(4, '0')}`);
  const reclaimed = await Promise.all(
    reclaimers.map((id) =>
      psql(`select string_agg(id::text, ',') from public.claim_deletion_requests_for_purge('${id}', 5, interval '5 minutes');`)
        .then((out) => ({ id, rows: out ? out.split(',').filter(Boolean) : [] }))
        .catch(() => ({ id, rows: [] })),
    ),
  );
  const reclaimedRows = reclaimed.flatMap((entry) => entry.rows);
  check(
    'an expired lease is reclaimed by exactly one worker, never two',
    reclaimedRows.length === new Set(reclaimedRows).size,
    `reclaimed ${reclaimedRows.length}, distinct ${new Set(reclaimedRows).size}`,
  );
  const reclaimedA = await requestRow(REQ_A);
  const newOwnerA = reclaimed.find((entry) => entry.rows.includes(REQ_A))?.id ?? null;
  check('the reclaimed request records its new owner', reclaimedA.workerId === newOwnerA, `${reclaimedA.workerId} vs ${newOwnerA}`);
  check('the previous owner no longer owns it', reclaimedA.workerId !== stateA.workerId, reclaimedA.workerId);

  // The crashed worker comes back and tries to finish work it lost.
  const crashedPurge = await psql(`select public.mark_deletion_request_purged('${REQ_A}', '${stateA.workerId}');`);
  check('a recovered crashed worker cannot purge a request that was reclaimed', crashedPurge === 'f', crashedPurge);

  // ── 5. Retry accounting stays consistent under repeats ────────────────────
  console.log('\n5. Retry and failure transitions stay consistent');
  const beforeRetry = await requestRow(REQ_B);
  const ownerB = beforeRetry.workerId;
  const retried = await psql(`select public.schedule_deletion_retry_or_fail('${REQ_B}', '${ownerB}', 'TRANSIENT', 'simulated transient failure');`);
  check('the owning worker can schedule a retry', retried === 't', retried);
  const afterRetry = await requestRow(REQ_B);
  check('a retry returns the request to deactivated and releases the lease', afterRetry.status === 'deactivated' && afterRetry.workerId === '-', `${afterRetry.status}/${afterRetry.workerId}`);

  // A repeat of the same call must not double-count or re-transition.
  const retriedAgain = await psql(`select public.schedule_deletion_retry_or_fail('${REQ_B}', '${ownerB}', 'TRANSIENT', 'repeat');`);
  check('a repeated retry on a released request does nothing', retriedAgain === 'f', retriedAgain);
  const afterRepeat = await requestRow(REQ_B);
  check('the attempt counter did not move on the no-op repeat', afterRepeat.attempts === afterRetry.attempts, `${afterRepeat.attempts} vs ${afterRetry.attempts}`);

  // Exhausting attempts fails the request rather than retrying forever.
  await psql(`update public.deletion_requests set status='purging', worker_id='${ownerB}', worker_lease_expires_at = now() + interval '5 minutes', attempt_count = 99, next_attempt_at = null where id = '${REQ_B}';`, { tuplesOnly: false });
  const failed = await psql(`select public.schedule_deletion_retry_or_fail('${REQ_B}', '${ownerB}', 'EXHAUSTED', 'no more attempts', 8);`);
  check('an exhausted request transitions to failed', failed === 't', failed);
  const afterFail = await requestRow(REQ_B);
  check('a failed request holds no worker and no lease', afterFail.status === 'failed' && afterFail.workerId === '-' && afterFail.lease === '-', `${afterFail.status}/${afterFail.workerId}/${afterFail.lease}`);

  // ── 6. Successful purge, and duplicate completion ─────────────────────────
  console.log('\n6. Purge completion is idempotent and terminal');
  const purgeOwner = reclaimedA.workerId;
  const purges = await Promise.all([
    psql(`select public.mark_deletion_request_purged('${REQ_A}', '${purgeOwner}');`),
    psql(`select public.mark_deletion_request_purged('${REQ_A}', '${purgeOwner}');`),
    psql(`select public.mark_deletion_request_purged('${REQ_A}', '${purgeOwner}');`),
  ]);
  check('exactly one of three concurrent completions succeeds', purges.filter((r) => r === 't').length === 1, purges.join(','));

  const purgedA = await requestRow(REQ_A);
  check('the request is purged and holds no worker or lease', purgedA.status === 'purged' && purgedA.workerId === '-' && purgedA.lease === '-', `${purgedA.status}/${purgedA.workerId}/${purgedA.lease}`);

  const transitions = await psql(`select count(*)::int from public.deletion_state_transitions where request_id = '${REQ_A}' and to_state = 'purged';`);
  check('exactly one purged transition was recorded — no duplicate ledger entry', Number(transitions) === 1, transitions);

  const claimedAfterPurge = await psql(`select count(*)::int from public.claim_deletion_requests_for_purge('ts02-after-purge-1', 5, interval '5 minutes');`);
  check('a purged request is never re-claimed', Number(claimedAfterPurge) === 0, claimedAfterPurge);

  // ── 7. No cross-user contamination ────────────────────────────────────────
  console.log('\n7. No cross-user mutation');
  const contamination = await psql(`
    select count(*)::int from public.deletion_requests
    where id = '${REQ_B}' and (purged_at is not null or user_id <> '${USER_B}');`);
  check("user B's request was never purged or reassigned by user A's workflow", Number(contamination) === 0, contamination);

  const strayTransitions = await psql(`
    select count(*)::int from public.deletion_state_transitions t
    join public.deletion_requests r on r.id = t.request_id
    where t.request_id = '${REQ_B}' and t.to_state = 'purged';`);
  check("no purged transition was written against user B's request", Number(strayTransitions) === 0, strayTransitions);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await psql(`
    delete from public.deletion_state_transitions where request_id in ('${REQ_A}','${REQ_B}');
    delete from public.deletion_requests where id in ('${REQ_A}','${REQ_B}');
    delete from public.profiles where id in ('${USER_A}','${USER_B}');
    delete from auth.users where id in ('${USER_A}','${USER_B}');
    update public.app_config set value = '{"enabled": false}'::jsonb
      where key = 'account_deletion_worker_enabled';
  `, { tuplesOnly: false });

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log(`\nRESULT: CONFIRMED_DEFECT\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nRESULT: HOSTILE_TEST_PASS');
}

main().catch((error) => {
  console.error('\nHarness error:', error.message);
  process.exit(2);
});
