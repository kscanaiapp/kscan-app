import type { Database, Sql } from "../customerAuthorization/repository.ts";

/** Structural port: no database URL, credential reader, provider or automatic retry. */
export type TransactionClient = Sql & { release: (destroy?: boolean) => void };
export type TransactionPool = { connect: () => Promise<TransactionClient> };
export type DriverEvent = {
  phase: "acquire" | "body" | "commit" | "rollback";
  outcome: "committed" | "rolled_back" | "uncertain" | "not_started";
  elapsedMs: number;
};
export class TransactionFailure extends Error {
  readonly outcome: "uncertain" | "not_started";
  constructor(outcome: "uncertain" | "not_started") {
    super(`transaction_${outcome}`);
    this.outcome = outcome;
  }
}
/** One physical connection from BEGIN through COMMIT/ROLLBACK; uncertain COMMIT is NEVER replayed. */
export function createTransactionDatabase(
  pool: TransactionPool,
  options: {
    acquireTimeoutMs: number;
    transactionTimeoutMs: number;
    emit?: (event: DriverEvent) => void;
  },
): Database {
  if (
    !Number.isFinite(options.acquireTimeoutMs) ||
    options.acquireTimeoutMs <= 0 ||
    !Number.isFinite(options.transactionTimeoutMs) ||
    options.transactionTimeoutMs <= 0
  ) throw new Error("invalid_transaction_deadline");
  return {
    async transaction<T>(body: (sql: Sql) => Promise<T>): Promise<T> {
      const started = performance.now();
      let client: TransactionClient | undefined;
      let released = false;
      let usable = false;
      let reusable = false;
      let phase: DriverEvent["phase"] = "acquire";
      let timedOut = false;
      let outcome: DriverEvent["outcome"] = "not_started";
      let acquireTimer: ReturnType<typeof setTimeout> | undefined;
      let transactionTimer: ReturnType<typeof setTimeout> | undefined;
      const release = (destroy: boolean) => {
        if (client && !released) {
          released = true;
          usable = false;
          client.release(destroy);
        }
      };
      const pending = Promise.resolve().then(() => pool.connect());
      const acquired = new Promise<never>((_, reject) => {
        acquireTimer = setTimeout(() => {
          timedOut = true;
          reject(new TransactionFailure("not_started"));
        }, options.acquireTimeoutMs);
      });
      // A pool checkout that resolves after its deadline is discarded, never leaked or used.
      void pending.then((c) => {
        if (timedOut) c.release(true);
      }, () => {});
      try {
        client = await Promise.race([pending, acquired]);
        clearTimeout(acquireTimer);
        let rejectDeadline: (error: TransactionFailure) => void = () => {};
        const deadline = new Promise<never>((_, reject) => {
          rejectDeadline = reject;
        });
        transactionTimer = setTimeout(() => {
          timedOut = true;
          outcome = "uncertain";
          release(true);
          rejectDeadline(new TransactionFailure("uncertain"));
        }, options.transactionTimeoutMs);
        const bounded = <R>(work: Promise<R>) => Promise.race([work, deadline]);
        phase = "body";
        await bounded(client.query("BEGIN"));
        // Socket destruction alone may leave a running server statement holding
        // locks until disconnect is noticed. Bound server work as well.
        await bounded(
          client.query(
            "select set_config('statement_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$1,true)",
            [String(Math.ceil(options.transactionTimeoutMs))],
          ),
        );
        usable = true;
        const connection = client;
        const sql: Sql = {
          query: <R = Record<string, unknown>>(
            statement: string,
            parameters?: unknown[],
          ) => {
            if (!usable || released || timedOut || phase !== "body") {
              return Promise.reject(new TransactionFailure("uncertain"));
            }
            return connection.query<R>(statement, parameters);
          },
        };
        let value: T;
        try {
          value = await bounded(Promise.resolve().then(() => body(sql)));
        } catch (error) {
          usable = false;
          if (timedOut || released) {
            outcome = "uncertain";
            throw new TransactionFailure("uncertain");
          }
          phase = "rollback";
          try {
            await bounded(connection.query("ROLLBACK"));
            outcome = "rolled_back";
            reusable = true;
          } catch {
            outcome = "uncertain";
            release(true);
            throw new TransactionFailure("uncertain");
          }
          throw error;
        }
        usable = false;
        phase = "commit";
        try {
          await bounded(connection.query("COMMIT"));
          outcome = "committed";
          reusable = true;
        } catch {
          outcome = "uncertain";
          release(true);
          throw new TransactionFailure("uncertain");
        }
        return value;
      } catch (error) {
        if (phase === "acquire") {
          timedOut = true;
          throw new TransactionFailure("not_started");
        }
        if (!reusable) release(true);
        throw error;
      } finally {
        clearTimeout(acquireTimer);
        clearTimeout(transactionTimer);
        usable = false;
        release(!reusable);
        try {
          options.emit?.({
            phase,
            outcome,
            elapsedMs: Math.round(performance.now() - started),
          });
        } catch { /* telemetry cannot affect transaction outcome */ }
      }
    },
  };
}
