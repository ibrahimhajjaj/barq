// Keeps one approved debugging connection to the user's browser and shares it.
//
// A browser whose remote debugging was switched on from its inspect page asks the user to allow
// every new connection, so each server start (a new agent session, a reload) meant another prompt.
// The relay is a small process of its own that makes the one connection and outlives the servers:
// one prompt per browser run. It listens on 127.0.0.1 behind a random token kept in a file only this
// user can read, refuses connections from web pages, and gives each client its own browser-level
// session on the shared connection, so clients only ever see the sessions they opened. A client
// can't close the user's browser through it, and the tabs a client opened are closed when it goes
// away without closing them (a server that was killed). It exits when the browser goes away, or
// after `idle` with no client connected.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

// The browser shows its "controlled by automated software" bar while the connection is open, so it
// isn't kept for long once nobody uses it.
const IDLE_MS = Number(process.env.BARQ_RELAY_IDLE_MIN ?? 30) * 60_000;
const MAX_MESSAGE = 512 * 1024 * 1024;   // screenshots and page captures can be large

export function stateDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.BARQ_STATE_DIR) return env.BARQ_STATE_DIR;
  if (platform === "darwin") return path.join(home, "Library", "Caches", "barq");
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "barq");
  return path.join(env.XDG_RUNTIME_DIR || env.XDG_CACHE_HOME || path.join(home, ".cache"), "barq");
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

export async function startRelay(upstream, { idleMs = IDLE_MS, onExit = () => {}, log = () => {} } = {}) {
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
  const idle = () => { clearTimeout(idleTimer); if (!closed && !clients.size) idleTimer = setTimeout(() => close(`no client for ${Math.round(idleMs / 60_000)} min`), idleMs); };

  up.on("message", data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.id != null) {
      const p = pending.get(msg.id); if (!p) return;
      pending.delete(msg.id);
      if (p.resolve) return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      if (msg.result?.sessionId && /^Target\.attachTo/.test(p.method)) owner.set(msg.result.sessionId, p.client);
      if (msg.result?.targetId && p.method === "Target.createTarget") p.client.tabs.add(msg.result.targetId);
      if (p.method === "Target.getTargets" && Array.isArray(msg.result?.targetInfos)) msg = { ...msg, result: { ...msg.result, targetInfos: msg.result.targetInfos.filter(t => !p.client.hidden.has(t.targetId)) } };
      return deliver(p.client, { ...msg, id: p.id });
    }
    const c = owner.get(msg.sessionId);
    if (!c) return;
    // sessions opened for a client (its tabs, their frames and workers) are that client's
    const hid = msg.params?.targetInfo?.targetId ?? msg.params?.targetId;
    if (msg.sessionId === c.root && c.hidden.has(hid)) {
      // attached by the client's auto-attach: let it run on and let go of it, unseen
      if (msg.method === "Target.attachedToTarget") {
        const sid = msg.params.sessionId;
        if (msg.params.waitingForDebugger) send({ id: nextId++, method: "Runtime.runIfWaitingForDebugger", sessionId: sid });
        send({ id: nextId++, method: "Target.detachFromTarget", params: { sessionId: sid }, sessionId: c.root });
      }
      if (msg.method === "Target.targetDestroyed") c.hidden.delete(hid);
      return;
    }
    if (msg.method === "Target.attachedToTarget") {
      owner.set(msg.params.sessionId, c);
      // a tab one of its tabs opened is the client's too
      const t = msg.params.targetInfo;
      if (t?.type === "page" && c.tabs.has(t.openerId)) c.tabs.add(t.targetId);
    }
    if (msg.method === "Target.targetDestroyed") c.tabs.delete(msg.params.targetId);
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
    const c = { ws, root: null, tabs: new Set(), hidden: new Set() };
    clients.add(c); idle();
    log(`client connected (${clients.size} now)`);
    // The tabs open before a client came (the user's, another client's) stay out of its sight: it
    // never needs them, reading them isn't its business, and one the browser has put to sleep
    // would hold up its startup, which sets up every tab it's shown.
    const ready = call("Target.getTargets")
      .then(r => { for (const t of r.targetInfos) if (t.type === "page" || t.type === "background_page") c.hidden.add(t.targetId); })
      .then(() => call("Target.attachToBrowserTarget")).then(r => { c.root = r.sessionId; owner.set(c.root, c); });
    ready.catch(() => ws.close());
    ws.on("message", async data => {
      // one bad message from one client mustn't take the shared connection down with it
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string" || !Number.isSafeInteger(msg.id)
        || (msg.sessionId != null && typeof msg.sessionId !== "string")) return;
      await ready.catch(() => {});
      if (!c.root || ws.readyState !== WebSocket.OPEN) return;
      const sessionId = msg.sessionId ?? c.root;
      if (owner.get(sessionId) !== c) return deliver(c, { id: msg.id, sessionId: msg.sessionId, error: { code: -32001, message: "Session with given id not found." } });
      // the browser is the user's: a client may leave it, never close it
      if (msg.method === "Browser.close" || msg.method === "Browser.crash" || msg.method === "Browser.crashGpuProcess") { deliver(c, { id: msg.id, result: {} }); return ws.close(); }
      // nor reach, by name, a tab kept out of its sight
      if (/^Target\.(attachToTarget|closeTarget|activateTarget|exposeDevToolsProtocol)$/.test(msg.method) && c.hidden.has(msg.params?.targetId)) {
        return deliver(c, { id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: "No target with given id found" } });
      }
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
      // tabs it opened and never closed; closing one that is already gone just fails
      for (const targetId of c.tabs) send({ id: nextId++, method: "Target.closeTarget", params: { targetId } });
      log(`client left (${clients.size} now)${c.tabs.size ? `, closing ${c.tabs.size} tab(s) it left open` : ""}`);
      idle();
    });
  }

  function close(why) {
    if (closed) return; closed = true;
    log(`stopping: ${why}`);
    clearTimeout(idleTimer);
    // going away with clients still on it: their tabs go too, as when a client leaves by itself
    for (const c of clients) for (const targetId of c.tabs) send({ id: nextId++, method: "Target.closeTarget", params: { targetId } });
    // the relay is going away: its clients' sockets are cut, not asked to close politely
    for (const c of clients) c.ws.terminate();
    wss.close(); server.close(); up.close();
    onExit(why);
  }
  up.on("close", (code, reason) => close(`the browser closed the connection (${code}${reason?.length ? ` ${reason}` : ""})`));
  up.on("error", e => close(`connection error: ${e.message}`));

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
          // its log goes next to the state file, restarted once it passes 1 MB
          const logFile = path.join(dir, "relay.log");
          if ((fs.statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 1 << 20) fs.rmSync(logFile, { force: true });
          const out = fs.openSync(logFile, "a", 0o600);
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), upstream, file], { detached: true, stdio: ["ignore", out, out] });
          fs.closeSync(out);
          child.unref(); started++;
          for (let i = 0; i < 50 && !readJson(file); i++) await sleep(100);
        } finally { fs.rmSync(lock, { force: true }); }
        continue;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // another server is starting it; a lock left by one that died is cleared
        // (it can also have finished and removed the lock since: then just look again)
        try {
          const holder = Number(fs.readFileSync(lock, "utf8")), age = Date.now() - fs.statSync(lock).mtimeMs;
          if (!alive(holder) || age > 30_000) fs.rmSync(lock, { force: true });
        } catch (e2) { if (e2.code !== "ENOENT") throw e2; }
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
  const log = m => console.error(`${new Date().toISOString()} [${process.pid}] ${m}`);
  process.on("uncaughtException", e => { log(`crashed: ${e.stack}`); forget(); process.exit(1); });
  // first a placeholder, so other servers wait for this relay instead of starting another
  write({ upstream, pid: process.pid });
  log(`waiting for the browser to allow the connection (${upstream.replace(/\/devtools\/.*/, "")})`);
  let relay;
  // a moment for the last messages (closing clients' tabs) to reach the browser
  startRelay(upstream, { log, onExit: () => { forget(); setTimeout(() => process.exit(0), 300); } })
    .then(r => { relay = r; write({ url: r.url, upstream, pid: process.pid }); log("allowed; serving"); })
    .catch(e => { log(`not allowed: ${e.message}`); write({ error: `the browser didn't allow the connection: ${e.message}`, upstream, pid: process.pid }); setTimeout(() => process.exit(1), 5000); });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { if (relay) return relay.close(sig); log(`stopping: ${sig}`); forget(); process.exit(0); });
}
