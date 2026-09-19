// Named browser sessions for callers that send requests in parallel (an MCP client running several
// tool calls at once, or several agents). Each session is its own tab with its own queue: calls on
// one session run in order, calls on different sessions run side by side.
//
// Every call has a time limit and can be cancelled. Either way the call's work is told to stop;
// the tab is kept if it still answers (a slow Jev request, say) and replaced if it doesn't. A tab
// that closed or crashed between calls, or a browser that went away, is replaced on the next call,
// which reopens the session's last URL.
import { JevBrowser } from "./session.mjs";
import { openBrowser } from "./browsers.mjs";

export class CallTimeout extends Error {}
export class CallCancelled extends Error {}

const sleep = ms => new Promise(done => setTimeout(done, ms));
const settledWithin = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

export class SessionPool {
  // idleMs: let go of the browser after this long without calls (0 = never). Sessions keep their
  // last URL and reopen it on the next call.
  constructor({ open = () => openBrowser(), highlight = false, idleMs = 0 } = {}) {
    this.open = open; this.highlight = highlight; this.idleMs = idleMs;
    this.sessions = new Map();
    this.handle = null;
  }

  // One browser for all sessions. Callers that find it dead at the same moment share one reopen.
  async browser() {
    const cur = this.handle;
    if (cur) {
      const h = await cur.catch(() => null);
      if (h?.isAlive()) return h;
      if (this.handle !== cur) return this.browser();
      this.handle = null;
      h?.dispose().catch(() => {});
    }
    const next = this.open();
    this.handle = next;
    next.catch(() => { if (this.handle === next) this.handle = null; });
    return next;
  }

  entry(name) {
    let s = this.sessions.get(name);
    if (!s) this.sessions.set(name, s = { name, jb: null, host: null, hadTab: false, lastUrl: null, queue: Promise.resolve(), busy: false, closed: false, stray: null });
    return s;
  }

  // fn(jb, signal) -> result; signal aborts when the call times out or is cancelled.
  // Resolves to { result, recovered }: recovered says the session's tab had to be replaced first.
  run(name = "main", fn, { timeoutMs = 120_000, signal } = {}) {
    const s = this.entry(name);
    this.touch();
    const turn = s.queue.then(() => this.turn(s, fn, timeoutMs, signal));
    s.queue = turn.catch(() => {});
    return turn;
  }

  async turn(s, fn, timeoutMs, signal) {
    if (s.closed) throw new Error(`session "${s.name}" was closed`);
    if (signal?.aborted) throw new CallCancelled("cancelled before it started");
    // work left over from a call that timed out: give it a moment to stop, then replace the tab
    if (s.stray && !(await settledWithin(s.stray, 5000))) await this.discard(s);
    s.stray = null;
    s.busy = true;
    const ac = new AbortController();
    s.abort = ac;
    let timer, onAbort;
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new CallTimeout(`gave up after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      onAbort = () => { ac.abort(); reject(new CallCancelled("the call was cancelled")); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const work = (async () => {
      const recovered = await this.ensure(s);
      s.jb.callSignal = ac.signal;
      return { result: await fn(s.jb, ac.signal), recovered };
    })();
    try {
      return await Promise.race([work, stop]);
    } catch (e) {
      if (e instanceof CallTimeout || e instanceof CallCancelled) {
        s.stray = work;
        if (!(await this.responsive(s))) { s.stray = null; this.discard(s).catch(() => {}); }
      }
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (s.jb) s.jb.callSignal = null;
      s.busy = false; s.abort = null;
      const page = s.jb?.page;
      if (page && !page.isClosed() && !page.url().startsWith("about:blank")) s.lastUrl = page.url();
      this.touch();
    }
  }

  async responsive(s) {
    const page = s.jb?.page;
    if (!page || page.isClosed() || s.jb.crashed) return false;
    return Promise.race([page.evaluate(() => 1).then(() => true, () => false), sleep(2000).then(() => false)]);
  }

  // Make sure the session has a live tab; returns true if one had to be replaced.
  async ensure(s) {
    const host = await this.browser();
    if (s.jb && s.host === host && !s.jb.page.isClosed() && !s.jb.crashed) return false;
    const replacing = s.hadTab;
    await this.discard(s);
    const page = await host.newTab({ session: s.name });
    s.jb = await JevBrowser.forPage(page, { highlight: this.highlight });
    s.host = host; s.hadTab = true;
    if (replacing && s.lastUrl) await s.jb.open(s.lastUrl).catch(() => {});
    return replacing;
  }

  async discard(s) {
    const jb = s.jb;
    s.jb = null;
    if (jb) await jb.close().catch(() => {});
  }

  list() {
    return [...this.sessions.values()].map(s => ({ session: s.name, url: s.jb && !s.jb.page.isClosed() ? s.jb.page.url() : s.lastUrl, busy: s.busy }));
  }

  // Closes the session's tab now, stopping a call that is running in it. Calls already queued on it
  // fail; the next call with this name starts a new session.
  async close(name = "main") {
    const s = this.sessions.get(name);
    if (!s) return false;
    this.sessions.delete(name);
    s.closed = true;
    s.abort?.abort();
    await this.discard(s);
    return true;
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map(name => this.close(name).catch(() => {})));
    await this.release();
  }

  // Disconnect from (or close) the browser but keep the sessions and their last URLs.
  async release() {
    clearTimeout(this.idleTimer);
    const h = this.handle && await this.handle.catch(() => null);
    this.handle = null;
    for (const s of this.sessions.values()) s.jb = null;
    await h?.dispose();
  }

  touch() {
    if (!this.idleMs) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if ([...this.sessions.values()].some(s => s.busy)) return this.touch();
      this.release().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
}
