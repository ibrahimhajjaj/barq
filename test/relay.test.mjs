// Offline tests: the relay shares one debugging connection to a running browser between clients.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { findEndpoint } from "../src/browsers.mjs";
import { startRelay, relayEndpoint, stateFile } from "../src/relay.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const tmp = () => mkdtempSync(join(tmpdir(), "barq-relay-"));
const cleanups = [];
after(async () => { for (const f of cleanups.reverse()) await f(); });

async function startBrowser() {
  const dir = tmp();
  const proc = spawn(chromium.executablePath(), ["--headless=new", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(join(dir, "DevToolsActivePort")); i++) await sleep(100);
  await sleep(300);
  const exited = new Promise(r => proc.once("exit", r));
  const stop = async () => { if (proc.exitCode === null) { proc.kill(); await exited; } rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); };
  cleanups.push(stop);
  return { dir, proc, exited, stop, ws: (await findEndpoint(dir)).ws };
}

// A raw client: the reply to one command, or the HTTP status the relay refused it with.
function raw(url, msg, headers = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (req, res) => resolve({ status: res.statusCode }));
    ws.once("error", () => resolve({ status: "error" }));
    ws.once("open", () => ws.send(JSON.stringify(msg)));
    ws.once("message", d => { resolve(JSON.parse(d)); ws.close(); });
  });
}

test("several clients share one connection, each with its own sessions, and come and go freely", async () => {
  const br = await startBrowser();
  const relay = await startRelay(br.ws);
  cleanups.push(() => relay.close());
  const a = await chromium.connectOverCDP(relay.url, { noDefaults: true });
  const b = await chromium.connectOverCDP(relay.url, { noDefaults: true });
  const pa = await a.contexts()[0].newPage(), pb = await b.contexts()[0].newPage();
  await pa.goto("data:text/html,<title>A</title>"); await pb.goto("data:text/html,<title>B</title>");
  assert.equal(await pa.evaluate(() => document.title), "A");
  assert.equal(await pb.evaluate(() => document.title), "B");
  // a client leaving takes its sessions with it, not the other client's
  await a.close();
  assert.equal(await pb.evaluate(() => 1 + 1), 2);
  // new tabs aren't left paused by a client that left
  const c = await chromium.connectOverCDP(relay.url, { noDefaults: true });
  const pc = await c.contexts()[0].newPage();
  await pc.goto("data:text/html,<title>C</title>");
  assert.equal(await pc.title(), "C");
  assert.equal(relay.clients.size, 2);
  await b.close(); await c.close();
  assert.equal(br.proc.exitCode, null, "the browser is still running");
});

test("the relay refuses web pages and callers without its token, and never closes the browser", async () => {
  const br = await startBrowser();
  const relay = await startRelay(br.ws);
  cleanups.push(() => relay.close());
  const base = relay.url.replace(/\/[^/]+$/, "");
  assert.equal((await raw(`${base}/wrong`, { id: 1, method: "Browser.getVersion" })).status, 403);
  assert.equal((await raw(relay.url, { id: 1, method: "Browser.getVersion" }, { Origin: "https://evil.example" })).status, 403);
  assert.match((await raw(relay.url, { id: 7, method: "Browser.getVersion" })).result.product, /Chrome/);
  assert.equal((await raw(relay.url, { id: 2, method: "Target.getTargets", sessionId: "not-mine" })).error.code, -32001);
  // nonsense is ignored, and the relay keeps serving
  for (const junk of ["null", "[]", "42", '{"id":"x","method":"Browser.getVersion"}', '{"id":1}', '{"id":1,"method":"Browser.getVersion","sessionId":7}']) {
    await new Promise(resolve => { const ws = new WebSocket(relay.url); ws.once("open", () => { ws.send(junk); setTimeout(() => { ws.close(); resolve(); }, 100); }); });
  }
  assert.match((await raw(relay.url, { id: 8, method: "Browser.getVersion" })).result.product, /Chrome/);
  assert.deepEqual(await raw(relay.url, { id: 3, method: "Browser.close" }), { id: 3, result: {} });
  assert.deepEqual(await raw(relay.url, { id: 4, method: "Browser.crash" }), { id: 4, result: {} });
  await sleep(500);
  assert.equal(br.proc.exitCode, null, "the browser is still running");
});

test("tabs a client opened and left open are closed when it goes; the user's stay", async () => {
  const br = await startBrowser();
  const relay = await startRelay(br.ws);
  cleanups.push(() => relay.close());
  const a = await chromium.connectOverCDP(relay.url, { noDefaults: true });
  const p = await a.contexts()[0].newPage();
  await p.goto("data:text/html,<title>left behind</title>");
  await p.evaluate(() => window.open("data:text/html,<title>its popup</title>"));
  await new Promise(r => setTimeout(r, 500));
  await a.close();   // gone without closing its tabs, as a killed server would
  const b = await chromium.connectOverCDP(relay.url, { noDefaults: true });
  let titles = [];
  for (let i = 0; i < 30; i++) {
    titles = await Promise.all(b.contexts()[0].pages().map(q => q.title().catch(() => "")));
    if (!titles.includes("left behind") && !titles.includes("its popup")) break;
    await sleep(100);
  }
  assert.ok(!titles.includes("left behind") && !titles.includes("its popup"), `still open: ${titles}`);
  assert.ok(b.contexts()[0].pages().some(q => q.url() === "about:blank"), "the user's own tab is untouched");
  await b.close();
});

test("the relay goes away with the browser", async () => {
  const br = await startBrowser();
  let exited = false;
  await startRelay(br.ws, { onExit: () => { exited = true; } });
  br.proc.kill(); await br.exited;
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  assert.ok(exited);
});

test("relayEndpoint starts one relay per browser run and hands every caller the same one", async () => {
  const br = await startBrowser();
  const dir = tmp();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const [u1, u2] = await Promise.all([relayEndpoint(br.ws, { dir, timeoutMs: 20_000 }), relayEndpoint(br.ws, { dir, timeoutMs: 20_000 })]);
  assert.ok(u1?.startsWith("ws://127.0.0.1:"));
  assert.equal(u1, u2);
  const file = stateFile(br.ws, dir);
  assert.equal(statSync(file).mode & 0o077, 0, "only this user can read the token");
  const { pid } = JSON.parse(readFileSync(file, "utf8"));
  cleanups.push(() => { try { process.kill(pid); } catch {} });
  const p = await (await chromium.connectOverCDP(u1, { noDefaults: true })).contexts()[0].newPage();
  await p.goto("data:text/html,<title>via relay</title>");
  assert.equal(await p.title(), "via relay");
  await p.context().browser().close();
  assert.equal(await relayEndpoint(br.ws, { dir }), u1);
  assert.match(readFileSync(join(dir, "relay.log"), "utf8"), /allowed; serving/, "it says what it did");
  // the relay leaves with the browser, and its file with it
  br.proc.kill(); await br.exited;
  for (let i = 0; i < 50 && existsSync(file); i++) await sleep(100);
  assert.ok(!existsSync(file));
});
