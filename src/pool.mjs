// Named browser sessions for callers that send requests in parallel (an MCP client running several
// tool calls at once, or several agents). Each session is its own tab with its own queue: calls on
// one session run in order, calls on different sessions run side by side.
//
// Every call has a time limit and can be cancelled. Either way the call's work is told to stop;
// the tab is kept if it still answers (a slow Jev request, say) and replaced if it doesn't. A tab
// that closed or crashed between calls, or a browser that went away, is replaced on the next call,
// which reopens the session's last URL.
import { Barq } from "./session.mjs";
import { openBrowser } from "./browsers.mjs";

export class CallTimeout extends Error {}
export class CallCancelled extends Error {}

const sleep = ms => new Promise(done => setTimeout(done, ms));
const settledWithin = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

export class SessionPool {
  // idleMs: let go of the browser after this long without calls (0 = never). Sessions keep their
  // last URL and reopen it on the next call. recipes: the RecipeBook every session records to and
  // replays from.
  constructor({ open = () => openBrowser(), highlight = false, idleMs = 0, recipes = null } = {}) {
    this.open = open; this.highlight = highlight; this.idleMs = idleMs; this.recipes = recipes;
    this.sessions = new Map();
    this.handle = null;
    this.holds = 0;          // work outside the sessions (a scan) that still needs the browser
  }

  // One browser for all sessions. Callers that find it dead at the same moment share one reopen.
  async browser() {
    // a call that comes while the tabs are being parked waits for the claim that gets them back
    await this.resting;
    const cur = this.handle;
    if (cur) {
      const h = await cur.catch(() => null);
      if (h?.isAlive()) return h;
      if (this.handle !== cur) return this.browser();
      this.handle = null;
      h?.dispose().catch(() => {});
    }
    // the tabs left parked last time come back with the connection, once
    const claim = this.claim;
    this.claim = null;
    const next = this.open(claim ? { claim } : {});
    this.handle = next;
    // a connection that failed never took them: the next try asks again
    next.catch(() => { if (this.handle === next) this.handle = null; if (claim && !this.claim) this.claim = claim; });
    return next;
  }

  entry(name) {
    let s = this.sessions.get(name);
    // parked: { ids, current, until } while the session's tabs wait in the relay for this process
    if (!s) this.sessions.set(name, s = { name, jb: null, host: null, hadTab: false, lastUrl: null, parked: null, queue: Promise.resolve(), busy: false, closed: false, stray: null, isolated: false });
    return s;
  }

  // From the next tab on, this session keeps its own cookies and storage. A session that already has
  // a tab sharing the browser's gets a fresh one, signed in to nothing.
  isolate(name) {
    const s = this.entry(name);
    // after whatever the session is doing now, never under it
    const turn = s.queue.then(async () => {
      await this.resting;
      if (s.isolated) return;
      // a parked tab is the shared profile's: closed as one, before the session changes
      const had = s.jb || s.parked;
      await this.dropParked(s);
      s.isolated = true;
      if (had) { await this.discard(s); s.hadTab = false; s.lastUrl = null; }
    });
    s.queue = turn.catch(() => {});
    return turn;
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
    // a tab can die quietly (a crashed renderer doesn't always say so): ask it something before
    // handing it to the next call
    if (s.jb && s.host === host && await this.responsive(s)) return false;
    // the tabs it had before the browser was let go of while idle, as the last call left them
    if (!s.jb && s.parked) {
      const { ids, current } = s.parked;
      s.parked = null;
      const pages = await host.claimed?.(ids, { isolated: s.isolated }).catch(() => []) ?? [];
      if (pages.length) {
        const [first, ...more] = pages;
        s.jb = await Barq.forPage(first.page, { highlight: this.highlight, front: host.front ? p => host.front(p) : null, visible: !!host.visible, recipes: this.recipes });
        for (const { page } of more) await s.jb.adopt(page);
        s.jb.page = pages.find(x => x.id === current)?.page ?? first.page;
        s.host = host;
        return false;
      }
    }
    const replacing = s.hadTab;
    await this.discard(s);
    const page = await host.newTab({ session: s.name, isolated: s.isolated });
    s.jb = await Barq.forPage(page, { highlight: this.highlight, front: host.front ? p => host.front(p) : null, visible: !!host.visible, recipes: this.recipes });
    s.host = host; s.hadTab = true;
    if (replacing && s.lastUrl) await s.jb.open(s.lastUrl).catch(() => {});
    return replacing;
  }

  async discard(s) {
    const jb = s.jb;
    s.jb = null;
    if (jb) await jb.close().catch(() => {});
  }

  // tab: "open"; "parked" while the browser is let go of for being idle (the next call carries on
  // in it); "gone" when it was closed or lost (the next call opens `url` again in a new one); "none"
  // before the first call.
  list() {
    return [...this.sessions.values()].map(s => {
      const open = s.jb && !s.jb.page.isClosed() && s.host?.isAlive?.() !== false;
      const tab = open ? "open" : s.parked && s.parked.until > Date.now() ? "parked" : s.hadTab || s.parked ? "gone" : "none";
      return { session: s.name, url: open ? s.jb.page.url() : s.lastUrl, tab, busy: s.busy };
    });
  }

  // Closes the session's tab now, stopping a call that is running in it. Calls already queued on it
  // fail; the next call with this name starts a new session.
  async close(name = "main") {
    // not halfway through parking, which could file its tab away after this has looked
    await this.resting;
    const s = this.sessions.get(name);
    if (!s) return false;
    this.sessions.delete(name);
    s.closed = true;
    s.abort?.abort();
    await this.discard(s);
    await this.dropParked(s);
    return true;
  }

  // A parked tab can only be closed by taking it back first, which takes back all of this
  // process's parked tabs; the others stay listed as parked and are picked up by their next call.
  async dropParked(s) {
    if (!s.parked) return;
    const { ids } = s.parked;
    s.parked = null;
    const host = await this.browser().catch(() => null);
    for (const { page } of await host?.claimed?.(ids, { isolated: s.isolated }).catch(() => []) ?? []) await page.close().catch(() => {});
    this.touch();
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

  // Let go of the browser after a while without calls, in the way the browser allows: tabs parked
  // in the relay, or kept by staying connected, or closed along with the connection.
  rest() {
    this.resting ??= this.park().finally(() => { this.resting = null; });
    return this.resting;
  }

  async park() {
    const h = this.handle && await this.handle.catch(() => null);
    if (!h) return;
    if (h.idle === "keep") return;
    if (h.idle !== "park") return this.release();
    this.handle = null;
    for (const s of this.sessions.values()) {
      const jb = s.jb;
      s.jb = null;
      if (!jb || jb.page.isClosed()) continue;
      const ids = [];
      let current = null;
      for (const p of jb.pages) {
        if (p.isClosed()) continue;
        const id = (await h.targetInfo(p).catch(() => null))?.targetId;
        if (!id) continue;
        ids.push(id);
        if (p === jb.page) current = id;
      }
      if (ids.length) s.parked = { ids, current, until: Infinity };
    }
    try {
      this.claim = await h.park();
      // tabs still parked from before were taken back with the connection and go back with it
      for (const s of this.sessions.values()) if (s.parked) s.parked.until = this.claim.until;
    } catch {
      for (const s of this.sessions.values()) s.parked = null;
      await h.dispose().catch(() => {});
    }
  }

  // Keep the browser while some work outside the sessions runs; returns the function that lets go.
  hold() {
    this.holds++;
    let held = true;
    return () => { if (held) { held = false; this.holds--; this.touch(); } };
  }

  touch() {
    if (!this.idleMs) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.holds || [...this.sessions.values()].some(s => s.busy)) return this.touch();
      this.rest().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
}
