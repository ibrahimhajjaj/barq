// Offline tests: finding a running browser, attaching to it, and the helper extension's tab
// groups. Attach tests start Chrome for Testing headless with a throwaway profile.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WebSocket } from "ws";   // node 20 has no global one
import { findEndpoint, userDataDir, inspectPage, readActivePort, projectLabel, browserConfig, AttachedBrowser, ownBrowser, ownProfileDir, remoteDebuggingEnabled, HELPER_EXTENSION_ID, HELPER_VERSION } from "../src/browsers.mjs";
import { Barq } from "../src/session.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const tmp = () => mkdtempSync(join(tmpdir(), "barq-test-"));
// the browser may still be writing in there; a folder left in /tmp beats a failed cleanup
const scrub = d => { try { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} };
// the relays these tests start keep their state and log here, not in the user's own folder
process.env.BARQ_STATE_DIR = tmp();
// polls until check() returns something truthy, for state that settles asynchronously
async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) { if ((last = await check())) return last; await sleep(100); }
  return last;
}

test("user-data directories resolve per platform", () => {
  assert.equal(userDataDir("edge", { platform: "darwin", home: "/Users/u" }), "/Users/u/Library/Application Support/Microsoft Edge");
  assert.equal(userDataDir("chrome", { platform: "linux", home: "/home/u", configHome: "" }), "/home/u/.config/google-chrome");
  assert.equal(userDataDir("edge", { platform: "linux", home: "/home/u", configHome: "/cfg" }), "/cfg/microsoft-edge");
  assert.equal(userDataDir("brave", { platform: "win32", localAppData: "C:/Users/u/AppData/Local" }), join("C:/Users/u/AppData/Local", "BraveSoftware/Brave-Browser/User Data"));
  assert.equal(userDataDir("netscape", { platform: "darwin" }), null);
  assert.equal(inspectPage("edge"), "edge://inspect/#remote-debugging");
  assert.equal(inspectPage("chrome"), "chrome://inspect/#remote-debugging");
});

test("findEndpoint reads DevToolsActivePort and ignores a stale one", async () => {
  const dir = tmp();
  // a port that is open but says nothing back, the way a browser that was replaced on it leaves it
  const quiet = new Set();
  const srv = net.createServer(s => { quiet.add(s); s.on("close", () => quiet.delete(s)); }).listen(0);
  await new Promise(r => srv.once("listening", r));
  writeFileSync(join(dir, "DevToolsActivePort"), `${srv.address().port}\n/devtools/browser/abc\n`);
  assert.equal((await findEndpoint(dir)).ws, `ws://127.0.0.1:${srv.address().port}/devtools/browser/abc`);
  for (const s of quiet) s.destroy();
  srv.close();
  await new Promise(r => srv.once("close", r));
  await assert.rejects(findEndpoint(dir), /remote debugging/);
  await assert.rejects(findEndpoint("netscape"), /Unknown browser/);
  assert.equal((await findEndpoint("ws://127.0.0.1:1/devtools/browser/x")).ws, "ws://127.0.0.1:1/devtools/browser/x");
  scrub(dir);
});

test("the remote debugging box is read from the browser's own record of it", () => {
  const dir = tmp();
  assert.equal(remoteDebuggingEnabled(dir), null, "a browser that was never asked says nothing");
  writeFileSync(join(dir, "Local State"), JSON.stringify({ devtools: { remote_debugging: { "user-enabled": true } } }));
  assert.equal(remoteDebuggingEnabled(dir), true);
  writeFileSync(join(dir, "Local State"), JSON.stringify({ devtools: { remote_debugging: { "user-enabled": false } } }));
  assert.equal(remoteDebuggingEnabled(dir), false);
  writeFileSync(join(dir, "Local State"), "{ not json");
  assert.equal(remoteDebuggingEnabled(dir), null);
  scrub(dir);
});

test("findEndpoint believes the browser over a stale path beside the port", async () => {
  const dir = tmp();
  const live = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/json/version" ? { webSocketDebuggerUrl: `ws://127.0.0.1:${live.address().port}/devtools/browser/live` } : {}));
  });
  await new Promise(r => live.listen(0, "127.0.0.1", r));
  const port = live.address().port;
  writeFileSync(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/from-a-browser-that-has-gone\n`);
  assert.equal((await findEndpoint(dir)).ws, `ws://127.0.0.1:${port}/devtools/browser/live`);
  live.close();
  scrub(dir);
});

test("barq's own browser starts once and is found again after that", async () => {
  const dir = tmp();
  let browser;
  try {
    const first = await ownBrowser({ dir, binary: chromium.executablePath(), args: ["--headless=new", "--no-sandbox"] });
    assert.match(first.ws, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    assert.equal(first.name, "barq");
    // no prompt to answer on a profile nothing else has open: the connection just opens
    browser = await chromium.connectOverCDP(first.ws, { noDefaults: true });
    assert.ok(browser.isConnected());
    const again = await ownBrowser({ dir, binary: "/nonexistent", args: ["--headless=new"] });
    assert.equal(again.ws, first.ws, "the second call finds the browser the first one started");
  } finally {
    await browser?.close().catch(() => {});
    const active = readActivePort(dir);
    if (active) await fetch(`http://127.0.0.1:${active.port}/json/version`).then(async r => {
      const ws = new WebSocket((await r.json()).webSocketDebuggerUrl);
      await new Promise(done => { ws.once("open", () => { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); setTimeout(done, 500); }); ws.once("error", done); });
      ws.close();
    }).catch(() => {});
    await sleep(500);
    scrub(dir);
  }
});

test("its profile sits where the platform keeps application data", () => {
  assert.equal(ownProfileDir({ platform: "darwin", env: {}, home: "/Users/u" }), "/Users/u/Library/Application Support/barq/browser");
  assert.equal(ownProfileDir({ platform: "linux", env: {}, home: "/home/u" }), "/home/u/.local/share/barq/browser");
  assert.equal(ownProfileDir({ platform: "win32", env: { LOCALAPPDATA: "C:/Users/u/AppData/Local" } }), join("C:/Users/u/AppData/Local", "barq", "browser"));
  assert.equal(ownProfileDir({ platform: "darwin", env: { BARQ_OWN_PROFILE: "/tmp/p" } }), "/tmp/p");
});

// A running browser with remote debugging on, as the user would have it.
async function startBrowser({ extension = false, args: extra = [] } = {}) {
  const ext = typeof extension === "string" ? extension : EXTENSION;
  const dir = tmp();
  const args = ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--headless=new", "--no-sandbox", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", ...extra];
  if (extension) args.push(`--load-extension=${ext}`, `--disable-extensions-except=${ext}`);
  const proc = spawn(chromium.executablePath(), [...args, "data:text/html,<title>user tab</title>the user's own tab"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(join(dir, "DevToolsActivePort")); i++) await sleep(100);
  await sleep(300);
  const exited = new Promise(r => proc.once("exit", r));
  const stop = async () => {
    proc.kill();
    // A hung browser must not leave the test runner waiting forever on cleanup.
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    try { await exited; } finally { clearTimeout(timer); }
    scrub(dir);
  };
  return { dir, proc, alive: () => proc.exitCode === null && !proc.killed, stop };
}

// The browser's targets as its DevTools endpoint lists them, without attaching anything.
async function fetchTargets(dir) {
  const { port } = readActivePort(dir);
  return fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
}

// The browser window a tab sits in.
// The user's own tab, seen the way the user's browser has it: through a connection of its own,
// since barq's connection is never shown tabs that were open before it came.
async function userTab(chrome) {
  const b = await chromium.connectOverCDP((await findEndpoint(chrome.dir)).ws, { noDefaults: true });
  return { page: b.contexts()[0].pages().find(p => p.url().startsWith("data:")), done: () => b.close() };
}

async function windowOf(page) {
  const s = await page.context().newCDPSession(page);
  const { targetInfo } = await s.send("Target.getTargetInfo");
  await s.detach();
  const b = await page.context().browser().newBrowserCDPSession();
  const { windowId } = await b.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
  await b.detach();
  return windowId;
}

let server, base;
before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url.startsWith("/popup") ? "<title>popup</title>popup" : `<title>agent</title><a id=l href="/popup" target=_blank>new tab</a>`);
  });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("attached: tabs go in a group, a popup joins it and the user keeps their tab", async () => {
  const chrome = await startBrowser({ extension: true });
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    const jb = await Barq.forPage(await host.newTab({ session: "main" }));
    await jb.open(`${base}/agent`);
    await jb.page.click("#l");
    await jb.settle();
    assert.equal(new URL(jb.page.url()).pathname, "/popup", "the session follows the new tab");
    const sw = await host.helper();
    const query = () => sw.evaluate(() => chrome.tabs.query({}).then(ts => ts.map(t => ({ url: t.url, active: t.active, group: t.groupId }))));
    const tabs = await until(async () => { const ts = await query(); return ts.find(t => t.url.startsWith("data:"))?.active && ts; }) ?? await query();
    const user = tabs.find(t => t.url.startsWith("data:"));
    const agent = tabs.filter(t => t.url.startsWith(base));
    assert.equal(user.active, true, "the user's tab is still in front");
    assert.equal(agent.length, 2);
    assert.ok(agent.every(t => t.group !== -1 && t.group === agent[0].group), "both agent tabs share one group");
    const [group] = await until(() => sw.evaluate(() => chrome.tabGroups.query({ collapsed: true })).then(gs => gs.length && gs)) ?? await sw.evaluate(() => chrome.tabGroups.query({}));
    assert.equal(group.title, "Agent");
    assert.equal(group.collapsed, true);

    // a second session of the same agent joins the same group, it doesn't start another
    const other = await host.newTab({ session: "research" });
    const groups = await sw.evaluate(() => chrome.tabGroups.query({}).then(gs => Promise.all(gs.map(async g => ({ title: g.title, tabs: (await chrome.tabs.query({ groupId: g.id })).length })))));
    assert.deepEqual(groups, [{ title: "Agent", tabs: 3 }]);
    await other.close();

    await jb.close();
    await host.dispose();
    assert.ok(chrome.alive(), "disposing disconnects without closing the user's browser");
  } finally { await chrome.stop(); }
});

test("groups are named after the agent's project; another agent gets its own, a reconnect does not", async () => {
  assert.equal(projectLabel("/home/u/work/shop"), "shop");
  assert.equal(projectLabel("/home/u", "/home/u"), undefined, "no project: the default name");
  assert.deepEqual(browserConfig({ BARQ_ATTACH: "edge", CLAUDE_PROJECT_DIR: "/w/jev" }, "/elsewhere").group, { title: "jev" });
  assert.deepEqual(browserConfig({ BARQ_ATTACH: "edge", BARQ_GROUP_TITLE: "Mine" }, "/w/jev").group, { title: "Mine" });

  const chrome = await startBrowser({ extension: true });
  try {
    const one = await AttachedBrowser.connect(chrome.dir, { group: { title: "shop" } });
    const two = await AttachedBrowser.connect(chrome.dir, { group: { title: "blog" } });
    await one.newTab({ session: "main" }); await two.newTab({ session: "main" });
    const sw = await one.helper();
    const groups = await sw.evaluate(() => chrome.tabGroups.query({}).then(gs => gs.map(g => g.title).sort()));
    assert.deepEqual(groups, ["blog", "shop"], "two agents' main sessions don't share a group");

    // losing the browser and attaching again is the same agent: its tabs belong in the group it
    // already has, not in a second one beside it
    const again = await AttachedBrowser.connect(chrome.dir, { group: { title: "shop" } });
    await again.newTab({ session: "other" });
    const after = await sw.evaluate(() => chrome.tabGroups.query({}).then(gs => gs.map(g => g.title).sort()));
    assert.deepEqual(after, ["blog", "shop"], "reattaching started a second group");
    await again.dispose();
    await one.dispose(); await two.dispose();
  } finally { await chrome.stop(); }
});

test("front() puts an agent tab in front for a moment and gives the user their tab back", async () => {
  const chrome = await startBrowser({ extension: true });
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    const page = await host.newTab({ session: "main" });
    await page.goto(`${base}/agent`);
    const sw = await host.helper();
    const state = () => sw.evaluate(() => Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]).then(([ts, gs]) => ({
      front: ts.find(t => t.active)?.url, collapsed: gs[0]?.collapsed,
    })));
    await until(async () => (await state()).collapsed);
    const back = await host.front(page);
    assert.ok(back, "the helper can do it");
    assert.equal(new URL((await state()).front).pathname, "/agent", "the agent's tab is in front");
    await back();
    const after = await until(async () => { const s = await state(); return s.front.startsWith("data:") && s.collapsed && s; }) ?? await state();
    assert.ok(after.front.startsWith("data:"), "the user's tab is back in front");
    assert.equal(after.collapsed, true, "and the group folded up again");
    await host.dispose();
  } finally { await chrome.stop(); }
});

// A helper loaded unpacked doesn't update itself. (A browser that loaded it from the command line
// drops it on reload, so this runs against stand-ins for the browser.)
test("a helper from an older copy of the extension is reloaded, then woken by a tab opening", async () => {
  const worker = version => ({ url: () => `chrome-extension://${HELPER_EXTENSION_ID}/sw.js`, evaluate: async fn => {
    if (String(fn).includes("jevVersion")) return version;
    if (String(fn).includes("reload")) workers = workers.filter(w => w !== old);
  } });
  const old = worker("0.0.1"), fresh = worker(HELPER_VERSION), waiting = [], opened = [];
  let workers = [old];
  const host = Object.create(AttachedBrowser.prototype);
  host.context = { serviceWorkers: () => workers, waitForEvent: (e, { timeout }) => new Promise((resolve, reject) => { waiting.push(resolve); setTimeout(() => reject(new Error("timeout")), timeout); }) };
  host.cdp = Promise.resolve({ send: async (method, params) => {
    if (method === "Target.createTarget") { opened.push(params); workers.push(fresh); waiting.splice(0).forEach(r => r(fresh)); return { targetId: "t1" }; }
    if (method === "Target.closeTarget") opened.push("closed");
    return {};
  } });
  assert.equal(await host.helper(1000), fresh);
  assert.deepEqual(opened, [{ url: "about:blank", background: true }, "closed"], "one background tab, closed again");
  assert.equal(await host.helper(1000), fresh, "checked once per connection");
});

test("the tab that was in front comes back, and does so by itself if nobody says done", async () => {
  const chrome = await startBrowser({ extension: true });
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    const page = await host.newTab({ session: "main" });
    await page.goto(`${base}/agent`);
    const sw = await host.helper();
    // the user has two tabs and is on the second
    const second = await sw.evaluate(() => chrome.tabs.create({ url: "data:text/html,<title>second</title>", active: true }).then(t => t.id));
    const front = () => sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t.id));
    await until(async () => (await front()) === second);
    const back = await host.front(page);
    assert.notEqual(await front(), second);
    await back();
    assert.equal(await until(async () => (await front()) === second && second), second, "exactly the tab that was in front");
    // no back(): the helper's lease brings it back
    const agentTab = await sw.evaluate(url => self.jevFindTab(url), page.url());
    await sw.evaluate(id => self.jevFront(id, 800), agentTab);
    assert.notEqual(await front(), second);
    assert.equal(await until(async () => (await front()) === second && second, 5000), second, "restored by the lease");
    await host.dispose();
  } finally { await chrome.stop(); }
});

test("attached without the helper: auto falls back to a separate window", async () => {
  const chrome = await startBrowser();
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    const page = await host.newTab();
    const user = await userTab(chrome);
    assert.notEqual(await windowOf(page), await windowOf(user.page), "the agent's tab is in a window of its own");
    await user.done();
    await page.goto(`${base}/agent`);
    assert.equal(await page.title(), "agent");
    await assert.rejects(new AttachedBrowser(host.browser, host.endpoint, { placement: "group" }).newTab(), /helper extension/);
    await host.dispose();
    assert.ok(chrome.alive());
  } finally { await chrome.stop(); }
});

test("a popup window an agent tab opens is minimized; the user's window never is", async () => {
  const chrome = await startBrowser();
  try {
    const host = await AttachedBrowser.connect(chrome.dir, { placement: "tab" });
    const page = await host.newTab();
    await page.goto(`${base}/agent`);
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate(url => window.open(url, "signin", "width=420,height=360"), `${base}/popup`)]);
    const state = async p => {
      const b = await p.context().browser().newBrowserCDPSession();
      try { return (await b.send("Browser.getWindowBounds", { windowId: await windowOf(p) })).bounds.windowState; } finally { await b.detach(); }
    };
    assert.equal(await until(async () => (await state(popup)) === "minimized" && "minimized"), "minimized");
    const user = await userTab(chrome);
    assert.notEqual(await state(user.page), "minimized");
    await user.done();
    assert.equal(await state(page), "normal", "a background tab in the user's window leaves that window alone");
    await host.dispose();
  } finally { await chrome.stop(); }
});

test("a tab of the user's own stays out of barq's sight, and keeps its own colour scheme and dialogs", async () => {
  const chrome = await startBrowser({ args: ["--force-dark-mode"] });
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    // The user opens a tab while barq is connected, through a bare protocol call of its own: a
    // second automation client, which is what the user's browser is to barq.
    const { port, path } = readActivePort(chrome.dir);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const ask = (id, method, params, sessionId) => new Promise(resolve => {
      const on = e => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener("message", on); resolve(m); } };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { result: made } = await ask(1, "Target.createTarget", { url: "data:text/html,<title>later</title>the user's later tab" });
    const { result: att } = await ask(2, "Target.attachToTarget", { targetId: made.targetId, flatten: true });
    const session = att.sessionId;

    await sleep(1000);
    assert.equal(host.context.pages().find(p => p.url().includes("later")), undefined, "the user's tab is not barq's to see");

    // and because it is not barq's, nothing barq does reaches it: it keeps the dark scheme the
    // browser was started with, and a confirm() in it waits for the user rather than being answered
    const dark = await ask(3, "Runtime.evaluate", { expression: `matchMedia("(prefers-color-scheme: dark)").matches`, returnByValue: true }, session);
    assert.equal(dark.result.result.value, true, "no forced light scheme");

    await ask(4, "Runtime.evaluate", { expression: `setTimeout(() => { window.answer = confirm("Discard changes?"); }, 0)` }, session);
    await sleep(800);
    // asking the tab anything now waits as long as the dialog does, which is the point: nobody
    // answered it for the user
    const answered = await Promise.race([
      ask(5, "Runtime.evaluate", { expression: `"answer" in window`, returnByValue: true }, session).then(r => r.result?.result?.value ?? false),
      sleep(1000).then(() => "still waiting"),
    ]);
    assert.equal(answered, "still waiting", "the dialog was answered for the user");

    // let the tab go from the browser, not from inside it: the open confirm() holds its renderer,
    // so anything asked of that session would wait as long as the dialog does
    await ask(6, "Target.closeTarget", { targetId: made.targetId });
    ws.close();
    await host.dispose();
  } finally { await chrome.stop(); }
});

test("a stopped helper worker is woken by the agent's new tab", async () => {
  const chrome = await startBrowser({ extension: true });
  try {
    let host = await AttachedBrowser.connect(chrome.dir);
    const worker = await host.helper();
    assert.ok(worker);
    // stop it the way the browser does when a worker sits idle; a stray tab event can wake it
    // again straight away, so repeat until it stays down
    const user = await userTab(chrome);
    const cdp = await user.page.context().newCDPSession(user.page);
    await cdp.send("ServiceWorker.enable");
    const running = async () => (await fetchTargets(chrome.dir)).some(t => t.type === "service_worker" && t.url.includes(HELPER_EXTENSION_ID));
    const stopped = await until(async () => { await cdp.send("ServiceWorker.stopAllWorkers"); await sleep(300); return !(await running()); }, 10_000);
    await cdp.detach(); await user.done();
    await host.dispose();
    assert.ok(stopped, "the worker was stopped before the next connection");
    host = await AttachedBrowser.connect(chrome.dir);
    const page = await host.newTab();
    const grouped = await (await host.helper()).evaluate(() => chrome.tabs.query({}).then(ts => ts.some(t => t.url.startsWith("about:blank#jev-") && t.groupId !== -1)));
    assert.equal(grouped, true);
    await page.close();
    await host.dispose();
  } finally { await chrome.stop(); }
});
