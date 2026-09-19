// Offline tests: finding a running browser and attaching to it. Attach tests start Chrome for
// Testing headless with a throwaway profile.
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
import { findEndpoint, userDataDir, inspectPage, AttachedBrowser } from "../src/browsers.mjs";
import { JevBrowser } from "../src/session.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const tmp = () => mkdtempSync(join(tmpdir(), "jev-browser-test-"));

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
async function startBrowser({ args: extra = [] } = {}) {
  const dir = tmp();
  const args = ["--headless=new", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", ...extra];
  const proc = spawn(chromium.executablePath(), [...args, "data:text/html,<title>user tab</title>the user's own tab"], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(join(dir, "DevToolsActivePort")); i++) await sleep(100);
  await sleep(300);
  const exited = new Promise(r => proc.once("exit", r));
  const stop = async () => { proc.kill(); await exited; rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); };
  return { dir, proc, alive: () => proc.exitCode === null && !proc.killed, stop };
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

test("attached: the agent's tab opens in a window of its own", async () => {
  const chrome = await startBrowser();
  try {
    const host = await AttachedBrowser.connect(chrome.dir);
    const page = await host.newTab();
    const userTab = host.context.pages().find(p => p.url().startsWith("data:"));
    assert.notEqual(await windowOf(host, page), await windowOf(host, userTab), "the agent's tab is in a window of its own");
    await page.goto(`${base}/agent`);
    assert.equal(await page.title(), "agent");
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
