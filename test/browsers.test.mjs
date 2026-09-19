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
import { findEndpoint, userDataDir, inspectPage, readActivePort, projectLabel, browserConfig, AttachedBrowser, HELPER_EXTENSION_ID, HELPER_VERSION } from "../src/browsers.mjs";
import { Barq } from "../src/session.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const tmp = () => mkdtempSync(join(tmpdir(), "barq-test-"));
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
  const srv = net.createServer().listen(0);
  await new Promise(r => srv.once("listening", r));
  writeFileSync(join(dir, "DevToolsActivePort"), `${srv.address().port}\n/devtools/browser/abc\n`);
  assert.equal((await findEndpoint(dir)).ws, `ws://127.0.0.1:${srv.address().port}/devtools/browser/abc`);
  srv.close();
  await new Promise(r => srv.once("close", r));
  await assert.rejects(findEndpoint(dir), /remote debugging/);
  await assert.rejects(findEndpoint("netscape"), /Unknown browser/);
  assert.equal((await findEndpoint("ws://127.0.0.1:1/devtools/browser/x")).ws, "ws://127.0.0.1:1/devtools/browser/x");
  rmSync(dir, { recursive: true, force: true });
});

// A running browser with remote debugging on, as the user would have it.
async function startBrowser({ extension = false, args: extra = [] } = {}) {
  const ext = typeof extension === "string" ? extension : EXTENSION;
  const dir = tmp();
  const args = ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--headless=new", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", ...extra];
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

    const other = await host.newTab({ session: "research" });
    const titles = await sw.evaluate(() => chrome.tabGroups.query({}).then(gs => gs.map(g => g.title).sort()));
    assert.deepEqual(titles, ["Agent", "Agent · research"]);
    await other.close();

    await jb.close();
    await host.dispose();
    assert.ok(chrome.alive(), "disposing disconnects without closing the user's browser");
  } finally { await chrome.stop(); }
});

test("groups are named after the agent's project; each connection keeps its own", async () => {
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

test("attaching leaves the user's tabs as they were: colour scheme, focus, and their own dialogs", async () => {
  const chrome = await startBrowser({ args: ["--force-dark-mode"] });
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    // a tab the user opens while barq is connected: barq sees it, and must leave it as it is
    // (opened with a bare protocol call: a second automation client would answer dialogs itself)
    await new Promise((resolve, reject) => {
      const { port, path } = readActivePort(chrome.dir), ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "data:text/html,<title>later</title>user's later tab" } }));
      ws.onmessage = () => { ws.close(); resolve(); };
      ws.onerror = reject;
    });
    const user = await until(() => host.context.pages().find(p => p.url().includes("later")));
    assert.ok(user, "barq sees tabs opened after it connected");
    assert.equal(await user.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), true, "no forced light scheme");
    // a confirm() in the user's tab must wait for the user, not be answered by the automation
    let open;
    host.context.on("dialog", d => { open = d; });   // only notes it, like the user looking at it
    await user.evaluate(() => setTimeout(() => { window.answer = confirm("Discard changes?"); }, 0));
    await sleep(300);
    const answered = await Promise.race([user.evaluate(() => "answer" in window), sleep(1000).then(() => "still open")]);
    assert.equal(answered, "still open");
    assert.equal(open?.message(), "Discard changes?");
    await open.dismiss();
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
