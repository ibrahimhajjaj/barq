// Where the pages come from: a Chromium this process launches, or a Chromium-family browser the
// user already has open (Chrome, Edge, Brave, ...), reached over the DevTools protocol so the agent
// works inside the user's own profile with its logins, extensions and password manager.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import net from "node:net";

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

// A browser the user already runs. Every tab the agent needs is created here, and only those and
// the tabs they open are ever closed; disposing disconnects and leaves the browser and the user's
// own tabs alone.
//
// placement:
//   "window" a separate window that doesn't take focus; tabs the agent's pages open land there too
//   "tab"    a plain background tab in the user's current window
export class AttachedBrowser {
  kind = "attach";

  static async connect(spec = "auto", { placement = "window", size = { width: 1280, height: 800 }, allowTimeoutMs = 120_000 } = {}) {
    const endpoint = await findEndpoint(spec);
    let browser;
    try {
      // noDefaults: without it, attaching applies automation defaults (focus emulation, forced
      // light colour scheme and motion settings, a temporary downloads folder) to every tab of the
      // user's profile. On recent browsers each new connection also waits for the user to click
      // "Allow", and a short timeout would drop that prompt and raise a fresh one next time.
      browser = await chromium.connectOverCDP(endpoint.ws, { timeout: allowTimeoutMs, noDefaults: true });
    } catch (e) {
      if (/timeout/i.test(String(e.message))) throw new Error(`Connecting to ${endpoint.name} took longer than ${Math.round(allowTimeoutMs / 1000)}s. If it shows an "Allow remote debugging" prompt, click Allow; otherwise one of its tabs may be hung. Then retry.`);
      throw e;
    }
    return new AttachedBrowser(browser, endpoint, { placement, size });
  }

  constructor(browser, endpoint, { placement = "window", size = { width: 1280, height: 800 } } = {}) {
    this.browser = browser; this.endpoint = endpoint; this.placement = placement; this.size = size;
    this.context = browser.contexts()[0];
    this.owned = new Set();
    // With no dialog listener at all, Playwright answers every dialog in every tab it is attached
    // to, the user's included: confirm() returns false and "Leave site?" is accepted. A listener
    // that does nothing leaves the user's dialogs to the user; the agent's tabs answer their own.
    this.context.on("dialog", () => {});
    // Tabs opened by the agent's tabs are the agent's too: they get the same care and are closed with them.
    this.context.on("page", async p => {
      const opener = await p.opener().catch(() => null);
      if (opener && this.owned.has(opener)) this.own(p).catch(() => {});
    });
  }

  get name() { return this.endpoint.name; }
  isAlive() { return this.browser.isConnected(); }

  // noDefaults leaves focus emulation off, so turn it on for the agent's tabs only: a background
  // tab otherwise stops rendering frames, and actions wait on frames. The CDP session has to stay
  // open, since detaching it undoes the emulation.
  async own(p) {
    if (this.owned.has(p)) return p;
    this.owned.add(p);
    p.once("close", () => this.owned.delete(p));
    const s = await this.context.newCDPSession(p);
    await s.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    return p;
  }

  newTab() {
    return this.createTab(this.placement === "tab" ? [{ background: true }] : [{ newWindow: true, focus: false, ...this.size }, { background: true }]);
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
        if (page) return this.own(page);
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
    try {
      if (userDataDir) {
        const context = await chromium.launchPersistentContext(userDataDir, { headless: !headed, channel, viewport, slowMo });
        return new LaunchedBrowser(null, context);
      }
      const browser = await chromium.launch({ headless: !headed, channel, slowMo });
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

// JEV_BROWSER_ATTACH=chrome|edge|brave|...|auto|<dir>|<url> drives a running browser
// (JEV_BROWSER_PLACEMENT=window|tab); otherwise a browser is launched (JEV_BROWSER_CHANNEL=chrome|msedge,
// JEV_BROWSER_PROFILE, JEV_BROWSER_HEADED=1).
export function browserConfig(env = process.env) {
  if (env.JEV_BROWSER_ATTACH) return { kind: "attach", spec: env.JEV_BROWSER_ATTACH, placement: env.JEV_BROWSER_PLACEMENT === "tab" ? "tab" : "window" };
  return { kind: "launch", headed: env.JEV_BROWSER_HEADED === "1", channel: env.JEV_BROWSER_CHANNEL || undefined, userDataDir: env.JEV_BROWSER_PROFILE || undefined };
}

export function openBrowser(config = browserConfig()) {
  return config.kind === "attach"
    ? AttachedBrowser.connect(config.spec, config)
    : LaunchedBrowser.launch(config);
}
