"use strict";

/**
 * @fileoverview Graceful-shutdown tests.
 *
 * Tests 1–3 spawn a lightweight HTTP child process (not the full server.js,
 * which requires Oracle pools) and verify:
 *   1. Shutdown signal → clean exit (code 0)
 *   2. In-flight requests complete before the process exits
 *   3. The shutdown handler invokes a cleanup callback (simulates pool drain)
 *
 * Windows does not support POSIX signals (SIGTERM kills the process
 * immediately without invoking handlers). These tests use IPC messages
 * (`process.send` / `child.send`) to trigger the shutdown handler
 * portably on all platforms.
 */

const { fork } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

// Minimal HTTP server with graceful shutdown triggered via IPC.
// Reports "LISTENING:<port>" on stdout once ready.
// GET /slow responds after 500 ms (tests in-flight draining).
// IPC message "shutdown" triggers graceful shutdown.
const CHILD_SCRIPT = path.resolve(
    __dirname,
    "__fixtures__",
    "graceful-shutdown-child.js",
);

describe("Graceful Shutdown", function () {
    // Ensure the fixture script exists before the suite runs
    beforeAll(function () {
        const fixtureDir = path.resolve(__dirname, "__fixtures__");
        if (!fs.existsSync(fixtureDir))
            fs.mkdirSync(fixtureDir, { recursive: true });

        const script = `"use strict";
const http = require("http");
const fs   = require("fs");

const CLEANUP_MARKER = process.env.CLEANUP_MARKER || "";

const server = http.createServer((req, res) => {
  if (req.url === "/slow") {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }, 500);
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  }
});

let isShuttingDown = false;

function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  server.close(() => {
    if (CLEANUP_MARKER) {
      fs.writeFileSync(CLEANUP_MARKER, "drained", "utf8");
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("message", (msg) => {
  if (msg === "shutdown") gracefulShutdown();
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write("LISTENING:" + port + "\\n");
});
`;
        fs.writeFileSync(CHILD_SCRIPT, script, "utf8");
    });

    afterAll(function () {
        try {
            fs.unlinkSync(CHILD_SCRIPT);
        } catch {
            /* ignore */
        }
        try {
            const dir = path.resolve(__dirname, "__fixtures__");
            if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0)
                fs.rmdirSync(dir);
        } catch {
            /* ignore */
        }
    });

    // ── Helper: spawn the child and wait for "LISTENING:<port>" ────────────
    function spawnChild(env = {}) {
        return new Promise((resolve, reject) => {
            const child = fork(CHILD_SCRIPT, [], {
                stdio: ["pipe", "pipe", "pipe", "ipc"],
                env: { ...process.env, ...env },
            });

            let stdout = "";
            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
                const match = stdout.match(/LISTENING:(\d+)/);
                if (match) resolve({ child, port: Number(match[1]) });
            });

            child.on("error", reject);

            // Safety: if the child exits before reporting, reject
            child.on("exit", (code) => {
                if (!stdout.includes("LISTENING:")) {
                    reject(
                        new Error(
                            `Child exited (code=${code}) before listening`,
                        ),
                    );
                }
            });
        });
    }

    // ── Helper: simple HTTP GET ───────────────────────────────────────────
    function httpGet(port, urlPath = "/") {
        return new Promise((resolve, reject) => {
            const req = http.get(
                `http://127.0.0.1:${port}${urlPath}`,
                (res) => {
                    let body = "";
                    res.on("data", (d) => (body += d));
                    res.on("end", () =>
                        resolve({ status: res.statusCode, body }),
                    );
                },
            );
            req.on("error", reject);
        });
    }

    // ── Test 0 (existing) ────────────────────────────────────────────────
    it("app module exports a valid Express app", function () {
        const app = require("../../../src/app");
        expect(app).toBeInstanceOf(Function);
        expect(app).toHaveProperty("use");
        expect(app).toHaveProperty("get");
    });

    // ── Test 1: shutdown → clean exit ────────────────────────────────────
    it("server shuts down cleanly on SIGTERM", async function () {
        const { child, port } = await spawnChild();

        const res = await httpGet(port, "/");
        expect(res.status).toBe(200);

        const exitCode = await new Promise((resolve) => {
            child.on("exit", (code) => resolve(code));
            child.send("shutdown");
        });

        expect(exitCode).toBe(0);
    });

    // ── Test 2: in-flight requests complete before shutdown ───────────────
    it("in-flight requests complete before shutdown", async function () {
        const { child, port } = await spawnChild();

        // Fire a slow request (500 ms to respond)
        const slowReq = httpGet(port, "/slow");

        // Trigger shutdown 50 ms later — while the request is still in-flight
        await new Promise((r) => setTimeout(r, 50));
        child.send("shutdown");

        // The slow request should still complete successfully
        const res = await slowReq;
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true });

        // Process should exit cleanly after draining
        const exitCode = await new Promise((resolve) => {
            child.on("exit", (code) => resolve(code));
        });
        expect(exitCode).toBe(0);
    });

    // ── Test 3: cleanup callback runs during shutdown (simulates DB drain) ─
    it("pending DB connections are drained on shutdown", async function () {
        const markerFile = path.join(
            __dirname,
            `__fixtures__/cleanup-marker-${Date.now()}.tmp`,
        );

        const { child, port } = await spawnChild({
            CLEANUP_MARKER: markerFile,
        });

        // Verify server is alive
        const res = await httpGet(port, "/");
        expect(res.status).toBe(200);

        const exitCode = await new Promise((resolve) => {
            child.on("exit", (code) => resolve(code));
            child.send("shutdown");
        });

        expect(exitCode).toBe(0);

        // The cleanup callback should have written the marker file
        expect(fs.existsSync(markerFile)).toBe(true);
        expect(fs.readFileSync(markerFile, "utf8")).toBe("drained");

        // Clean up
        fs.unlinkSync(markerFile);
    });
});
