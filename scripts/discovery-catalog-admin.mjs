#!/usr/bin/env node
/**
 * Operator path for Black-Owned Discovery onboarding and moderation.
 *
 * Every write goes through the existing reviewed SQL authority
 * (`discovery_manage`, `discovery_moderate_product`, `discovery_cleanup`), which
 * re-checks the acting reviewer in `discovery_reviewers` and audits the change.
 * This tool adds no authority of its own: it only sequences those calls.
 *
 *   node scripts/discovery-catalog-admin.mjs status   --project <ref>
 *   node scripts/discovery-catalog-admin.mjs apply    --project <ref> --plan <plan.json> [--confirm-project <ref>]
 *   node scripts/discovery-catalog-admin.mjs moderate --project <ref> --actor <uuid> --product <uuid> --decision reject|restore [--confirm-project <ref>]
 *   node scripts/discovery-catalog-admin.mjs cleanup  --project <ref> --actor <uuid> [--confirm-project <ref>]
 *
 * Writes are a DRY RUN unless --confirm-project repeats --project exactly.
 * SUPABASE_ACCESS_TOKEN must be supplied by the environment; it is never logged.
 * Plans hold real, reviewed evidence REFERENCES only (opaque ids into the
 * restricted evidence store), never documents, owner profiles or credentials.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PROJECTS = { yzqjvdfgefveprobvvyw: 'staging', wyyuqfdxucjksghsmhry: 'production' };
export const ACTIONS = ['prospect', 'register_brand', 'submit_evidence', 'request_review', 'review_ownership', 'brand_visibility', 'merchant', 'partnership', 'withdraw_product'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** A JSON literal that cannot terminate its own dollar quote. */
export function jsonLiteral(value) {
  const body = JSON.stringify(value);
  let tag;
  do tag = `kscan_${crypto.randomBytes(6).toString('hex')}`; while (body.includes(tag));
  return `$${tag}$${body}$${tag}$::jsonb`;
}
const uuidLiteral = (value, label) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} must be a UUID`);
  return `'${value.toLowerCase()}'::uuid`;
};

/** Replace "{{name}}" strings with ids returned by earlier steps. */
export function resolveRefs(value, ids) {
  if (typeof value === 'string') {
    const match = /^\{\{([a-z][a-z0-9_]{0,31})\}\}$/.exec(value);
    if (!match) return value;
    if (!ids[match[1]]) throw new Error(`unresolved step reference ${match[1]}`);
    return ids[match[1]];
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, ids)]));
  return value;
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan must be an object');
  uuidLiteral(plan.actor, 'plan.actor');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 50) throw new Error('plan.steps must hold 1-50 steps');
  const names = new Set();
  for (const [i, step] of plan.steps.entries()) {
    if (!ACTIONS.includes(step?.action)) throw new Error(`step ${i}: unsupported action`);
    if (!step.data || typeof step.data !== 'object' || Array.isArray(step.data)) throw new Error(`step ${i}: data must be an object`);
    if (step.as !== undefined) {
      if (!NAME.test(step.as) || names.has(step.as)) throw new Error(`step ${i}: invalid or duplicate "as"`);
      names.add(step.as);
    }
    if (step.actor !== undefined) uuidLiteral(step.actor, `step ${i}.actor`);
    if (JSON.stringify(step.data).length > 12000) throw new Error(`step ${i}: payload too large`);
  }
  return plan;
}
export const manageSql = (actor, action, data) =>
  `select public.discovery_manage(${uuidLiteral(actor, 'actor')}, '${action}', ${jsonLiteral(data)}) as id`;
export const moderateSql = (actor, product, decision) => {
  if (!['reject', 'restore'].includes(decision)) throw new Error('decision must be reject or restore');
  return `select public.discovery_moderate_product(${uuidLiteral(actor, 'actor')}, ${uuidLiteral(product, 'product')}, '${decision}')`;
};
export const cleanupSql = (actor) => `select public.discovery_cleanup(${uuidLiteral(actor, 'actor')})`;
export const STATUS_SQL = `select
  (select count(*) from public.discovery_brands)::int as brands,
  (select count(*) from public.discovery_brands where ownership_status='verified' and public_label_allowed and verified_until>now())::int as publicly_verified_brands,
  (select count(*) from public.discovery_merchants where status='active' and catalog_status='approved')::int as active_merchants,
  (select count(*) from public.discovery_products)::int as products,
  (select count(*) from public.discovery_eligible_products)::int as eligible_products,
  (select count(*) from public.discovery_reviewers where enabled)::int as enabled_reviewers,
  (select max(created_at) from public.discovery_sync_runs where status='succeeded') as last_successful_sync`;

export function managementClient(project, token, fetchImpl = fetch) {
  if (!PROJECTS[project]) throw new Error('unknown project ref');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is required');
  return async (query) => {
    const response = await fetchImpl(`https://api.supabase.com/v1/projects/${project}/database/query`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const text = await response.text();
    // Database errors are the reviewed SQL guards speaking; never echo the token.
    if (!response.ok) throw new Error(`query rejected (${response.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
}

export async function applyPlan(plan, run, log = console.log) {
  validatePlan(plan);
  const ids = {};
  for (const [i, step] of plan.steps.entries()) {
    const data = resolveRefs(step.data, ids);
    const rows = await run(manageSql(step.actor ?? plan.actor, step.action, data));
    const id = rows?.[0]?.id;
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error(`step ${i}: no id returned`);
    if (step.as) ids[step.as] = id;
    log(`step ${i + 1}/${plan.steps.length} ${step.action} -> ${id}`);
  }
  return ids;
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}
async function main() {
  const opts = args(process.argv.slice(2));
  const command = opts._[0];
  const project = opts.project;
  if (!PROJECTS[project]) throw new Error('--project must be the staging or production project ref');
  const confirmed = opts['confirm-project'] === project;
  const dry = (sql) => { console.log(`[dry run: ${PROJECTS[project]}] ${sql.replace(/\$kscan_[0-9a-f]+\$[\s\S]*?\$kscan_[0-9a-f]+\$/g, '<payload>')}`); return [{ id: crypto.randomUUID() }]; };
  const live = () => managementClient(project, process.env.SUPABASE_ACCESS_TOKEN);
  if (command === 'status') { console.log(JSON.stringify((await live()(STATUS_SQL))[0], null, 2)); return; }
  const run = confirmed ? live() : dry;
  if (!confirmed) console.log('DRY RUN. Repeat the project ref with --confirm-project to write.');
  if (command === 'apply') await applyPlan(JSON.parse(fs.readFileSync(opts.plan, 'utf8')), run);
  else if (command === 'moderate') { await run(moderateSql(opts.actor, opts.product, opts.decision)); console.log(`moderation decision recorded: ${opts.decision}`); }
  else if (command === 'cleanup') { await run(cleanupSql(opts.actor)); console.log('cleanup complete'); }
  else throw new Error('command must be status, apply, moderate or cleanup');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
