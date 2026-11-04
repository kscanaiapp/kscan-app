import {
  type Actor,
  hash,
  type Proposal,
  validateStoredProposal,
} from "../customerAuthorization/contracts.ts";
import type { Sql } from "../customerAuthorization/repository.ts";
import {
  type Binding,
  type Code,
  type Effect,
  ensure,
  EXECUTION_RATE,
  EXECUTION_VERSION,
  ExecutionError,
  type Ledger,
  type State,
} from "./contracts.ts";

export async function clock(sql: Sql): Promise<number> {
  return (await sql.query<{ now: number }>(
    "select (extract(epoch from clock_timestamp())*1000)::double precision as now",
  )).rows[0].now;
}
export async function proposal(
  sql: Sql,
  actor: Actor,
  id: string,
): Promise<Proposal> {
  const stored = (await sql.query<{ document: Proposal }>(
    "select document from oc02_authorization.proposals where id=$1 and actor_id=$2 and account_id=$3 for update",
    [id, actor.actorId, actor.accountId],
  )).rows[0]?.document;
  ensure(stored, "not_found");
  try {
    return await validateStoredProposal(stored, Math.ceil(await clock(sql)));
  } catch {
    throw new ExecutionError("authorization_invalid");
  }
}
export async function binding(
  sql: Sql,
  actor: Actor,
  id: string,
): Promise<Binding> {
  const row = (await sql.query<Binding>(
    "select * from oc03_execution.bindings where proposal_id=$1 and actor_id=$2 and account_id=$3 for update",
    [id, actor.actorId, actor.accountId],
  )).rows[0];
  ensure(
    row && row.binding_hash === await hash(row.binding),
    "confirmation_required",
  );
  return row;
}
export async function ledger(
  sql: Sql,
  actor: Actor,
  id: string,
): Promise<Ledger | null> {
  return (await sql.query<Ledger>(
    "select * from oc03_execution.ledger where proposal_id=$1 and actor_id=$2 and account_id=$3 for update",
    [id, actor.actorId, actor.accountId],
  )).rows[0] ?? null;
}
export async function claim(sql: Sql, actor: Actor) {
  const result = await sql.query<{ count: number }>(
    `insert into oc03_execution.limits(actor_id,minute,count) values($1,date_trunc('minute',clock_timestamp()),1)
    on conflict(actor_id) do update set count=case when limits.minute=date_trunc('minute',clock_timestamp()) then limits.count+1 else 1 end,
    minute=date_trunc('minute',clock_timestamp()) where limits.minute<>date_trunc('minute',clock_timestamp()) or limits.count < 20 returning count`,
    [actor.actorId],
  );
  ensure(
    result.rows.length === 1 && result.rows[0].count <= EXECUTION_RATE,
    "rate_limited",
  );
}
export async function lockAuthorizationScope(sql: Sql, actor: Actor) {
  const row = await sql.query(
    "select actor_id from oc02_authorization.limits where actor_id=$1 for update",
    [actor.actorId],
  );
  ensure(row.rows.length === 1, "authorization_invalid");
}
export async function audit(
  sql: Sql,
  id: string,
  state: State,
  effect: Effect,
  reason: Code | null,
) {
  await sql.query(
    "insert into oc03_execution.audit(proposal_id,metadata) values($1,$2::jsonb)",
    [id, JSON.stringify({ version: EXECUTION_VERSION, state, effect, reason })],
  );
}
export async function update(
  sql: Sql,
  l: Ledger,
  state: State,
  effect: Effect,
  reason: Code | null,
  watchId: string | null = l.watch_id,
  evidence: Ledger["evidence"] = l.evidence,
  evidenceHash: string | null = l.evidence_hash,
): Promise<Ledger> {
  const r = await sql.query<Ledger>(
    "update oc03_execution.ledger set state=$1,effect=$2,reason=$3,watch_id=$4,evidence=$5::jsonb,evidence_hash=$6,revision=revision+1 where proposal_id=$7 and revision=$8 returning *",
    [
      state,
      effect,
      reason,
      watchId,
      evidence === null ? null : JSON.stringify(evidence),
      evidenceHash,
      l.proposal_id,
      l.revision,
    ],
  );
  ensure(r.rows.length === 1, "conflict");
  await audit(sql, l.proposal_id, state, effect, reason);
  return r.rows[0];
}
