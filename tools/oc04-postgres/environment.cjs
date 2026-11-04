const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const os = require("node:os");
const net = require("node:net");
const { Pool, Client, types } = require("pg");
const { loadModules, world } = require(
  "../../__tests__/helpers/oc03ExecutionWorld",
);
const { createCommitProxy } = require("./commitProxy.cjs");
const run = promisify(execFile);
types.setTypeParser(1184, (v) => v);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function docker(args) {
  return (await run("docker", args, {
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim();
}
async function createEnvironment() {
  // Docker may reassign an automatically published host port on restart. Pick
  // an ephemeral loopback port, then publish that explicit port for this run.
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolve);
  });
  const hostPort = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const name = `kscan-oc04-${nonce.slice(0, 12)}`;
  const password = crypto.randomUUID();
  let started = false;
  const report = {
    platform: os.platform(),
    node: process.version,
    hostCpu: os.cpus()[0]?.model,
    hostLogicalCpus: os.cpus().length,
    hostMemoryBytes: os.totalmem(),
    containerCpuLimit: 2,
    containerMemoryBytes: 1073741824,
    poolMax: 8,
    image: "postgres:17",
    samples: [],
    driverEvents: [],
    queryErrors: [],
    poolHighWater: 0,
    waitingHighWater: 0,
    physicalConnections: new Set(),
    lockSamples: new Map(),
  };
  try {
    await docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `com.kscan.oc04.nonce=${nonce}`,
      "--cpus",
      "2",
      "--memory",
      "1g",
      "--pids-limit",
      "128",
      "--publish",
      `127.0.0.1:${hostPort}:5432`,
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:17",
      "-c",
      "max_connections=40",
      "-c",
      "deadlock_timeout=100ms",
      "-c",
      "log_lock_waits=on",
    ]);
    started = true;
    const inspected = JSON.parse(await docker(["inspect", name]))[0];
    assert.equal(inspected.Config.Labels["com.kscan.oc04.nonce"], nonce);
    const binding = inspected.NetworkSettings.Ports["5432/tcp"];
    assert.equal(binding.length, 1);
    assert.equal(binding[0].HostIp, "127.0.0.1");
    assert.equal(Number(binding[0].HostPort), hostPort);
    report.imageId = inspected.Image;
    const base = {
      host: "127.0.0.1",
      port: Number(binding[0].HostPort),
      user: "postgres",
      password,
      connectionTimeoutMillis: 3000,
      ssl: false,
    };
    const admin = new Pool({
      ...base,
      database: "postgres",
      max: 3,
      application_name: "oc04-disposable-control",
    });
    admin.on("error", () => {});
    let ready = false;
    const readyDeadline = performance.now() + 30000;
    let lastStartupError = "";
    while (performance.now() < readyDeadline) {
      try {
        await admin.query("select 1");
        ready = true;
        break;
      } catch (error) {
        lastStartupError = error.code ?? error.message;
        await sleep(100);
      }
    }
    if (!ready) {
      const log = await docker(["logs", "--tail", "25", name]);
      throw Error(
        `Disposable PostgreSQL did not become ready (${lastStartupError}): ${log}`,
      );
    }
    report.postgres =
      (await admin.query("select version() as version")).rows[0].version;
    await admin.query(
      "create role anon; create role authenticated; create role service_role bypassrls",
    );
    report.settings = (await admin.query(
      "select name,setting,unit from pg_settings where name in ('fsync','synchronous_commit','max_connections','shared_buffers','deadlock_timeout') order by name",
    )).rows;
    const modules = loadModules();
    let caseNumber = 0;
    const cases = [];
    async function createCase(
      label,
      { poolMax = 8, transactionTimeoutMs = 5000, acquireTimeoutMs = 3000 } =
        {},
    ) {
      const database = `oc04_${nonce.slice(0, 8)}_${++caseNumber}`;
      assert.match(database, /^oc04_[a-f0-9]+_\d+$/);
      await admin.query(`create database ${database}`);
      let root = new Client({
        ...base,
        database,
        application_name: `oc04-${label}-fixture`,
      });
      root.on("error", () => {});
      await root.connect();
      await root.query(
        "create table public.oc04_disposable_marker(nonce text primary key)",
      );
      await root.query("insert into public.oc04_disposable_marker values($1)", [
        nonce,
      ]);
      const proxy = await createCommitProxy(base.port);
      const pool = new Pool({
        ...base,
        port: proxy.port,
        ssl: false,
        database,
        max: poolMax,
        application_name: `oc04-${label}-worker`,
      });
      pool.on("error", () => {});
      const observations = {
        label,
        queries: [],
        events: [],
        pids: new Set(),
        errors: [],
        lockWaits: new Map(),
        tableLockWaits: new Map(),
        poolSamples: [],
      };
      let hook = async () => {};
      const seenClients = new WeakSet();
      const adapterPool = {
        connect: async () => {
          const c = await pool.connect();
          if (!seenClients.has(c)) {
            seenClients.add(c);
            c.on("error", (e) =>
              observations.errors.push({
                code: e.code ?? "transport",
                statement: "connection event",
              }));
          }
          try {
            await c.query("reset role");
            const marker = await c.query(
              "select nonce from public.oc04_disposable_marker",
            );
            assert.equal(
              marker.rows[0]?.nonce,
              nonce,
              "Not this disposable database",
            );
            await c.query("set role service_role");
          } catch (e) {
            c.release(true);
            throw e;
          }
          observations.pids.add(c.processID);
          report.physicalConnections.add(c.processID);
          return {
            release: (destroy) => c.release(destroy),
            query: async (sql, parameters) => {
              const stamp = performance.now();
              const event = {
                phase: "before",
                sql,
                parameters,
                pid: c.processID,
                label,
              };
              try {
                await hook(event);
                const result = await c.query(sql, parameters);
                await hook({ ...event, phase: "after", result });
                return result;
              } catch (e) {
                observations.errors.push({
                  code: e.code ?? "transport",
                  statement: sql.split(/\s+/).slice(0, 3).join(" "),
                });
                throw e;
              } finally {
                observations.queries.push({
                  pid: c.processID,
                  statement: sql,
                  elapsedMs: performance.now() - stamp,
                });
              }
            },
          };
        },
      };
      const driver = modules.createTransactionDatabase(adapterPool, {
        acquireTimeoutMs,
        transactionTimeoutMs,
        emit: (e) => observations.events.push(e),
      });
      const db = {
        exec: (sql) =>
          root.query(
            sql.replace(
              /^create role anon; create role authenticated; create role service_role bypassrls;\s*/,
              "",
            ),
          ),
        query: (sql, p) => root.query(sql, p),
        transaction: (body) => driver.transaction(body),
        close: async () => {
          await pool.end();
          await root.end();
        },
      };
      const w = await world({
        databaseFactory: async () => db,
        environment: { WATCHLIST_MAX_ACTIVE_WATCHES_PER_ACTOR: "1000" },
      });
      let control = new Client({
        ...base,
        database,
        application_name: `oc04-${label}-observer`,
      });
      control.on("error", () => {});
      await control.connect();
      let sampling = false;
      const timer = setInterval(async () => {
        const sample = {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        };
        observations.poolSamples.push(sample);
        report.poolHighWater = Math.max(report.poolHighWater, sample.total);
        report.waitingHighWater = Math.max(
          report.waitingHighWater,
          sample.waiting,
        );
        if (sampling) return;
        sampling = true;
        try {
          const rows = (await control.query(
            "select pid,waitstart::text,mode,locktype,relation::regclass::text as relation,extract(epoch from(clock_timestamp()-waitstart))*1000 as wait_ms from pg_locks where not granted and waitstart is not null and pid in(select pid from pg_stat_activity where datname=current_database())",
          )).rows;
          for (const r of rows) {
            const key = `${r.pid}:${r.waitstart}`;
            observations.lockWaits.set(
              key,
              Math.max(observations.lockWaits.get(key) ?? 0, Number(r.wait_ms)),
            );
            if (
              r.mode === "ShareRowExclusiveLock" &&
              r.relation?.endsWith("user_commerce_watches")
            ) {
              observations.tableLockWaits.set(
                key,
                Math.max(
                  observations.tableLockWaits.get(key) ?? 0,
                  Number(r.wait_ms),
                ),
              );
            }
          }
        } catch {
          /* restart/fault tests deliberately interrupt the observer */
        } finally {
          sampling = false;
        }
      }, 5);
      const clients = [];
      const result = {
        w,
        db,
        pool,
        driver,
        observations,
        database,
        modules,
        proxy,
        hook: (fn) => hook = fn,
        connect: async () => {
          const c = new Client({
            ...base,
            database,
            application_name: `oc04-${label}-adversary`,
          });
          c.on("error", () => {});
          await c.connect();
          clients.push(c);
          return c;
        },
        async reconnect() {
          await root.end().catch(() => {});
          await control.end().catch(() => {});
          root = new Client({ ...base, database });
          root.on("error", () => {});
          await root.connect();
          await root.query("set role service_role");
          control = new Client({ ...base, database });
          control.on("error", () => {});
          await control.connect();
        },
        async close() {
          if (result.closed) return;
          result.closed = true;
          clearInterval(timer);
          while (sampling) await sleep(5);
          for (const c of clients) await c.end().catch(() => {});
          await control.end().catch(() => {});
          await w.close();
          await proxy.close();
          report.driverEvents.push(...observations.events);
          report.queryErrors.push(...observations.errors);
          for (const [key, v] of observations.lockWaits) {
            report.lockSamples.set(`${label}:${key}`, v);
          }
        },
      };
      cases.push(result);
      return result;
    }
    return {
      report,
      createCase,
      docker,
      sleep,
      async restart() {
        await docker(["restart", name]);
        const restarted = JSON.parse(await docker(["inspect", name]))[0];
        assert.equal(
          Number(restarted.NetworkSettings.Ports["5432/tcp"][0].HostPort),
          hostPort,
        );
        let ok = false;
        const restartDeadline = performance.now() + 30000;
        while (performance.now() < restartDeadline) {
          try {
            await admin.query("select 1");
            ok = true;
            break;
          } catch {
            await sleep(100);
          }
        }
        assert.ok(ok);
      },
      async closeCases() {
        for (const c of cases) await c.close();
      },
      async close() {
        for (const c of cases) await c.close().catch(() => {});
        await admin.end();
        const i = JSON.parse(await docker(["inspect", name]))[0];
        assert.equal(i.Config.Labels["com.kscan.oc04.nonce"], nonce);
        await docker(["rm", "--force", "--volumes", name]);
        report.cleanup = "verified owned container removed";
      },
    };
  } catch (error) {
    if (started) {
      const i = JSON.parse(await docker(["inspect", name]))[0];
      assert.equal(i.Config.Labels["com.kscan.oc04.nonce"], nonce);
      await docker(["rm", "--force", "--volumes", name]);
    }
    throw error;
  }
}
module.exports = { createEnvironment, sleep };
