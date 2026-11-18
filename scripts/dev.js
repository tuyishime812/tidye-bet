#!/usr/bin/env node
/**
 * One-command local development launcher.
 *
 * Why this exists
 * ---------------
 * Create React App falls back to `choosePort()` when its preferred port is in
 * use. That fallback is an interactive `prompts` confirm prompt, and
 * prompts@2.4.2 dereferences `c.toLowerCase()` in ConfirmPrompt#_ without
 * checking for a missing character. On current Node versions (>= 22) pressing
 * Enter at that prompt passes `undefined`, so the process dies with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'toLowerCase')
 *
 * Picking a free port *before* CRA boots avoids that code path entirely. This
 * launcher also starts the API server and points the web build at it, so the
 * football markets and the Aviator socket work from a single command:
 *
 *   npm start
 *
 * Environment overrides:
 *   PORT           preferred web port (default 3000)
 *   API_PORT       preferred API port (default 5001)
 *   REACT_APP_API_URL  reuse an already-running API instead of starting one
 */

const net = require("net");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "server");
const CLIENT_ENTRY = require.resolve("react-app-rewired/scripts/start.js");

const children = [];
let shuttingDown = false;

/** True when a TCP connection to host:port succeeds (i.e. something is there). */
function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };

    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** True when a listener can bind `port` on `host`. */
function canBind(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen({ port, host, exclusive: true });
  });
}

/**
 * Resolve true only when nothing is listening on `port`.
 *
 * A bind test alone is not enough on Windows: an IPv6 listener on `::` can
 * coexist with an IPv4 bind on `0.0.0.0`, so the port looks free while
 * `http://localhost:3000` still resolves (via ::1) to the other application.
 * We therefore probe real connections on both loopback stacks first, then
 * confirm with bind tests on the wildcard addresses CRA would use.
 */
async function isPortFree(port) {
  if (await canConnect(port, "127.0.0.1")) return false;
  if (await canConnect(port, "::1")) return false;

  const v4 = await canBind(port, "0.0.0.0");
  if (!v4) return false;

  return canBind(port, "::");
}

/** Try `start`, `start+1`, ... up to `attempts` ports. */
async function findFreePort(start, attempts = 25) {
  for (let port = start; port < start + attempts; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port between ${start} and ${start + attempts - 1}`);
}

/** True when an Aviator API is already answering /api/health on `port`. */
function isApiHealthy(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          if (body.length < 2048) body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body).status === "ok");
          } catch (error) {
            resolve(false);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function start(name, args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: "inherit",
    // No shell: avoids quoting/injection issues and keeps Ctrl+C in one process
    // group so npm can shut the whole tree down.
    windowsHide: false,
  });

  child.on("error", (error) => {
    console.error(`\n[dev] Failed to start ${name}: ${error.message}\n`);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      console.log(`\n[dev] ${name} stopped (${signal}).`);
    } else if (code !== 0) {
      console.error(`\n[dev] ${name} exited with code ${code}.`);
    }
    shutdown(code == null ? 1 : code);
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill();
      } catch (error) {
        /* already gone */
      }
    }
  }

  // Give children a moment to flush, then exit.
  setTimeout(() => process.exit(code), 300).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  const apiPort = Number(process.env.API_PORT) || 5001;

  // Prefer an API supplied explicitly by the developer (e.g. a LAN address).
  if (process.env.REACT_APP_API_URL) {
    console.log(`[dev] Using externally configured API: ${process.env.REACT_APP_API_URL}`);
  } else if (await isApiHealthy(apiPort)) {
    console.log(`[dev] Reusing API already running on port ${apiPort}`);
  } else if (!(await isPortFree(apiPort))) {
    // Something owns the port but is not our API. Do not silently start a
    // second server on a different port: SQLite-less memory mode would split
    // balances across two processes.
    console.error(
      `\n[dev] Port ${apiPort} is in use but /api/health did not answer.\n` +
        `      Stop that process, or set API_PORT=<free port> and retry.\n`
    );
    process.exit(1);
  } else {
    console.log(`[dev] Starting API on http://localhost:${apiPort}`);
    start("api server", ["index.js"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: String(apiPort) },
    });
  }

  const apiUrl = process.env.REACT_APP_API_URL || `http://localhost:${apiPort}`;

  const preferredWeb = Number(process.env.PORT) || 3000;
  const webPort = await findFreePort(preferredWeb);

  if (webPort !== preferredWeb) {
    console.log(
      `[dev] Port ${preferredWeb} is busy (likely another project) - ` +
        `starting the web app on ${webPort} instead.`
    );
  }

  console.log(
    `[dev] Starting web app on http://localhost:${webPort} ` +
      `(API: ${apiUrl})\n`
  );

  start("web app", [CLIENT_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(webPort),
      REACT_APP_API_URL: apiUrl,
      // CRA should never reach its interactive port prompt again, but if the
      // port is taken between our probe and boot, fail clearly instead of
      // crashing inside prompts.
      CI: process.env.CI || "",
    },
  });
}

main().catch((error) => {
  console.error(`\n[dev] ${error.message}\n`);
  shutdown(1);
});
