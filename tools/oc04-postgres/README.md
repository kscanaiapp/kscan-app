# OC-04 disposable PostgreSQL verification

Run from the repository root with Docker Desktop running, Node installed and the repository's TypeScript test dependency available:

```powershell
npm ci --prefix tools/oc04-postgres --ignore-scripts --no-audit --no-fund
node tools/oc04-postgres/run.cjs
```

This command creates and removes its own labeled `postgres:17` container, bound only to loopback. It accepts no external database URL. It verifies its random ownership marker before runtime checkouts and the container label before removal. The fixture password stays in memory. Docker must already have the image or be allowed to pull it.

The suite uses independent physical `pg` connections, actual Watchlist migrations/RPCs, the proposed OC-02/OC-03 schemas and the isolated executor. Account, entitlement, permission and product sources are synthetic fixtures; this does not certify deployed Supabase policies or production resolvers. Each case gets a separate database; all databases disappear with the container. No runtime route is wired.

The loopback PostgreSQL wire proxy can discard one acknowledged COMMIT reply after the server has committed. It never records authentication frames or SQL parameters. This is a test fixture, with TLS disabled only for the disposable local connection.

Results overwrite `docs/build36/corporate-intelligence-v2/OC-04-POSTGRES-EVIDENCE.json`. A deliberately induced legacy row-first deadlock and deliberate timeout/transport failures are expected adversarial results; assertion failures make the run fail. Lock waits are sampled every 5 ms, so short waits can be missed and observed durations are lower bounds. Lock-statement timings include transport and server work. Local latency is diagnostic, with no production throughput claim or invented SLA.

If the process is forcibly killed, its cleanup cannot run. Inspect the exact `com.kscan.oc04.nonce` label and matching `kscan-oc04-*` name before removing that owned container. Never remove unrelated Docker/Supabase containers.
