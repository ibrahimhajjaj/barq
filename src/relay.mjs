// Keeps one approved debugging connection to the user's browser and shares it.
//
// A browser whose remote debugging was switched on from its inspect page asks the user to allow
// every new connection, so each server start (a new agent session, a reload) meant another prompt.
// The relay is a small process of its own that makes the one connection and outlives the servers:
// one prompt per browser run. It listens on 127.0.0.1 behind a random token kept in a file only this
// user can read, refuses connections from web pages, and gives each client its own browser-level
// session on the shared connection, so clients only ever see the sessions they opened. A client
// can't close the user's browser through it. It exits when the browser goes away, or after `idle`
// with no client connected.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const IDLE_MS = Number(process.env.JEV_BROWSER_RELAY_IDLE_MIN ?? 60) * 60_000;
const MAX_MESSAGE = 512 * 1024 * 1024;   // screenshots and page captures can be large

export function stateDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "jev-browser");
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "jev-browser");
  return path.join(env.XDG_RUNTIME_DIR || env.XDG_CACHE_HOME || path.join(home, ".cache"), "jev-browser");
}

// One file per browser run: the browser's endpoint changes every time it starts.
export function stateFile(upstream, dir = stateDir()) {
  return path.join(dir, `relay-${crypto.createHash("sha256").update(upstream).digest("hex").slice(0, 16)}.json`);
}

// The user may take a while to answer the browser's prompt; giving up early would only raise
// a fresh prompt on the next try.
const ANSWER_MS = 10 * 60_000;

// Serve `upstream` (the browser's ws:// endpoint). Resolves once connected and listening, with
// { url, close }; rejects when the browser refuses or the user doesn't allow the connection.

export async function startRelay(upstream, { idleMs = IDLE_MS, onExit = () => {} } = {}) {
  const up = new WebSocket(upstream, { perMessageDeflate: false, maxPayload: MAX_MESSAGE, handshakeTimeout: ANSWER_MS });
  await new Promise((resolve, reject) => {
    up.once("open", resolve);
    up.once("error", reject);
    up.once("unexpected-response", (req, res) => reject(new Error(`the browser answered ${res.statusCode}`)));
  });

  const token = crypto.randomBytes(24).toString("base64url");
  const clients = new Set();
  const owner = new Map();       // session id -> the client it belongs to
  const pending = new Map();     // upstream message id -> { client, id } or { resolve, reject }
  let nextId = 1, idleTimer, closed = false;
  const send = msg => { if (up.readyState === WebSocket.OPEN) up.send(JSON.stringify(msg)); };
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
  });
  const deliver = (c, msg) => {
    if (msg.sessionId === c.root) { msg = { ...msg }; delete msg.sessionId; }
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const idle = () => { clearTimeout(idleTimer); if (!clients.size) idleTimer = setTimeout(close, idleMs).unref?.() ?? idleTimer; };

  up.on("message", data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.id != null) {
      const p = pending.get(msg.id); if (!p) return;
      pending.delete(msg.id);
      if (p.resolve) return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      if (msg.result?.sessionId && /^Target\.attachTo/.test(p.method)) owner.set(msg.result.sessionId, p.client);
      return deliver(p.client, { ...msg, id: p.id });
    }
    const c = owner.get(msg.sessionId);
    if (!c) return;
    // sessions opened for a client (its tabs, their frames and workers) are that client's
    if (msg.method === "Target.attachedToTarget") owner.set(msg.params.sessionId, c);
    deliver(c, msg);
    if (msg.method === "Target.detachedFromTarget") owner.delete(msg.params.sessionId);
  });

  const server = http.createServer((req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE });
  server.on("upgrade", (req, socket, head) => {
    // web pages send an Origin; the token keeps other local programs out
    const ok = req.url === `/${token}` && !req.headers.origin && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "");
    if (!ok) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, ws => serve(ws));
  });

  function serve(ws) {
    const c = { ws, root: null };
    clients.add(c); idle();
    const ready = call("Target.attachToBrowserTarget").then(r => { c.root = r.sessionId; owner.set(c.root, c); });
    ready.catch(() => ws.close());
    ws.on("message", async data => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      await ready.catch(() => {});
      if (!c.root || ws.readyState !== WebSocket.OPEN) return;
      const sessionId = msg.sessionId ?? c.root;
      if (owner.get(sessionId) !== c) return deliver(c, { id: msg.id, sessionId: msg.sessionId, error: { code: -32001, message: "Session with given id not found." } });
      // the browser is the user's: a client may leave it, never close it
      if (msg.method === "Browser.close") { deliver(c, { id: msg.id, result: {} }); return ws.close(); }
      const id = nextId++;
      pending.set(id, { client: c, id: msg.id, method: msg.method });
      send({ ...msg, id, sessionId });
    });
    ws.on("close", () => {
      clients.delete(c);
      for (const [sid, o] of owner) if (o === c) owner.delete(sid);
      for (const [id, p] of pending) if (p.client === c) pending.delete(id);
      // the sessions it opened go with its browser-level one
      if (c.root) send({ id: nextId++, method: "Target.detachFromTarget", params: { sessionId: c.root } });
      idle();
    });
  }

  function close() {
    if (closed) return; closed = true;
    clearTimeout(idleTimer);
    for (const c of clients) c.ws.close();
    wss.close(); server.close(); up.close();
    onExit();
  }
  up.on("close", close);
  up.on("error", close);

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  idle();
  return { url: `ws://127.0.0.1:${server.address().port}/${token}`, close, clients };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// The endpoint to connect to for `upstream`: the running relay for this browser run, or a new one
// started for it (which is when the browser asks the user to allow the connection). A relay still
// waiting for that answer is waited for, never doubled, so a slow click never raises a second
// prompt. Throws with code RELAY_TIMEOUT when the answer doesn't come within `timeoutMs` (the
// relay keeps waiting for it), and RELAY_REFUSED when the browser refused.
export async function relayEndpoint(upstream, { timeoutMs = 120_000, dir = stateDir() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = stateFile(upstream, dir), lock = `${file}.lock`;
  const end = Date.now() + timeoutMs;
  let started = 0;
  while (Date.now() < end) {
    const s = readJson(file);
    if (s?.upstream === upstream && s.error) { fs.rmSync(file, { force: true }); throw Object.assign(new Error(s.error), { code: "RELAY_REFUSED" }); }
    if (s?.upstream === upstream && alive(s.pid)) {
      if (s.url) return s.url;
    } else if (started < 2) {
      // no relay for this browser run (or it died): start one; the lock keeps two servers from
      // starting two at once
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        try {
          fs.rmSync(file, { force: true });
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), upstream, file], { detached: true, stdio: "ignore" });
          child.unref(); started++;
          for (let i = 0; i < 50 && !readJson(file); i++) await sleep(100);
        } finally { fs.rmSync(lock, { force: true }); }
        continue;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // another server is starting it; a lock left by one that died is cleared
        const holder = Number(fs.readFileSync(lock, "utf8"));
        if (!alive(holder) || Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true });
      }
    }
    await sleep(200);
  }
  throw Object.assign(new Error("no answer to the browser's \"Allow remote debugging\" prompt yet"), { code: "RELAY_TIMEOUT" });
}

// node relay.mjs <upstream> <state file>
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [upstream, file] = process.argv.slice(2);
  const write = s => fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  const forget = () => { if (readJson(file)?.pid === process.pid) fs.rmSync(file, { force: true }); };
  // first a placeholder, so other servers wait for this relay instead of starting another
  write({ upstream, pid: process.pid });
  startRelay(upstream, { onExit: () => { forget(); process.exit(0); } })
    .then(r => write({ url: r.url, upstream, pid: process.pid }))
    .catch(e => { write({ error: `the browser didn't allow the connection: ${e.message}`, upstream, pid: process.pid }); setTimeout(() => process.exit(1), 5000); });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { forget(); process.exit(0); });
}
