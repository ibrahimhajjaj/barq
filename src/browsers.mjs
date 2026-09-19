// Where the pages come from: a Chromium this process launches, or a Chromium-family browser the
// user already has open (Chrome, Edge, Brave, ...), reached over the DevTools protocol so the agent
// works inside the user's own profile with its logins, extensions and password manager.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import net from "node:net";
import { relayEndpoint } from "./relay.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const MAC = "Library/Application Support";

// User-data directories, relative to the home directory on macOS, the config directory on Linux
// (XDG_CONFIG_HOME, else ~/.config) and LOCALAPPDATA on Windows. While remote debugging is on,
// the running browser writes DevToolsActivePort into this directory.
export const USER_DATA_DIRS = {
  darwin: {
    chrome: `${MAC}/Google/Chrome`, "chrome-beta": `${MAC}/Google/Chrome Beta`, "chrome-dev": `${MAC}/Google/Chrome Dev`, "chrome-canary": `${MAC}/Google/Chrome Canary`,
    edge: `${MAC}/Microsoft Edge`, "edge-beta": `${MAC}/Microsoft Edge Beta`, "edge-dev": `${MAC}/Microsoft Edge Dev`,
    brave: `${MAC}/BraveSoftware/Brave-Browser`, chromium: `${MAC}/Chromium`, vivaldi: `${MAC}/Vivaldi`, arc: `${MAC}/Arc/User Data`,
  },
  linux: {
    chrome: "google-chrome", "chrome-beta": "google-chrome-beta", "chrome-dev": "google-chrome-unstable", "chrome-canary": "google-chrome-canary",
    edge: "microsoft-edge", "edge-beta": "microsoft-edge-beta", "edge-dev": "microsoft-edge-dev",
    brave: "BraveSoftware/Brave-Browser", chromium: "chromium", vivaldi: "vivaldi",
  },
  win32: {
    chrome: "Google/Chrome/User Data", "chrome-beta": "Google/Chrome Beta/User Data", "chrome-dev": "Google/Chrome Dev/User Data", "chrome-canary": "Google/Chrome SxS/User Data",
    edge: "Microsoft/Edge/User Data", "edge-beta": "Microsoft/Edge Beta/User Data", "edge-dev": "Microsoft/Edge Dev/User Data",
    brave: "BraveSoftware/Brave-Browser/User Data", chromium: "Chromium/User Data", vivaldi: "Vivaldi/User Data",
  },
};

export function userDataDir(name, { platform = process.platform, home = homedir(), localAppData = process.env.LOCALAPPDATA, configHome = process.env.XDG_CONFIG_HOME } = {}) {
  if (isAbsolute(name)) return name;
  const rel = USER_DATA_DIRS[platform]?.[name];
  if (!rel) return null;
  if (platform === "win32") return localAppData ? join(localAppData, rel) : null;
  if (platform === "linux") return join(configHome || join(home, ".config"), rel);
  return join(home, rel);
}

// The page where the user turns remote debugging on for a running browser.
export function inspectPage(name = "chrome") {
  const scheme = name.startsWith("edge") ? "edge" : name === "brave" ? "brave" : name === "vivaldi" ? "vivaldi" : "chrome";
  return `${scheme}://inspect/#remote-debugging`;
}

// DevToolsActivePort: the port on the first line, the browser's websocket path on the second.
export function readActivePort(dir) {
  try {
    const [port, path] = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n").map(s => s.trim());
    return +port > 0 ? { port: +port, path: path || "" } : null;
  } catch { return null; }
}

// A browser that quit can leave DevToolsActivePort behind, so the port must also be listening.
export function listening(port, { host = "127.0.0.1", timeout = 500 } = {}) {
  return new Promise(resolve => {
    const s = net.connect({ port, host });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// spec: a ws:// endpoint, an http:// DevTools address, a browser name from USER_DATA_DIRS,
// "auto" (the first of those with remote debugging on), or a user-data directory.
export async function findEndpoint(spec = "auto", opts = {}) {
  if (/^wss?:\/\//.test(spec)) return { name: "custom", ws: spec };
  if (/^https?:\/\//.test(spec)) {
    const res = await fetch(`${spec.replace(/\/+$/, "")}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (res.status === 403) throw new Error(`${spec} refused the connection: accept the browser's "Allow remote debugging" prompt, then retry`);
    if (!res.ok) throw new Error(`${spec}/json/version answered ${res.status}`);
    return { name: "custom", ws: (await res.json()).webSocketDebuggerUrl };
  }
  const platform = opts.platform ?? process.platform;
  const names = spec === "auto" ? Object.keys(USER_DATA_DIRS[platform] ?? {}) : [spec];
  const seen = [];
  for (const name of names) {
    const dir = userDataDir(name, opts);
    if (!dir) continue;
    const active = readActivePort(dir);
    if (!active) continue;
    if (await listening(active.port)) return { name: isAbsolute(name) ? "custom" : name, dir, ws: `ws://127.0.0.1:${active.port}${active.path}` };
    seen.push(name);
  }
  const which = spec === "auto" ? "No Chromium-family browser" : isAbsolute(spec) ? `The browser using ${spec}` : `${spec}`;
  if (spec !== "auto" && !isAbsolute(spec) && !USER_DATA_DIRS[platform]?.[spec]) {
    throw new Error(`Unknown browser "${spec}". Use one of: ${Object.keys(USER_DATA_DIRS[platform] ?? {}).join(", ")}, auto, a user-data directory, or a ws:// or http:// DevTools address`);
  }
  const stale = seen.length ? ` (${seen.join(", ")} left a DevToolsActivePort file but isn't listening: is it still running?)` : "";
  throw new Error(`${which} has remote debugging on${stale}. Start the browser, open ${inspectPage(spec === "auto" ? "chrome" : spec)} and tick "Allow remote debugging for this browser instance".`);
}

// The helper extension in extension/ (its manifest key pins this id). Loaded unpacked once per
// browser, it lets the agent keep its tabs in a named tab group, which the DevTools protocol can't do.
export const HELPER_EXTENSION_ID = "cbkdahgldeliodgkkmlmkmakamfoejec";
export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// A browser the user already runs. Every tab the agent needs is created here, and only those and
// the tabs they open are ever closed; disposing disconnects and leaves the browser and the user's
// own tabs alone.
//
// placement:
//   "group"  a tab group in the user's current window (needs the helper extension)
//   "window" a separate window that doesn't take focus; tabs the agent's pages open land there too
//   "tab"    a plain background tab in the user's current window
//   "auto"   "group" when the helper extension is installed, otherwise "window"
export class AttachedBrowser {
  kind = "attach";

  static async connect(spec = "auto", { placement = "auto", group = {}, size = { width: 1280, height: 800 }, allowTimeoutMs = 120_000 } = {}) {
    const endpoint = await findEndpoint(spec);
    const slow = () => new Error(`Connecting to ${endpoint.name} took longer than ${Math.round(allowTimeoutMs / 1000)}s. If it shows an "Allow remote debugging" prompt, click Allow; otherwise one of its tabs may be hung. Then retry.`);
    // On recent browsers each new connection waits for the user to click "Allow". One approved
    // connection per browser run is shared through a relay process, so a new server (another agent
    // session, a restart) doesn't ask again. Straight to the browser when the relay is off or
    // can't run here.
    let url = endpoint.ws;
    if (process.env.JEV_BROWSER_RELAY !== "0") {
      try { url = await relayEndpoint(endpoint.ws, { timeoutMs: allowTimeoutMs }); }
      catch (e) {
        if (e.code === "RELAY_TIMEOUT") throw slow();
        if (e.code === "RELAY_REFUSED") throw new Error(`${endpoint.name} didn't allow the connection (${e.message}). Click "Allow" when it asks, then retry.`);
      }
    }
    let browser;
    try {
      // noDefaults: without it, attaching applies automation defaults (focus emulation, forced
      // light colour scheme and motion settings, a temporary downloads folder) to every tab of the
      // user's profile. A short timeout would drop a pending "Allow" prompt and raise a fresh one
      // next time.
      browser = await chromium.connectOverCDP(url, { timeout: allowTimeoutMs, noDefaults: true });
    } catch (e) {
      if (/timeout/i.test(String(e.message))) throw slow();
      throw e;
    }
    return new AttachedBrowser(browser, endpoint, { placement, group, size });
  }

  constructor(browser, endpoint, { placement = "auto", group = {}, size = { width: 1280, height: 800 } } = {}) {
    this.browser = browser; this.endpoint = endpoint; this.placement = placement; this.size = size;
    this.group = { title: "Agent", color: "purple", collapsed: true, ...group };
    if (!GROUP_COLORS.includes(this.group.color)) this.group.color = "purple";
    this.context = browser.contexts()[0];
    this.owned = new Set();
    this.helperMissedAt = placement === "window" || placement === "tab" ? Infinity : 0;
    // With no dialog listener at all, Playwright answers every dialog in every tab it is attached
    // to, the user's included: confirm() returns false and "Leave site?" is accepted. A listener
    // that does nothing leaves the user's dialogs to the user; the agent's tabs answer their own.
    this.context.on("dialog", () => {});
    // Tabs opened by the agent's tabs are the agent's too: they get the same care and are closed with them.
    this.context.on("page", async p => {
      const opener = await p.opener().catch(() => null);
      if (!opener || !this.owned.has(opener)) return;
      await this.own(p).catch(() => {});
      await this.tuckAway(p, opener).catch(() => {});
    });
  }

  // A popup window one of the agent's tabs opened (window.open with a size, a sign-in popup):
  // minimize it so it doesn't cover what the user is doing; the agent keeps working in it.
  // Only a window holding nothing but that tab, never one of the user's windows.
  async tuckAway(popup, opener) {
    const cdp = await (this.cdp ??= this.browser.newBrowserCDPSession());
    const targetOf = async page => {
      const s = await this.context.newCDPSession(page);
      try { return (await s.send("Target.getTargetInfo")).targetInfo.targetId; } finally { await s.detach().catch(() => {}); }
    };
    const windowOf = async targetId => (await cdp.send("Browser.getWindowForTarget", { targetId })).windowId;
    const [win, openerWin] = await Promise.all([targetOf(popup).then(windowOf), targetOf(opener).then(windowOf)]);
    if (win === openerWin) return;
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] });
    const windows = await Promise.all(targetInfos.map(t => windowOf(t.targetId).catch(() => null)));
    if (windows.filter(w => w === win).length !== 1) return;
    await cdp.send("Browser.setWindowBounds", { windowId: win, bounds: { windowState: "minimized" } });
  }

  get name() { return this.endpoint.name; }
  isAlive() { return this.browser.isConnected(); }

  // noDefaults leaves focus emulation off, so turn it on for the agent's tabs only: a background
  // or collapsed tab otherwise stops rendering frames, and actions wait on frames. The CDP session
  // has to stay open, since detaching it undoes the emulation.
  async own(p) {
    if (this.owned.has(p)) return p;
    this.owned.add(p);
    p.once("close", () => this.owned.delete(p));
    const s = await this.context.newCDPSession(p);
    await s.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    return p;
  }

  // The helper extension's service worker. The worker listens for new tabs, so creating the
  // agent's tab wakes it if the browser had stopped it.
  async helper(timeout = 5000) {
    const ours = w => w.url().startsWith(`chrome-extension://${HELPER_EXTENSION_ID}/`);
    return this.context.serviceWorkers().find(ours)
      ?? await this.context.waitForEvent("serviceworker", { predicate: ours, timeout }).catch(() => null);
  }

  async newTab({ session = "main" } = {}) {
    // After a miss, look for the helper again only once a minute: each look can cost seconds.
    const tryGroup = this.placement === "group" || (this.placement === "auto" && Date.now() - this.helperMissedAt > 60_000);
    if (!tryGroup) return this.createTab(this.placement === "tab" ? [{ background: true }] : [{ newWindow: true, focus: false, ...this.size }, { background: true }]);

    const page = await this.createTab([{ background: true }]);
    const sw = await this.helper();
    if (sw) {
      try {
        const title = session === "main" ? this.group.title : `${this.group.title} · ${session}`;
        const { tabId } = await sw.evaluate(args => self.jevGroup(args), { marker: this.markers.get(page), session, ...this.group, title });
        (this.tabIds ??= new WeakMap()).set(page, tabId);
        return page;
      } catch (e) {
        // no tab-group API (some Chromium browsers), a window that can't hold groups, ...
        await page.close().catch(() => {});
        if (this.placement === "group") throw new Error(`Couldn't put the tab in a group: ${String(e.message).split("\n")[0]}`);
        this.helperMissedAt = Date.now();
        return this.newTab({ session });
      }
    }
    await page.close().catch(() => {});
    if (this.placement === "group") {
      throw new Error(`The helper extension isn't loaded in ${this.name}. Load the extension/ folder of jev-browser unpacked (${this.name.startsWith("edge") ? "edge" : "chrome"}://extensions, Developer mode, Load unpacked), or use placement "window".`);
    }
    // No helper: a tab in the user's window could have a popup take over their screen, so use a window instead.
    this.helperMissedAt = Date.now();
    return this.newTab({ session });
  }

  // Make one of the agent's grouped tabs the tab in front of its window for a moment, without
  // raising the window. Returns the function that gives the user their tab back, or null when that
  // can't be done (no helper, or a tab in a window of its own).
  async front(page) {
    const sw = await this.helper(2000);
    if (!sw) return null;
    const tabId = this.tabIds?.get(page) ?? await sw.evaluate(url => self.jevFindTab(url), page.url()).catch(() => null);
    if (tabId == null) return null;
    await sw.evaluate(id => self.jevFront(id), tabId);
    return () => sw.evaluate(id => self.jevBack(id), tabId).catch(() => {});
  }

  // Tries each set of Target.createTarget options in turn (headless builds refuse some of them).
  // Every option keeps the tab in the background; a foreground tab would take over the user's window.
  // The tab starts at a unique blank URL, which is how it is found among the user's tabs.
  async createTab(tries) {
    this.cdp ??= this.browser.newBrowserCDPSession();
    const cdp = await this.cdp;
    const marker = `#jev-${Math.random().toString(36).slice(2, 10)}`;
    let lastError;
    for (const opts of tries) {
      let targetId;
      try { ({ targetId } = await cdp.send("Target.createTarget", { url: `about:blank${marker}`, ...opts })); }
      catch (e) { lastError = e; continue; }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const page = this.context.pages().find(p => !this.owned.has(p) && p.url().endsWith(marker));
        if (page) { (this.markers ??= new WeakMap()).set(page, marker); return this.own(page); }
        await sleep(25);
      }
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw new Error("the new tab never showed up");
    }
    throw lastError;
  }

  async dispose() {
    for (const p of [...this.owned]) await p.close().catch(() => {});
    // Playwright only disconnects from a browser it connected to; the browser keeps running.
    await this.browser.close().catch(() => {});
  }
}

// A browser this process starts: bundled Chromium by default, or an installed Chrome/Edge
// ("chrome", "msedge") with its own profile directory when userDataDir is given.
export class LaunchedBrowser {
  kind = "launch";

  static async launch({ headed = false, channel, userDataDir, viewport = { width: 1280, height: 800 }, slowMo = 0 } = {}) {
    // Sites outside the WebMCP origin trial can't register tools unless the browser allows it;
    // in a browser this tool starts, let them.
    const args = ["--enable-blink-features=WebMCP"];
    try {
      if (userDataDir) {
        const context = await chromium.launchPersistentContext(userDataDir, { headless: !headed, channel, viewport, slowMo, args });
        return new LaunchedBrowser(null, context);
      }
      const browser = await chromium.launch({ headless: !headed, channel, slowMo, args });
      return new LaunchedBrowser(browser, await browser.newContext({ viewport }));
    } catch (e) {
      if (/Executable doesn't exist/i.test(String(e.message)) && !channel) throw new Error("Chromium for Playwright is not installed. Run: npx playwright install chromium");
      throw e;
    }
  }

  constructor(browser, context) {
    this.browser = browser; this.context = context; this.closed = false;
    context.on("close", () => { this.closed = true; });
  }

  get name() { return "chromium"; }
  isAlive() { return !this.closed && (this.browser ? this.browser.isConnected() : true); }
  newTab() { return this.context.newPage(); }

  async dispose() {
    await this.context.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

// JEV_BROWSER_ATTACH=chrome|edge|brave|...|auto|<dir>|<url> drives a running browser ("launch" or unset: don't)
// (JEV_BROWSER_PLACEMENT=auto|group|window|tab, JEV_BROWSER_GROUP_TITLE, JEV_BROWSER_GROUP_COLOR);
// otherwise a browser is launched (JEV_BROWSER_CHANNEL=chrome|msedge, JEV_BROWSER_PROFILE, JEV_BROWSER_HEADED=1).
export function browserConfig(env = process.env) {
  // an unset plugin setting can arrive as its literal "${...}" placeholder
  env = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string" && !v.startsWith("${")));
  if (env.JEV_BROWSER_ATTACH && env.JEV_BROWSER_ATTACH !== "launch") {
    const placement = ["group", "window", "tab"].includes(env.JEV_BROWSER_PLACEMENT) ? env.JEV_BROWSER_PLACEMENT : "auto";
    const group = {};
    if (env.JEV_BROWSER_GROUP_TITLE) group.title = env.JEV_BROWSER_GROUP_TITLE;
    if (env.JEV_BROWSER_GROUP_COLOR) group.color = env.JEV_BROWSER_GROUP_COLOR;
    return { kind: "attach", spec: env.JEV_BROWSER_ATTACH, placement, group };
  }
  return { kind: "launch", headed: env.JEV_BROWSER_HEADED === "1", channel: env.JEV_BROWSER_CHANNEL || undefined, userDataDir: env.JEV_BROWSER_PROFILE || undefined };
}

export function openBrowser(config = browserConfig()) {
  return config.kind === "attach"
    ? AttachedBrowser.connect(config.spec, config)
    : LaunchedBrowser.launch(config);
}
