// Disposable-test-only PostgreSQL wire proxy. It can drop one real COMMIT acknowledgement.
// No TLS, external address, credentials, SQL parameters or authentication packets are logged.
const net = require("node:net");
const assert = require("node:assert/strict");
async function createCommitProxy(upstreamPort) {
  assert.ok(Number.isInteger(upstreamPort) && upstreamPort > 0);
  let armedPid = null;
  let drops = 0;
  const sockets = new Set();
  const server = net.createServer((client) => {
    client.setNoDelay(true);
    const upstream = net.connect({ host: "127.0.0.1", port: upstreamPort });
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    const s = {
      pid: null,
      startup: false,
      frontend: Buffer.alloc(0),
      backend: Buffer.alloc(0),
      dropping: false,
      committed: false,
      held: [],
    };
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
    client.on("data", (data) => {
      s.frontend = Buffer.concat([s.frontend, data]);
      if (!s.startup && s.frontend.length >= 4) {
        const size = s.frontend.readInt32BE(0);
        if (size < 8 || size > 16 * 1024 * 1024) return end();
        if (s.frontend.length >= size) {
          s.frontend = s.frontend.subarray(size);
          s.startup = true;
        }
      }
      if (s.startup) {
        while (s.frontend.length >= 5) {
          const size = s.frontend.readInt32BE(1);
          if (size < 4 || size > 16 * 1024 * 1024) return end();
          if (s.frontend.length < size + 1) break;
          const frame = s.frontend.subarray(0, size + 1);
          s.frontend = s.frontend.subarray(size + 1);
          if (
            frame[0] === 81 &&
            frame.subarray(5).toString("utf8").replace(/\0$/, "").trim()
                .toUpperCase() === "COMMIT" &&
            s.pid === armedPid
          ) {
            armedPid = null;
            s.dropping = true;
          }
        }
      }
      upstream.write(data);
    });
    upstream.on("data", (data) => {
      s.backend = Buffer.concat([s.backend, data]);
      while (s.backend.length >= 5) {
        const size = s.backend.readInt32BE(1);
        if (size < 4 || size > 16 * 1024 * 1024) return end();
        if (s.backend.length < size + 1) break;
        const frame = s.backend.subarray(0, size + 1);
        s.backend = s.backend.subarray(size + 1);
        if (frame[0] === 75 && size === 12) s.pid = frame.readInt32BE(5);
        if (s.dropping) {
          s.held.push(frame);
          if (
            frame[0] === 67 && frame.subarray(5).toString("utf8") === "COMMIT\0"
          ) s.committed = true;
          if (frame[0] === 90) {
            if (s.committed) {
              drops++;
              return end();
            }
            for (const held of s.held) client.write(held);
            s.dropping = false;
            s.held = [];
          }
        } else client.write(frame);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    arm: (pid) => {
      assert.ok(Number.isInteger(pid));
      armedPid = pid;
    },
    get drops() {
      return drops;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
module.exports = { createCommitProxy };
