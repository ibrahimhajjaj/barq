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
import { findEndpoint, userDataDir, inspectPage, readActivePort, AttachedBrowser, HELPER_EXTENSION_ID } from "../src/browsers.mjs";
import { JevBrowser } from "../src/session.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const tmp = () => mkdtempSync(join(tmpdir(), "jev-browser-test-"));
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
  const dir = tmp();
  const args = ["--headless=new", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", ...extra];
  if (extension) args.push(`--load-extension=${EXTENSION}`, `--disable-extensions-except=${EXTENSION}`);
  const proc = spawn(chromium.executablePath(), [...args, "data:text/html,<title>user tab</title>the user's own tab"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(join(dir, "DevToolsActivePort")); i++) await sleep(100);
  await sleep(300);
  const exited = new Promise(r => proc.once("exit", r));
  const stop = async () => { proc.kill(); await exited; rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); };
  return { dir, proc, alive: () => proc.exitCode === null && !proc.killed, stop };
}

// The browser's targets as its DevTools endpoint lists them, without attaching anything.
async function fetchTargets(dir) {
  const { port } = readActivePort(dir);
  return fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
}

// The browser window a tab sits in.
async function windowOf(host, page) {
  const s = await host.context.newCDPSession(page);
  const { targetInfo } = await s.send("Target.getTargetInfo");
  await s.detach();
  const b = await host.browser.newBrowserCDPSession();
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
    const jb = await JevBrowser.forPage(await host.newTab({ session: "main" }));
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

test("attached without the helper: auto falls back to a separate window", async () => {
  const chrome = await startBrowser();
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    const page = await host.newTab();
    const userTab = host.context.pages().find(p => p.url().startsWith("data:"));
    assert.notEqual(await windowOf(host, page), await windowOf(host, userTab), "the agent's tab is in a window of its own");
    await page.goto(`${base}/agent`);
    assert.equal(await page.title(), "agent");
    await assert.rejects(new AttachedBrowser(host.browser, host.endpoint, { placement: "group" }).newTab(), /helper extension/);
    await host.dispose();
    assert.ok(chrome.alive());
  } finally { await chrome.stop(); }
});

test("attaching leaves the user's tabs as they were: colour scheme, focus, and their own dialogs", async () => {
  const chrome = await startBrowser({ args: ["--force-dark-mode"] });
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    const user = host.context.pages().find(p => p.url().startsWith("data:"));
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
    const user = host.context.pages().find(p => p.url().startsWith("data:"));
    const cdp = await host.context.newCDPSession(user);
    await cdp.send("ServiceWorker.enable");
    const running = async () => (await fetchTargets(chrome.dir)).some(t => t.type === "service_worker" && t.url.includes(HELPER_EXTENSION_ID));
    const stopped = await until(async () => { await cdp.send("ServiceWorker.stopAllWorkers"); await sleep(300); return !(await running()); }, 10_000);
    await cdp.detach();
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
