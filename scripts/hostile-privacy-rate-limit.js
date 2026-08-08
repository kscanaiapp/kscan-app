#!/usr/bin/env node
/**
 * Issue #47 — hostile concurrency + privilege harness for privacy request rate limits.
 *
 * Disposable LOCAL Docker only. Refuses non-local containers.
 *
 *   node scripts/hostile-privacy-rate-limit.js --container <db container>
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
const WORKERS = Number(arg('workers', 12));
const LIMIT = Number(arg('limit', 5));

if (!/^supabase_db_/.test(CONTAINER)) {
  console.error(`Refusing to run: ${CONTAINER} is not a local Supabase database container.`);
  process.exit(2);
}

function psql(sql, { tuplesOnly = true } = {}) {
  return new Promise((resolve, reject) => {
    const flags = [
      'exec',
      '-i',
      CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ];
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

const USER_A = '00000000-0000-0000-0000-000000000471';
const USER_B = '00000000-0000-0000-0000-000000000472';

async function reserve(userId, action, limit = LIMIT) {
  const out = await psql(`
    select allowed::text || '|' || request_count::text || '|' || remaining::text
    from public.reserve_privacy_request_rate_limit(
      '${userId}'::uuid,
      '${action}',
      ${limit},
      60
    );
  `);
  const [allowed, count, remaining] = out.split('|');
  return { allowed: allowed === 't' || allowed === 'true', count: Number(count), remaining: Number(remaining) };
}

async function main() {
  console.log(`Issue #47 privacy rate-limit hostile harness on ${CONTAINER}`);

  await psql(`
    delete from public.privacy_request_rate_limits
      where user_id in ('${USER_A}','${USER_B}');
  `);

  // 1-4: sequential allow until threshold, then deny
  const sequential = [];
  for (let i = 0; i < LIMIT + 2; i += 1) {
    sequential.push(await reserve(USER_A, 'privacy_export'));
  }
  check('first request allowed', sequential[0].allowed === true);
  check('requests below threshold allowed', sequential.slice(0, LIMIT).every((r) => r.allowed));
  check('request above threshold denied', sequential[LIMIT].allowed === false);
  check('further over-limit denied', sequential[LIMIT + 1].allowed === false);

  // 5: cross-user isolation
  const other = await reserve(USER_B, 'privacy_export');
  check('user B unaffected by user A limit', other.allowed === true && other.count === 1);

  // 6: action isolation
  const otherAction = await reserve(USER_A, 'privacy_correction');
  check('same user different action is isolated', otherAction.allowed === true && otherAction.count === 1);

  // 7: concurrency — wipe window and race inside the DB container so workers
  // share one Postgres host without Windows docker-exec scheduling artifacts.
  await psql(`
    delete from public.privacy_request_rate_limits
      where user_id = '${USER_A}' and action = 'account_deletion';
  `);

  const concurrencyOut = await new Promise((resolve, reject) => {
    execFile(
      DOCKER,
      [
        'exec',
        CONTAINER,
        'bash',
        '-lc',
        `sed -i 's/\\r$//' /tmp/privacy-rate-limit-concurrency.sh 2>/dev/null || true; bash /tmp/privacy-rate-limit-concurrency.sh`,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`;
        if (error && !text.includes('CONCURRENCY_PASS') && !text.includes('CONCURRENCY_FAIL')) {
          return reject(new Error(`${error.message}\n${text}`));
        }
        resolve(text);
      },
    );
  });
  check(
    'concurrent reservations never exceed limit',
    concurrencyOut.includes('CONCURRENCY_PASS'),
    concurrencyOut.split('\n').filter((l) => l.includes('allowed=') || l.includes('CONCURRENCY_')).join(' | '),
  );

  // 8-9: privileges
  const anonExec = await psql(`
    select has_function_privilege(
      'anon',
      'public.reserve_privacy_request_rate_limit(uuid, text, integer, integer)',
      'EXECUTE'
    )::text;
  `);
  const authExec = await psql(`
    select has_function_privilege(
      'authenticated',
      'public.reserve_privacy_request_rate_limit(uuid, text, integer, integer)',
      'EXECUTE'
    )::text;
  `);
  const serviceExec = await psql(`
    select has_function_privilege(
      'service_role',
      'public.reserve_privacy_request_rate_limit(uuid, text, integer, integer)',
      'EXECUTE'
    )::text;
  `);
  check('anon EXECUTE is false', anonExec === 'f' || anonExec === 'false');
  check('authenticated EXECUTE is false', authExec === 'f' || authExec === 'false');
  check('service_role EXECUTE is true', serviceExec === 't' || serviceExec === 'true');

  // 10: malformed action fails safely
  let malformedFailed = false;
  try {
    await psql(`
      select * from public.reserve_privacy_request_rate_limit(
        '${USER_A}'::uuid,
        'not_a_real_action',
        5,
        60
      );
    `);
  } catch {
    malformedFailed = true;
  }
  check('unknown action fails safely', malformedFailed);

  // Window reset: force an old window and confirm a new reservation is allowed
  await psql(`
    delete from public.privacy_request_rate_limits
      where user_id = '${USER_A}' and action = 'privacy_export';
    insert into public.privacy_request_rate_limits
      (user_id, action, window_start, request_count, updated_at)
    values
      ('${USER_A}', 'privacy_export', now() - interval '2 minutes', ${LIMIT}, now() - interval '2 minutes');
  `);
  const afterExpiry = await reserve(USER_A, 'privacy_export');
  check('window expiry/reset allows again', afterExpiry.allowed === true && afterExpiry.count === 1);

  await psql(`
    delete from public.privacy_request_rate_limits
      where user_id in ('${USER_A}','${USER_B}');
  `);

  console.log(`\nchecks=${checks} failures=${failures.length}`);
  if (failures.length) {
    console.error('HOSTILE_TEST_FAIL');
    process.exit(1);
  }
  console.log('HOSTILE_TEST_PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
