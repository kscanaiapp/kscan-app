// Fake pool tests verify adapter mechanics; real PostgreSQL certification is a separate Docker harness.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import {
  createTransactionDatabase,
  type TransactionClient,
  TransactionFailure,
} from "./transactionDriver.ts";
import type { Sql } from "../customerAuthorization/repository.ts";

const options = { acquireTimeoutMs: 50, transactionTimeoutMs: 100 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => resolve = r);
  return { promise, resolve };
}
function fixture(fail?: string) {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const client: TransactionClient = {
    release: (destroy) => releases.push(Boolean(destroy)),
    query: async <T>(sql: string) => {
      calls.push(sql);
      if (sql === fail) throw Error("synthetic_transport");
      return { rows: [] as T[] };
    },
  };
  let checkouts = 0;
  const pool = {
    connect: async () => {
      checkouts++;
      return client;
    },
  };
  return {
    calls,
    releases,
    client,
    pool,
    get checkouts() {
      return checkouts;
    },
  };
}
Deno.test("transaction adapter uses one connection and invalidates escaped SQL after commit", async () => {
  const f = fixture();
  const db = createTransactionDatabase(f.pool, options);
  let escaped: Sql | undefined;
  const result = await db.transaction(async (sql) => {
    escaped = sql;
    await sql.query("SELECT first");
    await sql.query("SELECT second");
    return 7;
  });
  assert.equal(result, 7);
  assert.equal(f.checkouts, 1);
  assert.deepEqual(f.calls.filter((s) => !s.startsWith("select set_config")), [
    "BEGIN",
    "SELECT first",
    "SELECT second",
    "COMMIT",
  ]);
  assert.deepEqual(f.releases, [false]);
  await assert.rejects(escaped!.query("INSERT late"), TransactionFailure);
  assert.equal(f.calls.length, 5);
});
Deno.test("transaction callback errors roll back, preserve the domain error, and release once", async () => {
  const f = fixture();
  const error = Error("domain_rejection");
  await assert.rejects(
    createTransactionDatabase(f.pool, options).transaction(async (sql) => {
      await sql.query("SELECT before");
      throw error;
    }),
    (e) => e === error,
  );
  assert.deepEqual(f.calls.filter((s) => !s.startsWith("select set_config")), [
    "BEGIN",
    "SELECT before",
    "ROLLBACK",
  ]);
  assert.deepEqual(f.releases, [false]);
});
Deno.test("uncertain COMMIT discards connection and never repeats callback or attempts a fictional rollback", async () => {
  const f = fixture("COMMIT");
  let bodies = 0;
  await assert.rejects(
    createTransactionDatabase(f.pool, options).transaction(async (sql) => {
      bodies++;
      await sql.query("INSERT one");
    }),
    (e) => e instanceof TransactionFailure && e.outcome === "uncertain",
  );
  assert.equal(bodies, 1);
  assert.deepEqual(f.calls.filter((s) => !s.startsWith("select set_config")), [
    "BEGIN",
    "INSERT one",
    "COMMIT",
  ]);
  assert.deepEqual(f.releases, [true]);
});
Deno.test("whole transaction deadline destroys connection and fences late callback SQL", async () => {
  const f = fixture();
  const continuation = deferred<void>();
  let escaped: Sql | undefined;
  const db = createTransactionDatabase(f.pool, {
    ...options,
    transactionTimeoutMs: 15,
  });
  await assert.rejects(
    db.transaction(async (sql) => {
      escaped = sql;
      await continuation.promise;
      await sql.query("INSERT late");
    }),
    TransactionFailure,
  );
  continuation.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(escaped!.query("COMMIT"), TransactionFailure);
  assert.deepEqual(f.calls.filter((s) => !s.startsWith("select set_config")), [
    "BEGIN",
  ]);
  assert.deepEqual(f.releases, [true]);
});
Deno.test("late pool acquisition is discarded without BEGIN after acquisition deadline", async () => {
  const f = fixture();
  const pending = deferred<TransactionClient>();
  const db = createTransactionDatabase({ connect: () => pending.promise }, {
    ...options,
    acquireTimeoutMs: 15,
  });
  await assert.rejects(
    db.transaction(async () => 1),
    (e) => e instanceof TransactionFailure && e.outcome === "not_started",
  );
  pending.resolve(f.client);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.releases, [true]);
});
Deno.test("rollback transport failure destroys connection and reports uncertainty", async () => {
  const f = fixture("ROLLBACK");
  await assert.rejects(
    createTransactionDatabase(f.pool, options).transaction(async () => {
      throw Error("domain");
    }),
    TransactionFailure,
  );
  assert.deepEqual(f.releases, [true]);
});
