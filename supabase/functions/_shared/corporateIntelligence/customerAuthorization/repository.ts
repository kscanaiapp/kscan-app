import {
  canonical,
  checkTransition,
  hash,
  type Proposal,
  RATE_PER_MINUTE,
  requireValue,
  type Scope,
} from "./contracts.ts";

export type Commit = {
  scope: Scope;
  operationId: string;
  requestHash: string;
  expectedRevision: number | null;
  next: Proposal;
  now: number;
};
export type Receipt = { proposalId: string; requestHash: string };
export type Audit = {
  version: "oc02-audit-v1";
  capability: Proposal["snapshot"]["capability"];
  from: Proposal["state"] | "none";
  to: Proposal["state"];
  revision: number;
};
/** All writes, receipts and audit transitions must commit/rollback atomically. No product/account mutation methods exist. */
export interface Repository {
  claim(scope: Scope, now: number): Promise<void>;
  get(scope: Scope, id: string): Promise<Proposal | null>;
  receipt(scope: Scope, operationId: string): Promise<Receipt | null>;
  commit(command: Commit): Promise<Proposal>;
  purge(now: number): Promise<number>;
}
export const scopeKey = (s: Scope) => `${s.actorId}:${s.accountId}`;
export function audit(current: Proposal | null, next: Proposal): Audit {
  return {
    version: "oc02-audit-v1",
    capability: next.snapshot.capability,
    from: current?.state ?? "none",
    to: next.state,
    revision: next.revision,
  };
}
export function validateCommit(c: Commit, current: Proposal | null) {
  requireValue(
    c.next.snapshot.actorId === c.scope.actorId &&
      c.next.snapshot.accountId === c.scope.accountId,
    "unauthorized",
  );
  requireValue(
    current
      ? current.revision === c.expectedRevision
      : c.expectedRevision === null,
    "conflict",
  );
  checkTransition(current, c.next, c.now);
}
/** Test/reference adapter ONLY. Synchronous critical sections are atomic within this process, never durable. */
export class MemoryRepository implements Repository {
  private records = new Map<string, Proposal>();
  private receipts = new Map<string, Receipt & { retainUntil: number }>();
  private limits = new Map<string, { minute: number; count: number }>();
  readonly audits: Audit[] = [];
  claim(scope: Scope, now: number): Promise<void> {
    const key = scope.actorId;
    const minute = Math.floor(now / 60_000);
    const rate = this.limits.get(key)?.minute === minute
      ? this.limits.get(key)!
      : { minute, count: 0 };
    requireValue(rate.count < RATE_PER_MINUTE, "rate_limited");
    rate.count++;
    this.limits.set(key, rate);
    return Promise.resolve();
  }
  get(scope: Scope, id: string): Promise<Proposal | null> {
    const p = this.records.get(id);
    return Promise.resolve(
      p && p.snapshot.actorId === scope.actorId &&
        p.snapshot.accountId === scope.accountId
        ? structuredClone(p)
        : null,
    );
  }
  receipt(scope: Scope, operationId: string): Promise<Receipt | null> {
    const r = this.receipts.get(`${scopeKey(scope)}:${operationId}`);
    return Promise.resolve(
      r ? { proposalId: r.proposalId, requestHash: r.requestHash } : null,
    );
  }
  async commit(c: Commit): Promise<Proposal> {
    requireValue(
      c.next.snapshotHash === await hash(c.next.snapshot),
      "conflict",
    );
    const key = `${scopeKey(c.scope)}:${c.operationId}`;
    const receipt = this.receipts.get(key);
    if (receipt) {
      requireValue(
        receipt.requestHash === c.requestHash,
        "idempotency_conflict",
      );
      const p = this.records.get(receipt.proposalId);
      requireValue(p, "conflict");
      return Promise.resolve(structuredClone(p));
    }
    const current = this.records.get(c.next.snapshot.id) ?? null;
    validateCommit(c, current);
    this.records.set(c.next.snapshot.id, structuredClone(c.next));
    this.receipts.set(key, {
      proposalId: c.next.snapshot.id,
      requestHash: c.requestHash,
      retainUntil: c.next.snapshot.retainUntil,
    });
    this.audits.push(audit(current, c.next));
    return Promise.resolve(structuredClone(c.next));
  }
  purge(now: number): Promise<number> {
    let count = 0;
    for (const [id, p] of this.records) {
      if (p.snapshot.retainUntil <= now) {
        this.records.delete(id);
        count++;
      }
    }
    for (const [key, r] of this.receipts) {
      if (r.retainUntil <= now) this.receipts.delete(key);
    }
    for (const [key, r] of this.limits) {
      if (r.minute < Math.floor(now / 60_000)) this.limits.delete(key);
    }
    return Promise.resolve(count);
  }
}
/** The injected driver must supply a real database transaction on one connection; do not emulate with independent REST calls. */
export type Sql = {
  query<T = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
};
export type Database = {
  transaction<T>(body: (sql: Sql) => Promise<T>): Promise<T>;
};
export class PostgresRepository implements Repository {
  private readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  async claim(scope: Scope, _now: number): Promise<void> {
    await this.db.transaction(async (sql) => {
      const r = await sql.query<{ count: number }>(
        `insert into oc02_authorization.limits(actor_id,minute,count)
        values($1,date_trunc('minute',clock_timestamp()),1)
        on conflict(actor_id) do update set
        count=case when limits.minute=date_trunc('minute',clock_timestamp()) then limits.count+1 else 1 end,
        minute=date_trunc('minute',clock_timestamp())
        where limits.minute<>date_trunc('minute',clock_timestamp()) or limits.count < 30
        returning count`,
        [scope.actorId],
      );
      requireValue(
        r.rows.length === 1 && r.rows[0].count <= RATE_PER_MINUTE,
        "rate_limited",
      );
    });
  }
  async get(scope: Scope, id: string): Promise<Proposal | null> {
    return await this.db.transaction(async (sql) =>
      (await sql.query<{ document: Proposal }>(
        "select document from oc02_authorization.proposals where id=$1 and actor_id=$2 and account_id=$3",
        [id, scope.actorId, scope.accountId],
      )).rows[0]?.document ?? null
    );
  }
  async receipt(scope: Scope, operationId: string): Promise<Receipt | null> {
    return await this.db.transaction(async (sql) =>
      (await sql.query<Receipt>(
        'select proposal_id as "proposalId", request_hash as "requestHash" from oc02_authorization.receipts where actor_id=$1 and account_id=$2 and operation_id=$3',
        [scope.actorId, scope.accountId, operationId],
      )).rows[0] ?? null
    );
  }
  async commit(c: Commit): Promise<Proposal> {
    return await this.db.transaction(async (sql) => {
      // Scope lock serializes different proposal IDs sharing one idempotency key.
      const lock = await sql.query(
        "select actor_id from oc02_authorization.limits where actor_id=$1 for update",
        [c.scope.actorId],
      );
      requireValue(lock.rows.length === 1, "rate_limited");
      const r = (await sql.query<{ document: Proposal; request_hash: string }>(
        `select p.document,r.request_hash from oc02_authorization.receipts r join oc02_authorization.proposals p on p.id=r.proposal_id
        where r.actor_id=$1 and r.account_id=$2 and r.operation_id=$3`,
        [c.scope.actorId, c.scope.accountId, c.operationId],
      )).rows[0];
      if (r) {
        requireValue(r.request_hash === c.requestHash, "idempotency_conflict");
        return r.document;
      }
      const current = (await sql.query<{ document: Proposal }>(
        "select document from oc02_authorization.proposals where id=$1 for update",
        [c.next.snapshot.id],
      )).rows[0]?.document ?? null;
      const clock = (await sql.query<{ now: number }>(
        "select (extract(epoch from clock_timestamp()) * 1000)::double precision as now",
      )).rows[0].now;
      validateCommit({ ...c, now: clock }, current);
      requireValue(
        c.next.snapshotHash === await hash(c.next.snapshot),
        "conflict",
      );
      if (current) {
        await sql.query(
          "update oc02_authorization.proposals set document=$1::jsonb where id=$2",
          [JSON.stringify(c.next), c.next.snapshot.id],
        );
      } else {
        await sql.query(
          "insert into oc02_authorization.proposals(id,actor_id,account_id,retain_until,document) values($1,$2,$3,$4,$5::jsonb)",
          [
            c.next.snapshot.id,
            c.scope.actorId,
            c.scope.accountId,
            c.next.snapshot.retainUntil,
            JSON.stringify(c.next),
          ],
        );
      }
      await sql.query(
        "insert into oc02_authorization.receipts(actor_id,account_id,operation_id,request_hash,proposal_id) values($1,$2,$3,$4,$5)",
        [
          c.scope.actorId,
          c.scope.accountId,
          c.operationId,
          c.requestHash,
          c.next.snapshot.id,
        ],
      );
      await sql.query(
        "insert into oc02_authorization.audit(proposal_id,metadata) values($1,$2::jsonb)",
        [c.next.snapshot.id, canonical(audit(current, c.next))],
      );
      return structuredClone(c.next);
    });
  }
  async purge(_now: number): Promise<number> {
    return await this.db.transaction(async (sql) => {
      const result = await sql.query(
        "delete from oc02_authorization.proposals where retain_until <= extract(epoch from clock_timestamp())*1000 returning id",
      );
      await sql.query(
        "delete from oc02_authorization.limits where minute < date_trunc('minute',clock_timestamp())",
      );
      return result.rows.length;
    });
  }
}
