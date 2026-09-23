// One browser tab and the loop that works it: the page is read in code, Jev picks the next move, Playwright makes it.
//
//   const b = await Barq.launch();
//   await b.open("https://shop.example/sign-in");
//   await b.do("Sign in", { values: { email: "me@shop.example", password: "keychain:shop" } });
//   const signedIn = await b.check("Does the page show an account menu?");   // 0 to 1
//
// Each round is one request to Jev with every question it needs: has the goal been reached (in
// two phrasings), is the way blocked, is an error showing, is the next move hard to undo, and which
// tool, element and value come next. Anything more is asked only when it is needed: which key,
// where to drop, which option, or a stricter "finished?" when the first answers disagree.
import { chromium } from "playwright";
import { getDomain } from "tldts";
import { jev } from "./jev.mjs";
import { ENUMERATE } from "./page-script.mjs";
import { FIELDISH, SELECTISH, FILEISH, brief, likelyFor, phrasesFrom, plainGoal, goalMet, mentions, pageDiff, repeatedElements, formatPage, clipMiddle, optionSummary, numbersIn, kindsOf, countKind, mayCount } from "./page-model.mjs";
import { readBlocks, toText, passages, findPassages } from "./reader.mjs";
import { commitsSomething, COMMITTING_TOOLS } from "./safety.mjs";
import { forJev, resolveValue, autofillAccount } from "./secrets.mjs";
import { SiteTools } from "./webmcp.mjs";
import { describe, place, recipeKey, findElement, fingerprint, matches, valuesPrint } from "./recipes.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));

// One line each, written for Jev. This table and the questions in roundQuestions() are prompt text
// that the thresholds elsewhere in this file were tuned against: rewording one shifts the scores it
// produces, so a change here only counts as an improvement if bench/run.mjs says so.
export const TOOLS = {
  click: "Press the target with the mouse: a link, button, checkbox, radio button, tab or menu item",
  type: "Replace whatever the target text field holds with one of the given `values`",
  press_enter: "Hit Enter in the target field, for instance to run a search or add an entry",
  press_key: "Hit a key that isn't Enter, such as Escape, Tab, Space, Backspace or an arrow key",
  select: "Pick an entry from the target <select> list",
  hover: "Rest the pointer on the target so that content hidden behind it shows",
  right_click: "Open the target's context menu with a right-click",
  drag: "Pick the target up and drop it on another element",
  upload: "Give the target file input one of the given `values`, which is the path of a file",
  scroll: "Move further down the page so more of it loads or comes into view",
  wait: "Hold on: the page is still busy loading or working (a spinner, a 'loading…' message, a busy or disabled button)",
  none: "No action: nothing on this page can make progress, or the goal is already achieved",
};
// Jev is never offered `back`: given the choice, it went back after steps that had worked. act() still takes it.
export const KEYS = [..."Escape Tab Space Backspace Delete".split(" "), ...["Down", "Up", "Left", "Right"].map(way => `Arrow${way}`), "PageDown", "PageUp", "Home", "End"];
// the tools that act on one element, as opposed to the page or the keyboard
const TARGETED = new Set("click type press_enter select hover right_click drag upload".split(" "));
// actions Jev's "irreversible" judgment can hold back; the rule in safety.mjs covers the same set
const GUARDED = COMMITTING_TOOLS;
// Runs in every frame (safe to run twice), for settle(): the time of the last DOM change, and the
// wall-clock time a click or window.open() was about to open a new tab, so settle() can wait for it.
// A change is also reported to the automation side, but only while a settle() is waiting (until the
// time in __jevWaiting, so a flag nobody clears runs out by itself) and at most every 50 ms: an
// animated page changes all the time.
const WATCH_MUTATIONS = () => {
  if (window.__jevWatching) return;
  window.__jevWatching = true;
  Object.assign(window, { __jevMut: performance.now() });
  let last = 0, later = false;
  const report = () => {
    if (!(Date.now() < window.__jevWaiting) || later) return;
    const wait = 50 - (performance.now() - last);
    if (wait > 0) { later = true; setTimeout(() => { later = false; report(); }, wait); return; }
    last = performance.now();
    window.__jevChanged?.().catch(() => {});
  };
  const mo = new MutationObserver(recs => {
    if (!recs.some(r => r.attributeName !== "data-jev-i")) return;
    Object.assign(window, { __jevMut: performance.now() });
    report();
  });
  const go = () => mo.observe(document, { childList: true, characterData: true, attributes: true, subtree: true });
  document.documentElement ? go() : addEventListener("DOMContentLoaded", go);
  const opening = () => { window.__jevPopupAt = Date.now(); report(); };
  addEventListener("click", e => {
    const a = e.target?.closest?.("a[target], area[target]");
    if (a && !["", "_self", "_parent", "_top"].includes(a.target.toLowerCase())) opening();
  }, true);
  const open = window.open;
  window.open = function (...args) { opening(); return open.apply(this, args); };
};

// How a dialog gets answered. An alert or a "leave this page?" decides nothing; confirm and prompt can.
const NO_DECISION = ["alert", "beforeunload"];
export const SAFE_DIALOGS = dialog => NO_DECISION.includes(dialog.type());
export const ACCEPT_DIALOGS = function acceptEveryDialog() { return true; };

const MAX_SINGLE = 240;   // a choice takes 255 criteria at most; the rest of the room is kept free
const HIGHLIGHT_MS = Number(process.env.BARQ_HIGHLIGHT_MS ?? 150);
// How long after an action ends settle() keeps watching, for work the page starts a moment later
// How long after an action ends the page is still watched for work it started late. A click can
// navigate or fetch and deserves the full watch; keystrokes, a key press and a hover land where
// they are and almost never set anything else off, so waiting on them is waiting for nothing.
const POST_ACTION_MS = 350;
const BRIEF_WATCH_MS = 120;
const LANDS_QUIETLY = new Set(["type", "press_key", "hover"]);
// A picker that opens as a dialog (a calendar, a list to choose from) and carries its own Done or
// Apply button hasn't handed its value to the page until that button is pressed: the calendar shows
// the chosen day while the form behind it is still empty.
const CONFIRMS = /^(done|apply|ok)\b/i;
// Buttons that do the same thing when pressed twice, which the goal may name as its last step.
const REPEATABLE = new Set(["search", "find", "filter", "sort", "show", "refresh"]);
// How long a field that offers a list as you type gets for that list to show up.
const SUGGESTIONS_MS = 1500;
// The first request of a process answers about half a second slower than the ones after it, by the
// API's own timing rather than ours. Asking it something trivial while the first page is still
// loading means the caller never pays for that.
let warmed = false;
// The frame a password manager's extension puts under a login field to list the saved logins
// (Bitwarden's in-page menu).
const PASSWORD_MENU = /^(chrome|moz)-extension:\/\/[^/]+\/(overlay\/)?menu-list\.html/;
// Requests are capped at 32,768 input tokens, and text in scripts such as Arabic costs several
// times more tokens per character than English, so sizes are estimated in tokens, not characters.
const TOKEN_BUDGET = 26_000;     // leaves room for the questions and the estimate being off
const SINGLE_STAGE_TOKENS = 17_000;
export function estimateTokens(s) {
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3.5 + (s.length - ascii) / 1.2);
}

// Cut a request's state down to `budget` tokens: the element list first (halved, then dropped),
// unless a question picks from it, then the page text.
export function fitState(state, questions, budget = TOKEN_BUDGET) {
  const size = () => estimateTokens(JSON.stringify({ state, questions }));
  const picks = Object.values(questions).some(q => q.type === "choice" && /page\.elements/.test(q.instructions ?? ""));
  while (state.page && size() > budget) {
    const p = state.page;
    if (!picks && p.elements?.length > 40) state = { ...state, page: { ...p, elements: p.elements.slice(0, Math.ceil(p.elements.length / 2)), repeated_elements: undefined } };
    else if (!picks && p.elements) state = { ...state, page: { ...p, elements: undefined, repeated_elements: undefined } };
    else if (p.text?.length > 400) state = { ...state, page: { ...p, text: p.text.slice(0, Math.floor(p.text.length / 2)) } };
    else break;
  }
  return state;
}
const GROUP = 30;
// A long dropdown goes to Jev as summaries of groups of options: at most this long each, and all of
// them together, so the request stays well under the cap.
const SUMMARY_CHARS = 700, ALL_SUMMARIES = 36_000;

// The site a host name belongs to, as password managers match logins by default: the name
// registered under a public suffix, so mail.google.com is google.com while alice.github.io and
// bob.github.io are two sites. A host without one (localhost, an IP address) stands for itself.
export function siteOf(host) {
  const h = host.toLowerCase();
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

// Why an action failed, cut down to what Jev can use in the next round.
export function actionError(e) {   // e: whatever Playwright threw
  const said = String(e?.message ?? e);
  if (/intercepts pointer events/i.test(said)) return "click blocked: another element (a modal, overlay or banner) covers the target";
  if (/not visible|element is not attached/i.test(said)) return "target is not visible or no longer on the page";
  if (/disabled|not enabled/i.test(said)) return "target is disabled";
  return said.split("\n")[0].slice(0, 160);
}

// True when the last `times * k` entries of seq are one k-long block repeated `times` times.
export function repeatsBlock(seq, k, times) {   // does the last run of k items come round `times` times?
  const span = k * times;
  if (seq.length < span) return false;
  const tail = seq.slice(-span), block = tail.slice(0, k);
  if (k > 1 && new Set(block).size === 1) return false;   // one action over and over is the k = 1 case
  const first = block.join("\n");
  for (let n = 1; n < times; n++) if (tail.slice(n * k, (n + 1) * k).join("\n") !== first) return false;
  return true;
}

// "… , and does …": an "and" followed by the start of another question, not one inside a phrase
// ("terms and conditions", "black and white").
const JOINED_CLAUSES = /,?\s+and\s+(?=(?:is|are|does|do|did|has|have|was|were|will|can|should|the|it|there)\b)/i;

// Actions that leave the page broadly where it was, so an answer asked for while it settles is
// probably still about the page in front of us when it arrives.
const GUESSABLE = new Set(["type", "press_key", "hover", "scroll", "wait"]);

// Enough of a page to tell whether the one a question was asked about is still the one in front of
// us: its address, how much text it holds, and what its controls are called.
const samePage = page => `${page.url}|${page.text.length}|${page.elements.map(e => brief(e)).join("~")}`;

// the tools that carry one of the caller's values
const VALUED = ["type", "select", "upload"];
// What an action comes down to, for telling one round's action from another's.
const actionId = act => `${act.tool}|${brief(act.el)}|${VALUED.includes(act.tool) ? act.valueKey ?? "" : ""}`;

// Keys for a choice question: one entry per item, named by the given field.
const byNumberedKeys = (items, field) => Object.fromEntries(items.map(item => [String(item[field]), null]));

// The likeliest answers to a choice question: enough of them to hold `mass` of the probability and
// never more than `most`. A summary can mislead, so the runner-up stays in the running.
function likeliest(probabilities, { most, mass: wanted }) {
  const ranked = Object.entries(probabilities ?? {}).sort(([, a], [, b]) => b - a);
  const picked = [];
  let mass = 0;
  for (const [key, p] of ranked) {
    if (picked.length && (mass >= wanted || picked.length >= most)) break;
    picked.push(+key);
    mass += p;
  }
  return picked;
}

export class Barq {
  // userDataDir keeps a profile on disk, so logins outlast a restart; browser shares one Chromium between tabs.
  // highlight draws Jev's decision around each target just before it is acted on, for a run you watch.
  // recipes -> a RecipeBook: steps that finished are recorded and replayed (none by default).
  static async launch(options = {}) {
    const { headed = false, slowMo = 0, viewport = { width: 1280, height: 800 }, storageState, browser, userDataDir, highlight = false, recipes = null } = options;
    let context, launchedBrowser = false, chrome = browser;
    try {
      if (userDataDir) {
        context = await chromium.launchPersistentContext(userDataDir, { viewport, slowMo, headless: !headed });
      } else {
        launchedBrowser = !chrome;
        chrome ??= await chromium.launch({ headless: !headed, slowMo });
        context = await chrome.newContext({ viewport, storageState });
      }
    } catch (e) {
      const said = String(e.message);
      if (/Executable doesn't exist|browserType\.launch/i.test(said) && /install/i.test(said)) throw new Error("Chromium for Playwright is not installed. Run: npx playwright install chromium");
      throw e;
    }
    const b = new Barq(context.pages()[0] ?? await context.newPage(), { context, browser: chrome, ownContext: true, ownBrowser: launchedBrowser, recipes });
    b.highlight = highlight;
    await b.ready;
    return b;
  }

  // Drive a tab someone else created: a pooled tab, or one in a browser the user already runs.
  // Everything this installs is scoped to that tab and the tabs it opens, never to the context,
  // because in an attached browser the context is the user's own profile.
  // front: brings a background tab forward for a moment and returns the undo (see autofill)
  static async forPage(page, { highlight = false, front = null, recipes = null } = {}) {
    const b = new Barq(page, { recipes });
    b.highlight = highlight; b.front = front;
    await b.ready;
    return b;
  }

  constructor(page, { context = page.context(), browser = null, ownContext = false, ownBrowser = false, recipes = null } = {}) {
    Object.assign(this, { browser, context, ownContext, ownBrowser, recipes });
    this.frames = new Map(); this.inflight = new Map(); this.lastPage = null; this.events = []; this.pageErrors = [];
    this.shown = null;   // the listing the caller's element numbers refer to
    this.dialogPolicy = SAFE_DIALOGS;   // until a step says otherwise
    this.request = jev;              // the decision model's API, replaceable in tests
    this.passwordMenu = PASSWORD_MENU; // the frame a password manager lists its logins in
    this.stats = { tokens: 0, jev_ms: 0, calls: 0 };
    this.pages = [];                 // this session's tabs: the first one plus any it opened
    // lastActionAt: when the last action started (requests from then on count); lastActionEnd: when
    // it finished (work it schedules a moment later is waited for); lastChangeAt: the last DOM
    // change reported from any frame
    this.popupArrivedAt = 0; this.lastActionAt = 0; this.lastActionEnd = 0; this.lastChangeAt = 0; this.settleWaiters = new Set();
    this.waitUntil = 0;              // while a settle() waits: when it gives up
    this.frameIds = new WeakMap(); this.nextFrameId = 1;
    this.callSignal = null;          // set by a caller that can time out or cancel the current call
    this.crashed = false;
    this.lateWatchMs = POST_ACTION_MS;   // how long the page is watched after the last action
    this.progress = null;        // what a step in flight has done, for a caller that gives up first
    this.page = page;
    this.ready = this.adopt(page);
  }

  async adopt(p) {
    this.pages.push(p);
    // scripts count too: an app that loads its code on demand isn't there until the chunk runs
    // A request counts while it's young: a long-poll isn't loading. A script from another site
    // (ads, analytics, widgets, or the site's own CDN) counts for a second at most: long enough
    // for code the page needs, too short for a lazy tracker to hold up the step.
    const track = r => {
      const type = r.resourceType();
      if (!["fetch", "xhr", "document", "script"].includes(type)) return;
      let young = 5000;
      if (type === "script") {
        try { if (siteOf(new URL(r.url()).hostname) !== siteOf(new URL(r.frame().url()).hostname)) young = 1000; } catch {}
      }
      this.inflight.set(r, { at: Date.now(), young }); this.wakeSettle();
    };
    const untrack = r => { if (this.inflight.delete(r)) this.wakeSettle(); };
    p.on("request", track); p.on("requestfinished", untrack); p.on("requestfailed", untrack);
    p.on("popup", np => { this.popupArrivedAt = Date.now(); this.events.push(`new tab opened: ${np.url()}`); this.page = np; this.wakeSettle(); this.adopt(np).catch(() => {}); });
    p.on("dialog", async d => {
      // a confirm or a prompt is often the site asking "are you sure?" before it deletes or charges
      const accept = await (async () => this.dialogPolicy(d))().catch(() => false);
      this.events.push(`${d.type()} dialog "${d.message().slice(0, 100)}" ${(accept && "accepted") || "dismissed"}`);
      await (accept ? d.accept(this.promptText ?? undefined) : d.dismiss()).catch(() => { /* already answered or gone */ });
    });
    // What the site's own code reported going wrong: an uncaught error, a console error, a request
    // the server refused. A step that "did nothing" often did, and this says why. Other sites' ads
    // and trackers fail all the time, so only the page's own site is counted.
    const own = url => { try { return siteOf(new URL(url).hostname) === siteOf(new URL(p.url()).hostname); } catch { return false; } };
    const report = (kind, text) => {
      text = String(text).replace(/\s+/g, " ").slice(0, 200);
      if (this.pageErrors.length < 10 && !this.pageErrors.some(e => e.text === text)) this.pageErrors.push({ kind, text });
    };
    p.on("pageerror", e => report("error", e.message));
    p.on("console", m => { if (m.type() === "error" && (!m.location()?.url || own(m.location().url))) report("console", m.text()); });
    p.on("response", r => {
      if (r.status() >= 400 && ["fetch", "xhr", "document"].includes(r.request().resourceType()) && own(r.url())) report("http", `${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`);
    });
    p.on("requestfailed", r => {
      const why = r.failure()?.errorText ?? "";
      if (!/ABORTED/i.test(why) && ["fetch", "xhr", "document"].includes(r.resourceType()) && own(r.url())) report("network", `${why} ${r.url().slice(0, 120)}`);
    });
    p.on("crash", () => { if (this.page === p) this.crashed = true; });
    p.on("close", () => {
      if (this.page !== p) return;
      const rest = this.pages.filter(x => !x.isClosed());
      if (rest.length) { this.page = rest.at(-1); this.events.push("tab closed; switched to previous tab"); }
    });
    p.on("domcontentloaded", () => this.wakeSettle());
    // a document that arrives while settle() waits has to report its changes too
    p.on("framenavigated", f => {
      if (this.waitUntil > Date.now()) f.evaluate(v => { window.__jevWaiting = v; }, this.waitUntil).catch(() => {});
      this.wakeSettle();
    });
    await p.exposeBinding("__jevChanged", () => { this.lastChangeAt = Date.now(); this.wakeSettle(); });
    await p.addInitScript(WATCH_MUTATIONS);
    // the documents already loaded (or loading) in this tab's frames missed the init script
    await Promise.all(p.frames().map(f => f.evaluate(WATCH_MUTATIONS).catch(() => {})));
  }

  wakeSettle() { for (const wake of this.settleWaiters) wake(); }

  // Until when the frames of these tabs should report DOM changes (0: stop). Returns the ms since
  // the latest change in any of them, so a change in a frame just before settle() still counts.
  // A frame that doesn't answer quickly (busy, or between documents) is skipped.
  async watching(pages, until) {
    const frames = [...new Set(pages)].filter(p => !p.isClosed()).flatMap(p => p.frames());
    const idle = await Promise.all(frames.map(f => Promise.race([f.evaluate(v => {
      window.__jevWaiting = v;
      return window.__jevMut == null ? null : performance.now() - window.__jevMut;
    }, until).catch(() => null), sleep(500).then(() => null)])));
    return Math.min(...idle.filter(ms => ms != null));
  }

  // Settled = the document has finished loading; no document, fetch, xhr or script request the
  // last action started is still running (young ones only: a long-poll is not "loading"; a script
  // from another site for a second at most; given up after about 3 s); the DOM in every frame has been quiet for `quiet` ms, and at least
  // POST_ACTION_MS have passed since the last action ended, for work a click schedules a moment
  // later (a page that never stops changing gets about 1.5 s); and no new tab a click asked for is
  // still on its way. Everything is capped at `max` and at the step's deadline.
  async settle({ quiet = 150, max = 8000 } = {}) {
    const t0 = Date.now(), since = this.lastActionAt || t0 - 3000;
    const end = t0 + Math.min(max, this.timeLeft()), domEnd = Math.min(end, t0 + 1500), netEnd = Math.min(end, t0 + 3000);
    const first = this.page;
    this.waitUntil = end;
    const idle = await this.watching([first], end);
    this.lastChangeAt = Math.max(this.lastChangeAt, Date.now() - idle);
    try {
      while (Date.now() < end && this.timeLeft() > 0) {
        let wake, timer;
        const changed = new Promise(resolve => { wake = resolve; });
        this.settleWaiters.add(wake);
        const abort = this.callSignal;
        abort?.addEventListener("abort", wake, { once: true });
        try {
          const p = this.page;
          let loading = false, idle = 0, popupAt = 0;
          // a page whose main thread is busy can't answer; that counts as still changing, not as
          // a reason to wait on it without limit
          const seen = await Promise.race([
            p.evaluate(() => [document.readyState === "loading", performance.now() - (window.__jevMut ?? 0), window.__jevPopupAt ?? 0]).catch(() => null),
            sleep(500).then(() => null),
          ]);
          if (seen) [loading, idle, popupAt] = seen;
          if (p !== this.page) continue;
          const now = Date.now();
          idle = Math.min(idle, now - this.lastChangeAt);
          const afterAction = this.lastActionEnd ? now - this.lastActionEnd : Infinity;
          const domWait = now < domEnd ? Math.max(quiet - idle, (this.lateWatchMs ?? POST_ACTION_MS) - afterAction, 0) : 0;
          const counted = [...this.inflight.values()].filter(q => q.at >= since && now - q.at < q.young);
          const netPending = now < netEnd && counted.length > 0;
          const popupPending = popupAt > this.popupArrivedAt && now - popupAt < 3000;
          if (!loading && !domWait && !netPending && !popupPending) break;
          const delay = Math.min(end - now, this.timeLeft(),
            loading ? 100 : Infinity,
            domWait ? Math.min(domWait, domEnd - now) : Infinity,
            netPending ? Math.min(netEnd, Math.max(...counted.map(q => q.at + q.young))) - now : Infinity, popupPending ? popupAt + 3000 - now : Infinity);
          timer = setTimeout(wake, Math.max(0, delay));
          await changed;
        } finally {
          clearTimeout(timer); this.settleWaiters.delete(wake);
          abort?.removeEventListener("abort", wake);
        }
      }
    } finally { this.waitUntil = 0; await this.watching([first, this.page], 0); }
    return Date.now() - t0;
  }

  async open(url) {
    const t0 = Date.now();
    if (!warmed) {
      warmed = true;
      this.request({ page: { url: "about:blank" } }, { q: { type: "noul", instructions: "Answer about `page`: is this page blank?" } }, { retries: 0, timeout: 8000 }).catch(() => {});
    }
    this.breakFlow();
    this.shown = null;                   // the numbers from the page we are leaving mean nothing here
    this.lastActionAt = t0;
    await this.page.goto(url, { timeout: 30_000, waitUntil: "commit" });
    await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => { /* read the page as it is */ });
    // The watch for late work starts when the document is ready, not when the response arrived: an
    // entry ad, a cookie wall or a consent banner is scheduled from the page's own load, and a
    // first look taken before it lands decides against a page that is still being built.
    this.lateWatchMs = POST_ACTION_MS;
    this.lastActionEnd = Date.now();
    await this.settle();
    const r = { url: this.page.url(), title: await this.page.title(), ms: Date.now() - t0 };
    // Some sites serve an empty page to headless or automated browsers, and settle() can't tell
    // that apart from a quiet page, so say so instead of letting the next step fail oddly.
    if (!r.url.startsWith("about:") && await this.page.evaluate(() => !document.body?.innerText.trim()).catch(() => false)) {
      r.warning = "The page rendered no text. Some sites show nothing to headless or automated browsers: try it headed (BARQ_HEADED=1) or in your own browser (BARQ_ATTACH).";
    }
    return r;
  }

  // The number an element's `frame` shows. A frame keeps its number while it lives, and a frame
  // that takes the place of one that went away gets a new one, so an element number from an
  // earlier snapshot can't be matched to a look-alike in the wrong frame. The main frame has none.
  frameId(f) {
    if (!f.parentFrame()) return 0;
    if (!this.frameIds.has(f)) this.frameIds.set(f, this.nextFrameId++);
    return this.frameIds.get(f);
  }

  // Whether the page actually shows a frame. Elements inside an iframe lay out in their own
  // document whatever the parent does with it, so a menu the user has closed, a zero-sized shell or
  // a panel parked off the side of the page would otherwise pour its contents into every snapshot:
  // on a signed-in Google page that is a 44-entry app grid nobody can see or click.
  async frameIsShown(frame) {
    const holder = await frame.frameElement().catch(() => null);
    if (!holder) return false;
    try {
      return await holder.evaluate(el => {
        const r = el.getBoundingClientRect();   // its box on screen
        if (Math.min(r.width, r.height) < 1) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || +style.opacity <= 0.05) return false;
        // off the side or above the page rather than merely further down it, which scrolling reaches
        const page = el.ownerDocument.documentElement;
        if (!(r.right > 0 && r.bottom > 0 && r.left < page.scrollWidth && r.top < page.scrollHeight)) return false;
        // an ancestor can clip it away without touching its own box, so hit-test the middle where
        // that can be done; a frame further down the page has no point to test and is kept
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
        // a hit-test that lands on an ancestor means the frame itself isn't there to be hit
        const onTop = el.ownerDocument.elementFromPoint(x, y);
        return onTop === el || el.contains(onTop);
      });
    } catch { return false; } finally { await holder.dispose().catch(() => {}); }
  }

  async snapshot() {
    const main = this.page.mainFrame();   // the top document; frames are read after it
    const rest = this.page.frames().filter(f => f !== main && !f.isDetached());
    const elements = [], frameUrls = new Map();
    let start = 0, top;
    this.frames = new Map();

    // The main frame first, so its elements keep the low numbers; every frame continues the count
    // where the last one left off, which is what makes one number mean one element page-wide.
    const shown = await Promise.all(rest.map(f => this.frameIsShown(f).catch(() => false)));
    const worth = new Set(rest.filter((_, k) => shown[k]));

    for (const frame of [main, ...rest]) {
      if (frame !== main && !worth.has(frame)) continue;
      let listed;
      try { listed = await frame.evaluate(ENUMERATE, { start, frame: this.frameId(frame) || undefined }); } catch { continue; }
      if (frame === main) top = listed;
      else if (!listed.elements.length) continue;                       // an empty frame isn't worth an address
      else frameUrls.set(this.frameId(frame), listed.url);
      for (const e of listed.elements) this.frames.set(e.i, frame);
      elements.push(...listed.elements);
      start = listed.next;
    }

    const page = {
      url: top?.url ?? this.page.url(),
      title: top?.title ?? "",
      text: top?.text ?? "",
      metrics: { ...top?.metrics, elements: elements.length },
      elements,
    };
    // each frame's address, by the number its elements' `frame` shows: for recipes, not for Jev
    Object.defineProperty(page, "frameUrls", { value: frameUrls });
    const repeated = repeatedElements(elements);
    if (repeated) page.repeated_elements = repeated;
    if (top?.dialogs?.length) page.dialogs = top.dialogs;
    this.lastPage = page;
    return page;
  }

  // barq works in the tabs it opens and cannot see the ones the user already has, so a caller that
  // expected to find the page in front of them finds a blank tab instead. Worth saying out loud.
  onBlankTab() {
    const url = this.page.url();
    return !url || url === "about:blank";
  }

  async snapshotText() { await this.settle(); const listed = await this.snapshot(); this.shown = listed; return formatPage(listed); }

  // The tools the current tab's site offers through WebMCP. The protocol session is opened on
  // first use; enabling it reports the tools already registered.
  async siteTools() {
    this.siteToolsFor ??= new WeakMap();
    let tools = this.siteToolsFor.get(this.page);
    if (!tools) {
      tools = await SiteTools.attach(this.page);
      this.siteToolsFor.set(this.page, tools);
      await sleep(50);
    }
    return tools;
  }

  // The page's text, the whole page and not just the screen. With a question, only the passages
  // Jev picks as answering it; otherwise the text a page at a time (maxChars from offset), cut at
  // a line break. allRegions keeps navigation, sidebars and footers, which are left out by default.
  async read({ question, offset = 0, maxChars = 12_000, allRegions = false } = {}) {
    await this.settle();
    const blocks = await readBlocks(this.page);
    const base = { url: this.page.url(), title: await this.page.title().catch(() => "") };
    const kept = allRegions ? blocks : blocks.filter(b => ["main", "header", "frame"].includes(b.region));
    if (question) {
      const list = passages(kept);
      const r = await findPassages(question, list, (state, questions) => this.call(state, questions));
      return { ...base, question, answered: r.answered, passages: r.passages.map(({ heading, text, p }) => ({ heading: heading || undefined, text, p })), searched: list.length, jev_calls: r.requests };
    }
    const text = toText(kept);
    let end = Math.min(text.length, offset + maxChars), next = end;
    if (end < text.length) { const nl = text.lastIndexOf("\n", end); if (nl > offset + maxChars / 2) { end = nl; next = nl + 1; } }
    return { ...base, text: text.slice(offset, end), offset, total_chars: text.length, ...(next < text.length ? { next_offset: next } : {}) };
  }

  async call(state, questions) {   // one request to Jev, counted and timed
    // An element's section heading is barq's own, for choosing which elements to ask about. Jev's
    // answers were tuned without it, and a new field in what it reads changes them.
    if (state?.page?.elements?.some(e => e.section != null)) {
      state = { ...state, page: { ...state.page, elements: state.page.elements.map(({ section, ...e }) => e) } };
    }
    const signals = [this.abort?.signal, this.callSignal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let r;
    try { r = await this.request(fitState(state, questions), questions, { signal }); }
    catch (e) {
      // the estimate was short for this page's text: once more at half the size
      if (!/max_tokens_exceeded/.test(e.message)) throw e;
      r = await this.request(fitState(state, questions, TOKEN_BUDGET / 2), questions, { signal });
    }
    this.stats.calls++; this.stats.jev_ms += r.ms; this.stats.tokens += r.tokens; this.stats.model = r.model;
    return r;
  }

  // Whatever is asked of the page as it stands, once it has stopped moving.
  async askPage(question, type, criteria) {
    await this.settle();
    const page = await this.snapshot();   // as it stands now
    const q = { type, instructions: `Answer about \`page\`: ${question}`, ...(criteria ? { criteria } : {}) };
    const { answers } = await this.call({ page }, { q });
    return answers.q;
  }

  // Two clauses joined by "and" are two questions. Asked as one they score near the middle even
  // when both halves are plainly true (0.21 on a page where the halves scored 0.90 and 0.98), so
  // they are asked apart, in a single request, and the answer is the weaker of the two.
  splitQuestion(question) {
    const parts = String(question).split(JOINED_CLAUSES).map(p => p.trim()).filter(Boolean);
    if (parts.length !== 2 || parts.some(p => p.length < 15)) return null;
    const [first, second] = parts;
    return [/[?.]$/.test(first) ? first : `${first}?`, second[0].toUpperCase() + second.slice(1)];
  }

  // Yes/no question about the current page -> the probability of yes, and the halves it was
  // answered in when the question asked about more than one thing.
  async checkDetailed(question) {
    const parts = this.splitQuestion(question);
    if (!parts) return { p_yes: (await this.askPage(question, "noul")).noul };

    await this.settle();
    const page = await this.snapshot();   // as it stands now
    const asked = Object.fromEntries(parts.map((q, k) => [`q${k}`, { type: "noul", instructions: `Answer about \`page\`: ${q}` }]));
    const { answers } = await this.call({ page }, asked);
    const halves = parts.map((question, k) => ({ question, p_yes: +answers[`q${k}`].noul.toFixed(3) }));
    return { p_yes: Math.min(...halves.map(h => h.p_yes)), parts: halves };
  }

  async check(question) {
    return (await this.checkDetailed(question)).p_yes;
  }

  // Which of `options` holds for the page in front of us. Options are a list, or names mapped to what each means.
  async choose(question, options) {   // -> { choice, probabilities }
    const criteria = Array.isArray(options) ? Object.fromEntries(options.map(name => [name, null])) : options;
    const { choice, probabilities, confidence } = await this.askPage(question, "choice", criteria);
    return { choice, probabilities, confidence };
  }

  // Consecutive elements summarised one line each, so a long page can be narrowed in one question.
  groupsOf(elements) {
    const groups = [];
    for (let k = 0; k < elements.length; k += GROUP) {
      const run = elements.slice(k, k + GROUP);
      const summary = run.map(e => (e.label || e.text || e.placeholder || e.href || e.tag).slice(0, 24)).join(" | ").slice(0, 700);
      groups.push({ g: groups.length, summary });
    }
    return groups;
  }

  // The questions asked every round, whatever size the page is. The wording is the prompt: change
  // one of these and the benchmark is the only thing that can say whether it was an improvement.
  roundQuestions(jevValues, { atBottom = false } = {}) {
    const named = Object.keys(jevValues).length > 0;
    // a page with nothing below the fold has nothing to scroll to, and an action that cannot
    // change anything is an invitation to repeat it
    const tools = atBottom ? Object.fromEntries(Object.entries(TOOLS).filter(([name]) => name !== "scroll")) : TOOLS;
    const withValues = named ? ", with the given `task.values`" : "";
    const questions = {
      done: { type: "noul", instructions: `Is there visible evidence in \`page.text\` and \`page.elements\` that \`task.goal\` has been achieved${withValues}?` },
      done_change: { type: "noul", instructions: `Is there visible evidence in \`page.text\`, \`page.elements\` and \`task.last_change\` (what the last action changed) that \`task.goal\` has been achieved${withValues}?` },
      blocked: { type: "noul", instructions: "Does `page` hold something that stops `task.goal` from going any further and that no click or typing can get past, such as a captcha, an access-denied notice or an error page?" },
      error: { type: "noul", instructions: "Is `page` showing an error or a refusal that the actions in `task.history` brought about, such as wrong credentials, a validation message or a not-found notice?" },
      login: { type: "noul", instructions: "Before `task.goal` can go on, is `page` a sign-in or sign-up screen, or asking the user to log in?" },
      irreversible: { type: "noul", instructions: "Would the next step toward `task.goal` on `page` do something outside this browser that is hard to take back, like placing an order, paying, sending a message, deleting data or publishing?" },
      tool: { type: "choice", instructions: "What is the next action toward `task.goal` on `page`, given what `task.history` already did?", criteria: tools },
    };
    if (named) questions.value = { type: "choice", instructions: "If the next action toward `task.goal` types, selects or uploads something, which of `task.values` should it use? Prefer values not yet entered on `page`.", criteria: jevValues };
    return questions;
  }

  // Enough of a page to tell whether the one a decision was made on is still the one in front of
  // us: its address, how much text and how many controls it has, and what they are called.
  async decide(page, goal, values, history, lastChange, count) {
    const jevValues = forJev(values);   // names always, contents only when not secret
    const task = {
      goal,
      ...(Object.keys(values).length ? { values: jevValues } : {}),
      history,
      ...(lastChange ? { last_change: lastChange } : {}),
      ...(count ? { count } : {}),
    };
    const common = this.roundQuestions(Object.keys(values).length ? jevValues : {}, { atBottom: !!page.metrics?.at_bottom });
    const targetQ = { type: "choice", instructions: "Which element in `page.elements`, given by its `i`, should the next step toward `task.goal` be taken on?" };
    const byNumber = els => Object.fromEntries(els.map(e => [String(e.i), null]));

    // One question covers the page when the elements fit the cap. A page a little over it is
    // trimmed to the ones the goal is most likely to be about rather than split in two, since
    // splitting costs a second call on every round for the rest of the step.
    const asked = likelyFor(page.elements, goal, MAX_SINGLE);
    // at_bottom is barq's own business, for deciding whether scrolling is worth offering; sending
    // it would put a second, weaker opinion about "is there more" in front of the model
    const { at_bottom, ...metrics } = page.metrics ?? {};
    const shown = { ...page, metrics };
    const onePage = asked === page.elements ? shown : { ...shown, elements: asked };
    if (asked.length <= MAX_SINGLE && estimateTokens(JSON.stringify(onePage)) <= SINGLE_STAGE_TOKENS) {
      targetQ.criteria = byNumber(asked);
      const r = await this.call({ page: onePage, task }, { ...common, ...(asked.length ? { target: targetQ } : {}) });
      return { ...r.answers, stages: 1, ...(asked.length < page.elements.length ? { elements_considered: asked.length } : {}) };
    }

    // Otherwise in two: which run of elements holds the answer, then which element in those runs.
    const groups = this.groupsOf(page.elements);
    const outline = { url: page.url, title: page.title, text: page.text, metrics, dialogs: page.dialogs, groups };
    const first = await this.call({ page: outline, task }, {
      ...common,
      group: { type: "choice", instructions: "Which entry of `page.groups` (by its `g`) contains the element the next action toward `task.goal` should act on? Each group summarises consecutive page elements.", criteria: byNumberedKeys(groups, "g") },
    });

    const considered = likeliest(first.answers.group.probabilities, { most: 4, mass: 0.9 });
    // likeliest group first, so what a size cap cuts is the least likely group's tail
    let shortlist = considered.flatMap(g => page.elements.filter(e => Math.floor(e.i / GROUP) === g)).slice(0, MAX_SINGLE);
    while (shortlist.length > GROUP && estimateTokens(JSON.stringify(shortlist)) > SINGLE_STAGE_TOKENS) shortlist = shortlist.slice(0, Math.ceil(shortlist.length * 0.75));

    const second = await this.call(
      { page: { url: page.url, title: page.title, text: page.text.slice(0, 1200), elements: shortlist }, task },
      { target: { ...targetQ, criteria: byNumber(shortlist) } },
    );
    return { ...first.answers, target: second.answers.target, stages: 2, groups_considered: considered };
  }

  // The option of a native <select> to choose for the goal: { i (its index), label, value, group }.
  async chooseOption(page, goal, el) {
    let options = await this.locate(el.i).evaluate(sel => [...sel.options].map((o, i) => ({
      i, label: o.label, value: o.value, group: o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : undefined,
      disabled: o.disabled || !!o.parentElement.disabled,
    })).filter(o => !o.disabled), undefined, { timeout: 2000 }).catch(e => { throw new Error(`the dropdown's options could not be read: ${actionError(e)}`); });
    if (!options.length) throw new Error("dropdown has no enabled options");
    // the dropdown matters here, not the rest of the page: only enough of it to know where we are
    const context = { url: page.url, title: page.title, text: page.text.slice(0, 1200) };
    const task = { goal }, dropdown = { ...el, options: undefined };
    while (options.length > MAX_SINGLE) {
      const size = Math.max(GROUP, Math.ceil(options.length / MAX_SINGLE)), groups = [];
      const chars = Math.min(SUMMARY_CHARS, Math.floor(ALL_SUMMARIES / Math.ceil(options.length / size)));
      for (let k = 0; k < options.length; k += size) groups.push({ g: groups.length, summary: optionSummary(options.slice(k, k + size), chars) });
      const { answers } = await this.call({ page: context, task, dropdown: { ...dropdown, groups } }, {
        group: { type: "choice", instructions: "Which entry of `dropdown.groups` (by its `g`) contains the option to choose for `task.goal`? Each group summarises consecutive dropdown options; \"…\" marks options left out of the summary.", criteria: Object.fromEntries(groups.map(g => [String(g.g), null])) },
      });
      const keep = new Set(likeliest(answers.group.probabilities ?? { [answers.group.choice]: 1 }, { most: 3, mass: 0.9 }));
      options = options.filter((o, k) => keep.has(Math.floor(k / size)));
    }
    const shown = options.map(o => ({
      i: o.i, label: clipMiddle(o.label, 80),
      ...(o.value && o.value !== o.label ? { value: clipMiddle(o.value, 40) } : {}),
      ...(o.group ? { group: clipMiddle(o.group, 40) } : {}),
    }));
    const { answers } = await this.call({ page: context, task, dropdown: { ...dropdown, options: shown } }, {
      opt: { type: "choice", instructions: "Which entry of `dropdown.options` (by its `i`) should be chosen for `task.goal`? An option's `group` is the heading it is listed under.", criteria: Object.fromEntries(options.map(o => [String(o.i), null])) },
    });
    const option = options.find(o => String(o.i) === answers.opt.choice);
    if (!option) throw new Error("no matching dropdown option");
    return option;
  }

  // Jev answers "which action", "which element" and "which value" as separate questions. Put
  // together they can contradict each other, so this settles them into one action that the page
  // can actually take.
  resolve(page, answers, values, { typedInto = null } = {}) {
    const elementOf = new Map(page.elements.map(e => [String(e.i), e]));
    const ranked = answers.target ? Object.entries(answers.target.probabilities).sort(([, a], [, b]) => b - a) : [];
    let tool = answers.tool.choice;
    let [number, p] = ranked[0] ?? [null, 0];
    let ruled = null;

    // Enter straight after typing is what sends what was typed, so it goes to that field. Jev can be
    // sure it wants Enter and unsure where, and a checkbox next to a new todo is not where: the text
    // would sit in the box unsent while the step went on without it.
    if (tool === "press_enter" && typedInto && !FIELDISH(elementOf.get(number))) {
      const field = page.elements.find(e => FIELDISH(e) && brief(e) === typedInto);
      // chosen by that rule rather than guessed, so Jev's doubt about where does not carry over
      if (field) [number, p, ruled] = [String(field.i), 1, "the field just typed into"];
    }

    // a tool that only works on a certain kind of element: take the likeliest one it can work on
    const worksOn = {
      type: FIELDISH,
      // a text field, or a button Enter presses; never a checkbox, radio or file input
      press_enter: e => FIELDISH(e) || /^input:(submit|button|image|reset)$/.test(e?.tag ?? ""),
      select: SELECTISH,
      upload: FILEISH,
    }[tool];
    if (worksOn && number != null && !worksOn(elementOf.get(number))) {
      const instead = ranked.find(([i]) => worksOn(elementOf.get(i)));
      if (instead && (instead[1] >= 0.1 || tool === "upload")) [number, p] = instead;
      else if (tool === "upload") {
        const anyFileInput = page.elements.find(FILEISH);   // a file input is never ambiguous
        if (anyFileInput) [number, p] = [String(anyFileInput.i), 0.5];
      } else if (tool === "type" || tool === "select") tool = "click";
      // Enter goes to a field. Aimed at a menu entry or a button it does nothing at all, and the
      // thing meant by it is plainly a click on what was picked.
      else if (tool === "press_enter") tool = "click";
    }
    // nothing to type: the caller gave no values, so the goal itself is asked for the text later;
    // if that finds nothing either, the round falls back to clicking the field
    const typeNeedsText = tool === "type" && !Object.keys(values).length;

    // With secrets hidden Jev sees only the names of the values, so a password and its field can
    // come back crossed. A password goes in a password field, and a password field takes nothing else.
    let valueKey = answers.value?.choice;
    const isPasswordName = name => /pass|pwd/i.test(name);
    const isPasswordField = e => e?.tag === "input:password";
    if (tool === "type" && valueKey != null) {
      if (isPasswordName(valueKey) && !isPasswordField(elementOf.get(number))) {
        const field = ranked.map(([i]) => elementOf.get(i)).find(isPasswordField) ?? page.elements.find(isPasswordField);
        if (field) [number, p] = [String(field.i), answers.target?.probabilities[String(field.i)] ?? p];
      } else if (!isPasswordName(valueKey) && isPasswordField(elementOf.get(number))) {
        valueKey = Object.keys(values).find(isPasswordName) ?? valueKey;
      }
    }

    return {
      tool,
      p_tool: answers.tool.probabilities[answers.tool.choice],
      target: number == null ? null : +number,
      p_target: p ?? 0,
      el: elementOf.get(number),
      valueKey,
      value: valueKey != null ? values[valueKey] : undefined,
      typeNeedsText,
      ...(ruled ? { target_by: ruled } : {}),
      candidates: ranked.slice(0, 3).map(([i, prob]) => ({ i: +i, p: +prob.toFixed(2), el: brief(elementOf.get(i)) })),
    };
  }

  locate(i) {
    const f = this.frames.get(i) ?? this.page.mainFrame();   // the frame that listed it
    return f.locator(`[data-jev-i="${String(i)}"]`).first();
  }

  // act = { tool, target?, value?, optionIndex?, key?, destination? }. settle() counts requests
  // from the start of an action and watches for work it schedules from its end, so a slow click
  // or long typing doesn't use up that watch.
  async act(act) {
    const t = Date.now(); this.lastActionAt = t;
    this.lateWatchMs = LANDS_QUIETLY.has(act.tool) ? BRIEF_WATCH_MS : POST_ACTION_MS;
    try { await this.perform(act); }
    finally { this.lastActionEnd = Date.now(); }
    return Date.now() - t;
  }

  // Type a value the way a person would: clear the field, then real key events, because some
  // widgets (date pickers, input masks) throw away a programmatic fill.
  async typeInto(loc, act, opts) {
    if (act.value == null) throw new Error("nothing to type: the step has no value for this field");
    const account = autofillAccount(act.value);
    if (account !== null) return this.autofill(loc, account || this.loginAccount || "");

    const text = await resolveValue(act.value);
    await loc.fill("", opts);
    // Keys go wherever the focus is, not to the field they were meant for. A page can move it the
    // moment the field is focused: a search box that opens its real search in an overlay, or a
    // popup that grabs the focus for its own button, where a space in the text would press it.
    // A field that takes over is typed into, since that is where the page wants the text; focus
    // anywhere else gets no keys at all, and the value is set on the field directly.
    const focus = await loc.evaluate(el => {
      let a = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      if (!a || a === el || el.contains(a)) return "here";
      return a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName) ? "field" : "elsewhere";
    }).catch(() => "here");
    if (focus === "field") return void await this.page.keyboard.type(text, { delay: 5 });
    if (focus === "elsewhere") return void await loc.fill(text, opts);
    // Some editors take a quarter of a second over each key, and a title typed key by key runs out
    // of time halfway, leaving the field cut short. Whatever the keys didn't finish is filled in
    // one go instead, which is the whole value.
    let typed = true;
    if (text.length <= 120) typed = await loc.pressSequentially(text, { delay: 5, ...opts }).then(() => true, e => { if (/timeout/i.test(e?.name ?? "") || /Timeout/.test(e?.message ?? "")) return false; throw e; });
    if (!typed || text.length > 120) await loc.fill(text, opts);
    // a masked or otherwise fussy field may have taken something else: put it right in one go
    const inField = await loc.inputValue({ timeout: 1000 }).catch(() => null);
    if (inField !== null && inField !== text) await loc.fill(text, opts);
    // A field that offers a list as you type takes its value from the list. The text on its own is
    // thrown away when the focus moves on, so the suggestion that starts with what was typed is
    // chosen now, while the list is open, rather than left for a later round that may never come.
    this.typedUnchosen = false;
    if (text && await this.offersList(loc)) this.typedUnchosen = !(await this.pickSuggestion(loc, text));
  }

  // A field that shows a list of suggestions to pick from as you type. A query box is left out: its
  // suggestions are shortcuts to other queries, and running what was typed is what the goal wants.
  // A search form is not a query box: a flight search's "Where to?" takes its value from the list.
  offersList(loc) {
    return loc.evaluate(el => {
      const words = `${el.name ?? ""} ${el.id ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.placeholder ?? ""}`.toLowerCase();
      if (el.type === "search" || el.tagName === "TEXTAREA" || el.getAttribute("role") === "searchbox"
        || /(^|[^a-z])(q|query|keywords?|search\w*)([^a-z]|$)/.test(words)) return false;
      const auto = el.getAttribute("aria-autocomplete");
      return el.getAttribute("role") === "combobox" || auto === "list" || auto === "both"
        || el.getAttribute("aria-haspopup") === "listbox" || !!el.parentElement?.closest("[role=combobox]");
    }).catch(() => false);
  }

  // Choose the first suggestion that starts with `text`, in the order the site ranks them. Only a
  // suggestion that starts with what was typed is taken; anything else is left to the next round.
  async pickSuggestion(loc, text) {
    const want = text.replace(/\s+/g, " ").trim().toLowerCase();
    const until = Date.now() + SUGGESTIONS_MS;
    let listedAt = 0;
    while (Date.now() < until) {
      const found = await loc.evaluateHandle((el, want) => {
        const ids = `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-owns") ?? ""}`.split(/\s+/).filter(Boolean);
        const lists = ids.map(id => document.getElementById(id)).filter(Boolean);
        const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const words = e => (e.innerText || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
        // the list the field names first; a field can name a list that isn't the one on screen
        const listed = scope => scope.flatMap(l => [...l.querySelectorAll("[role=option]")]).filter(shown);
        const own = listed(lists);
        const options = own.length ? own : listed([document]);
        return { match: options.find(o => words(o).startsWith(want)) ?? null, count: options.length };
      }, want).catch(() => null);
      const match = await found?.getProperty("match").then(m => m.asElement()).catch(() => null);
      const count = await found?.getProperty("count").then(c => c.jsonValue()).catch(() => 0);
      await found?.dispose().catch(() => {});
      if (match) {
        // a list that redraws on every keystroke can replace the option under the click: look again
        const clicked = await match.click({ timeout: 2000 }).then(() => true, () => false);
        await match.dispose().catch(() => {});
        if (clicked) return true;
        await sleep(60);
        continue;
      }
      // a list that is showing and has had a moment to fill, with nothing that fits: stop waiting
      if (count) { listedAt ||= Date.now(); if (Date.now() - listedAt > 400) return false; }
      await sleep(60);
    }
    return false;
  }

  // Press a picker's own button on the step's behalf, recorded like any other action.
  async confirmPicker(button, history) {
    const label = await button.evaluate(b => (b.innerText || b.getAttribute("aria-label") || "").trim().split("\n")[0].slice(0, 40)).catch(() => "Done");
    const h = { action: "click", element: `button "${label}"`, confirms: "the picker the step chose in" };
    try { this.lastActionAt = Date.now(); await button.click({ timeout: 4000 }); await this.settle(); }
    catch (e) { h.error = actionError(e); }
    finally { this.lastActionEnd = Date.now(); await button.dispose().catch(() => {}); }
    history.push(h);
  }

  // The Done or Apply button of the picker dialog that `el` sits in, while that dialog is still
  // open, or null. Only a dialog that picks things (it holds a grid or a list of options) counts:
  // the OK of an "are you sure?" dialog is never pressed on the step's behalf.
  async unconfirmed(el) {
    if (!el) return null;
    const found = await el.evaluateHandle((node, source) => {
      if (!node.isConnected) return null;
      const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const box = node.closest('dialog[open], [role=dialog], [aria-modal="true"]');
      if (!box || !shown(box) || box.getAttribute("role") === "alertdialog") return null;
      if (!box.querySelector("[role=grid], [role=gridcell], [role=listbox], [role=option]")) return null;
      const re = new RegExp(source, "i");
      return [...box.querySelectorAll("button, [role=button]")]
        .find(b => b !== node && shown(b) && re.test((b.innerText || b.getAttribute("aria-label") || "").trim())) ?? null;
    }, CONFIRMS.source).catch(() => null);
    const button = found?.asElement();
    if (!button) await found?.dispose().catch(() => {});
    return button ?? null;
  }

  async selectOption(loc, act, opts) {
    if (act.optionIndex == null) {
      const label = String(act.value ?? "");
      return loc.selectOption({ label }, opts).catch(() => loc.selectOption(label, opts));
    }
    if (act.value == null) return loc.selectOption({ index: act.optionIndex }, opts);
    // The index was read a Jev call or two ago, and a dependent dropdown can have been refilled
    // since. Index and label must both still match, rather than selecting whatever sits there now.
    const label = String(act.value);
    const atIndex = await loc.evaluate((sel, i) => sel.options[i]?.label ?? null, act.optionIndex, { timeout: 2000 }).catch(() => undefined);
    if (atIndex !== undefined && atIndex !== label) throw new Error(`the dropdown changed since it was read: "${label.slice(0, 40)}" is no longer option ${act.optionIndex + 1}; look again`);
    return loc.selectOption({ index: act.optionIndex, label }, opts);
  }

  // A "checking your browser" page usually lets a real browser through by itself within a few
  // seconds. Calling that blocked sends the caller away from a site that was about to open, so it is
  // given up to 8 seconds to clear, once per step. True when the page moved on.
  async wallClears() {
    const WALL = /just a moment|checking your browser|verify(ing)? you are (a )?human|one more step|ddos protection|please wait while we/i;
    const looks = () => this.page.evaluate(() => document.title + " " + (document.body?.innerText ?? "").slice(0, 400)).catch(() => "");
    if (!WALL.test(await looks())) return false;
    for (const until = Date.now() + 8000; Date.now() < until;) {
      await sleep(500);
      if (!WALL.test(await looks())) { await this.settle({ max: 3000 }); return true; }
    }
    return false;
  }

  async perform(act) {
    const wantsTarget = TARGETED.has(act.tool) || (act.tool === "press_key" && act.target != null);
    if (wantsTarget && act.target == null) throw new Error(`${act.tool} needs a target element`);
    const loc = wantsTarget ? this.locate(act.target) : null;
    const opts = { timeout: 4000 };

    switch (act.tool) {
      case "click": return void await loc.click(opts);
      case "right_click": return void await loc.click({ button: "right", ...opts });
      case "type": return void await this.typeInto(loc, act, opts);
      case "select": return void await this.selectOption(loc, act, opts);
      case "press_enter": return void await loc.press("Enter", opts);
      case "press_key": {
        const key = act.key || "Escape";
        return void await (loc ? loc.press(key, opts) : this.page.keyboard.press(key));
      }
      case "hover": return void await loc.hover(opts);
      case "drag": {
        if (act.destination == null) throw new Error("a drag has to say where to drop");
        return void await loc.dragTo(this.locate(act.destination), opts);
      }
      case "upload": {
        if (act.value == null) throw new Error("an upload needs the path of a file");
        if (await loc.evaluate(el => el.matches("input[type=file]"), null, opts)) return void await loc.setInputFiles(String(act.value), opts);
        // An "Upload" button that makes its own file input and clicks it: the picker it opens is
        // answered instead, since there is no input on the page to hand the file to.
        const [chooser] = await Promise.all([this.page.waitForEvent("filechooser", opts), loc.click(opts)]);
        return void await chooser.setFiles(String(act.value), opts);
      }
      case "scroll": return void await this.page.mouse.wheel(0, 700);
      case "wait": return void await sleep(1000);
      case "back": return void await this.page.goBack({ timeout: 10_000 }).catch(() => {});
      case "none": return;
      default: throw new Error(`no such action: ${act.tool}`);
    }
  }

  // Leave a field to the password manager. A real click is the user input these managers wait for:
  // the browser's own manager fills (or reveals what it filled on load), and a manager that shows
  // its logins in a menu under the field gets its first suggestion picked, the way a person would.
  // Only whether the field is now filled is read back, never what it holds.
  async autofill(loc, account = "") {
    // The manager's menu lists the logins of the tab in front: a tab in the background is brought
    // forward for the pick when it can be, then the user gets their tab back.
    let back = null;
    if (this.front && !(await this.page.evaluate(() => document.visibilityState === "visible").catch(() => true))) back = await this.front(this.page).catch(() => null);
    try { await this.fillFromManager(loc, account); } finally { await back?.(); }
  }

  async fillFromManager(loc, account) {
    // A field the browser filled on load may hold another account: with an account named, it is
    // cleared so the manager's pick decides. Once that account was picked in this step, the pick
    // already filled the rest of the form.
    if (account && this.loginPicked !== account) await loc.fill("", { timeout: 4000 });
    // Some managers only put their menu on the password field; picking a login there fills the
    // whole form, this field included. With such a field to try next, this one gets a short wait.
    const form = loc.locator("xpath=ancestor::form[1]");
    const pw = (await form.count().catch(() => 0) ? form : this.page).locator("input[type=password]").first();
    const next = await pw.count().catch(() => 0) && !(await pw.evaluate((p, el) => p === el, await loc.elementHandle()).catch(() => true));
    const first = await this.pickSavedLogin(loc, loc, next ? 1200 : 3000, account);
    // "nomenu": the field was filled already and no menu came up here; the password field's menu
    // gets its say before that login is kept
    const second = first !== true && next ? await this.pickSavedLogin(pw, loc, first === "nomenu" ? 1500 : 3000, account) : first;
    if (second === true || second === "nomenu") { this.loginPicked = account; return; }
    throw Object.assign(new Error("the password manager didn't fill this field: unlock it and save this login in it (Bitwarden: turn on \"Show autofill suggestions on form fields\"), or pass the value (or a keychain:/bw: reference)"), { code: "AUTOFILL_EMPTY" });
  }

  // Click `field` and, if the manager shows its menu of saved logins, pick one: the login matching
  // `account`, or the only one. True when `target` ends up filled. The menu can take a second or two
  // to appear after the click.
  async pickSavedLogin(field, target, wait = 3000, account = "") {
    // A field already filled (by the browser on load, or remembered) is kept only when the manager
    // has no choice to offer: with several saved logins it lists them, and the step asks which.
    const had = !account && await this.isFilled(target);
    const before = new Set(this.page.frames());
    await field.click({ timeout: 4000 });
    let picked = false, menuAt;
    const deadline = Date.now() + (had ? Math.min(wait, 1500) : wait);
    while (Date.now() < deadline) {
      if (had) { if (picked) return true; await sleep(150); }
      else if (await this.filledWithin(target, 150)) return true;
      if (picked) continue;
      // prefer a menu this click opened; the manager may also move its open one to this field
      const menu = this.page.frames().find(f => !before.has(f) && this.passwordMenu.test(f.url()))
        ?? this.page.frames().find(f => this.passwordMenu.test(f.url()));
      const box = menu && await (await menu.frameElement().catch(() => null))?.boundingBox().catch(() => null);
      if (!box || box.height < 20) continue;
      // The manager fills its menu with the logins of the tab in front, not of the tab the field is
      // in: from a tab in the background it would offer another site's passwords for this form.
      if (!(await this.page.evaluate(() => document.visibilityState === "visible").catch(() => false))) {
        await this.page.keyboard.press("Escape").catch(() => {});
        throw Object.assign(new Error("the password manager lists the logins of the tab in front, and this tab is in the background, so its menu can't be trusted here; pass a bw: or keychain: reference instead"), { code: "AUTOFILL_BACKGROUND" });
      }
      const at = await this.savedLoginRow(menu, account);
      // a menu still drawing its rows reads as unreadable: give it a moment before the fallback
      menuAt ??= Date.now();
      if (!at && Date.now() - menuAt < 600) continue;
      // a menu whose rows can't be read: its first row, clicked in the middle (the row fills the
      // login, its small buttons sit at the ends); never a guess when a particular account was asked for
      if (!at && account) throw Object.assign(new Error(`couldn't read the password manager's list of logins to pick "${account}"`), { code: "AUTOFILL_WHICH" });
      if (!at && had) return true;
      const [x, y] = at ?? [box.width / 2, Math.min(box.height / 2, 30)];
      await this.page.mouse.click(box.x + x, box.y + y);
      picked = true;
    }
    return had ? (picked || "nomenu") : this.filledWithin(target, 500);
  }

  async isFilled(loc) {
    return loc.evaluate(el => { let auto = false; try { auto = el.matches(":autofill"); } catch {} return auto || el.value.length > 0; }).catch(() => false);
  }

  // Where to click in the menu for the saved login to use, or null when its rows can't be read.
  // The menu keeps its rows in a closed shadow root that page scripts can't enter, so they are read
  // through the browser's protocol, which sees the whole tree. That tree comes back whole, a
  // one-time code a row may show included; only each login's name, username and icon site are
  // kept, and nothing else leaves this function.
  async savedLoginRow(menu, account) {
    const s = await this.page.context().newCDPSession(menu).catch(() => null);
    if (!s) return null;
    try {
      const { root } = await s.send("DOM.getDocument", { depth: -1, pierce: true });
      const attr = (n, k) => { const a = n.attributes ?? []; for (let i = 0; i < a.length; i += 2) if (a[i] === k) return a[i + 1]; };
      const kids = n => [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])];
      const find = (n, cls, out = []) => { if ((" " + (attr(n, "class") ?? "") + " ").includes(` ${cls} `)) out.push(n); for (const c of kids(n)) find(c, cls, out); return out; };
      const text = n => n.nodeType === 3 ? n.nodeValue : kids(n).map(text).join("");
      // each row's icon comes from its login's website, which says whose logins the menu lists
      const iconHost = b => { const icon = find(b, "cipher-icon")[0]; return icon && (attr(icon, "style") ?? "").match(/url\(["']?https?:\/\/[^/]+\/([^/"')]+)\/icon\.png/)?.[1]; };
      const rows = find(root, "fill-cipher-button").map(b => ({
        b, name: (find(b, "cipher-name").map(text)[0] ?? "").trim(), user: (attr(b, "aria-description") ?? "").replace(/^[^:]*:\s*/, "").trim(), host: iconHost(b),
      }));
      if (!rows.length) return null;
      const here = new URL(this.page.url()).hostname;
      if (rows.some(r => r.host && siteOf(r.host) !== siteOf(here))) {
        throw Object.assign(new Error(`the password manager's menu lists another site's logins (${[...new Set(rows.map(r => r.host).filter(Boolean))].join(", ")}): it shows the logins of the tab in front. Pass a bw: or keychain: reference instead`), { code: "AUTOFILL_BACKGROUND" });
      }
      let row = rows.length === 1 && !account ? rows[0] : null;
      if (account) {
        const want = account.toLowerCase(), is = v => v.toLowerCase() === want;
        const exact = rows.filter(r => is(r.user) || is(r.name));
        const hits = exact.length ? exact : rows.filter(r => `${r.name}\n${r.user}`.toLowerCase().includes(want));
        if (hits.length === 1) row = hits[0];
      }
      if (!row) {
        const accounts = rows.map(r => r.user ? `${r.name} (${r.user})` : r.name);
        throw Object.assign(new Error(account
          ? `no single saved login matches "${account}"; the saved logins are: ${accounts.join("; ")}`
          : `the password manager has ${rows.length} logins for this site: ${accounts.join("; ")}. Say which with "autofill:<part of its name or username>"`), { code: "AUTOFILL_WHICH", accounts });
      }
      await s.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: row.b.backendNodeId }).catch(() => {});
      const q = (await s.send("DOM.getBoxModel", { backendNodeId: row.b.backendNodeId })).model.border;
      return [(q[0] + q[4]) / 2, (q[1] + q[5]) / 2];
    } catch (e) {
      if (e.code?.startsWith("AUTOFILL_")) throw e;
      return null;
    } finally { await s.detach().catch(() => {}); }
  }

  async filledWithin(loc, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const filled = await loc.evaluate(el => { let auto = false; try { auto = el.matches(":autofill"); } catch {} return auto || el.value.length > 0; }).catch(() => false);
      if (filled) return true;
      await sleep(150);
    }
    return false;
  }

  // The numbers the caller saw may be out of date: the page moved on, or check() or choose() listed it
  // again. Number i on the listing the caller saw is found on a fresh one by what the element is called,
  // the text around it and its frame; the k-th of several look-alikes is still the k-th.
  currentElement(i, fresh) {
    const seen = this.shown ?? fresh;
    const address = url => { try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return url; } };
    if (address(seen.url) !== address(fresh.url)) throw new Error(`the page changed since element ${i} was listed (${seen.url} -> ${fresh.url}); take a new snapshot`);

    const wanted = seen.elements.find(e => e.i === i);
    if (!wanted) throw new Error(`element ${i} is not in the latest snapshot; take a new snapshot`);

    // Name, surrounding text and frame first; then the name and frame alone, since the text around
    // an element shifts whenever its neighbours do. Either way the k-th of a set of look-alikes is
    // only trusted while the set is still the same size.
    const withNear = e => `${brief(e)}|${e.near ?? ""}|${e.frame ?? ""}`;
    const nameOnly = e => `${brief(e)}|${e.frame ?? ""}`;
    for (const id of [withNear, nameOnly]) {
      const then = seen.elements.filter(e => id(e) === id(wanted));
      const now = fresh.elements.filter(e => id(e) === id(wanted));
      if (now.length === then.length) return now[then.indexOf(wanted)];
    }
    throw new Error(`element ${i} (${brief(wanted)}) is no longer on the page, or can't be told apart from similar ones; take a new snapshot`);
  }

  // The caller picks the element, from the latest snapshot or from browser_do's candidates, and Jev is not asked.
  // Confirm/prompt dialogs are dismissed unless acceptDialog. A control whose words commit money,
  // messages, posts or deletions is left alone unless allowIrreversible.
  async actOn({ action, element, value, key, destination, acceptDialog = false, allowIrreversible = false }) {
    const fresh = element != null || destination != null ? await this.snapshot() : null;
    const el = element == null ? undefined : this.currentElement(element, fresh);
    if (TARGETED.has(action) && !el) throw new Error(`${action} has to be given an element`);

    const commits = !allowIrreversible && GUARDED.has(action) ? commitsSomething(el, action) : null;
    if (commits) {
      return {
        status: "needs_confirmation", action, element: brief(el), because: `"${commits}"`,
        info: "this looks hard to undo; call again with allow_irreversible if the user wants it",
      };
    }

    const onto = destination == null ? undefined : this.currentElement(destination, fresh).i;
    this.breakFlow();
    this.dialogPolicy = acceptDialog ? ACCEPT_DIALOGS : SAFE_DIALOGS;   // for this one action
    // an account is only ever named by this call's own value
    this.loginAccount = null; this.loginConflict = null; this.loginPicked = null;

    this.lastActionAt = Date.now();
    let ms;
    try { ms = await this.act({ tool: action, target: el?.i, value, key, destination: onto }); }
    finally { this.dialogPolicy = SAFE_DIALOGS; }   // back to the default whatever happened

    await this.settle();
    const events = this.events.splice(0, this.events.length);
    return {
      action, element: brief(el), ms,
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      ...(events.length ? { events } : {}),
    };
  }

  // Work toward one goal.
  // It ends as one of: done, likely_done (check it), needs_confirmation, needs_login, error, blocked, stuck, ambiguous, max_actions.
  // timeoutMs bounds the whole step: rounds stop, an in-flight Jev request is cancelled, and the
  // result reports status "timeout" with whatever was done so far.
  async do(goal, opts = {}) {
    const { allowIrreversible = false, irreversibleAt = 0.6, timeoutMs } = opts;
    this.heldDialog = null;
    this.dialogPolicy = allowIrreversible ? ACCEPT_DIALOGS : this.dialogGuard(goal, irreversibleAt);   // for this step
    let timer;
    if (timeoutMs) {
      this.deadline = Date.now() + timeoutMs;
      this.abort = new AbortController();
      timer = setTimeout(() => this.abort.abort(new Error("step deadline reached")), timeoutMs);
    }
    try { const result = await this.runGoal(goal, opts); return result; }
    finally { this.dialogPolicy = SAFE_DIALOGS; clearTimeout(timer); this.deadline = null; this.abort = null; }
  }

  timeLeft() {
    if (this.callSignal?.aborted) return 0;
    return this.deadline ? Math.max(0, this.deadline - Date.now()) : Infinity;
  }

  // During do(), a confirm or prompt is accepted unless Jev judges that accepting would be hard to undo.
  dialogGuard(goal, irreversibleAt) {   // -> a dialog policy for one step
    return async dialog => {
      if (SAFE_DIALOGS(dialog)) return true;
      const asked = { task: { goal }, dialog: { type: dialog.type(), message: dialog.message().slice(0, 500) } };
      let costly = 1;   // an unanswerable dialog is treated as costly and handed back to the caller
      try {
        const { answers } = await this.call(asked, {
          q: { type: "noul", instructions: "Would accepting `dialog` have an effect outside this browser that is hard to undo, such as placing an order, paying, sending a message, deleting data or publishing?" },
        });
        costly = answers.q.noul;
      } catch {}
      if (costly < irreversibleAt) return true;
      this.heldDialog = { message: dialog.message().slice(0, 200), p_irreversible: +costly.toFixed(2) };
      return false;
    };
  }

  // A named saved login must be the one used, even when the browser already filled the form with
  // another and the next action would just submit it: it is picked before anything else acts on the
  // form. Returns null when there is nothing to pick, else the action, with `stop` if it failed.
  async pickNamedLogin(page, values, log) {
    if (this.loginAccount == null || this.loginPicked === this.loginAccount) return null;
    const pw = page.elements.findIndex(e => e.tag === "input:password");
    if (pw < 0) return null;
    if (this.loginConflict) {
      const info = `the values name two different saved logins (${this.loginConflict.join(", ")}); name one`;
      return { h: { action: "type", element: brief(page.elements[pw]), error: info }, stop: { status: "needs_login", info } };
    }
    const user = page.elements.slice(0, pw).reverse().find(e => /^input:(text|email|tel)$/.test(e.tag) && e.frame === page.elements[pw].frame) ?? page.elements[pw];
    const h = { action: "type", element: brief(user), value: Object.keys(values).find(k => autofillAccount(values[k]) === this.loginAccount) };
    try { await this.autofill(this.locate(user.i), this.loginAccount); }
    catch (e) {
      if (this.abort?.signal.aborted || this.callSignal?.aborted) throw e;
      h.error = actionError(e); log(`  ! ${h.error}`);
      return { h, stop: { status: "needs_login", info: h.error, accounts: e.accounts } };
    }
    return { h };
  }

  // Replays a recipe's actions with the current values, each only while its page and target can
  // still be found. Returns how many ran; `miss` when the page no longer fits the recipe (the loop
  // takes over); `stop` when the step ends here the way the loop would end it: an action that
  // pays, sends or deletes without allowIrreversible, a held dialog, a login the password manager
  // can't fill, or the deadline. `prevPage` is the page the last action ran on.
  async replay(steps, { values, allowIrreversible, irreversibleAt, maxActions, history, log }) {
    const run = { count: 0, miss: null, stop: null, page: null, prevPage: null };
    while (run.count < Math.min(steps.length, maxActions)) {
      if (this.timeLeft() === 0) { run.stop = { status: "timeout", info: "the step ran out of time; see actions for what was done" }; break; }
      await this.settle();
      const page = run.page = await this.snapshot();
      for (const event of this.events.splice(0)) history.push({ event });
      const login = await this.pickNamedLogin(page, values, log);
      if (login) { history.push(login.h); if (login.stop) { run.stop = login.stop; break; } continue; }
      const step = steps[run.count];
      const frameOf = e => page.frameUrls?.get(e.frame);
      const el = findElement(step.target, page.elements, values, frameOf), dest = findElement(step.destination, page.elements, values, frameOf);
      run.miss = !matches(place(page.url), step.at, values) ? `the page is ${place(page.url)}, not the one the recipe goes on from`
        : step.target && !el ? `the ${step.target.tag} it acts on isn't on the page, or can't be told apart`
        : step.destination && !dest ? `the ${step.destination.tag} it drops onto isn't on the page, or can't be told apart`
        : step.valueKey != null && !Object.hasOwn(values, step.valueKey) ? `no value "${step.valueKey}"`
        // done already, as when the same step is asked for twice: clicking again would undo it
        : step.checked != null && el.checked !== step.checked ? `${brief(el)} is ${el.checked ? "checked" : "unchecked"} already`
        : null;
      // a dropdown option is kept as a fingerprint of its label: find the live option it was taken of
      let option = null;
      if (!run.miss && step.option != null) {
        const labels = await this.locate(el.i).evaluate(sel => [...sel.options].map(o => o.label), undefined, { timeout: 2000 }).catch(() => []);
        const k = matches(labels[step.optionIndex] ?? "", step.option, values) ? step.optionIndex : labels.findIndex(l => matches(l, step.option, values));
        if (k < 0) run.miss = `the option it chose isn't in ${brief(el)}`;
        else option = { i: k, label: labels[k] };
      }
      if (run.miss) { log(`  replay stops: ${run.miss}`); break; }
      // the judgment recorded with the step, and the rule on the control's words as it reads now
      const rule = GUARDED.has(step.tool) ? commitsSomething(el, step.tool) : null;
      if (GUARDED.has(step.tool) && !allowIrreversible && ((step.irreversible ?? 0) >= irreversibleAt || rule)) {
        run.stop = { status: "needs_confirmation", info: "the next action looks hard to undo; call again with allow_irreversible to go ahead",
          pending: { action: step.tool, element: brief(el), ...(step.key ? { key: step.key } : {}), p_irreversible: step.irreversible ?? 0, ...(rule ? { because: `"${rule}"` } : {}) } };
        break;
      }
      const h = { action: step.tool, element: brief(el) };
      if (option) h.option = option.label;
      if (step.valueKey != null) h.value = step.valueKey;
      if (step.key) h.key = step.key;
      if (dest) h.destination = brief(dest);
      log(`  replay: ${step.tool}${step.key ? ` ${step.key}` : ""} -> ${brief(el)}${step.valueKey != null ? ` value=${step.valueKey}` : ""}`);
      run.prevPage = page;
      let failed = null;
      try { await this.act({ tool: step.tool, target: el?.i, value: step.valueKey != null ? values[step.valueKey] : option?.label, optionIndex: option?.i, key: step.key, destination: dest?.i }); }
      catch (e) { failed = e; h.error = actionError(e); log(`  ! ${h.error}`); }
      history.push(h);
      if (this.heldDialog) {
        run.stop = { status: "needs_confirmation", info: "the action opened a confirmation dialog that looks hard to undo, so it was dismissed; call again with allow_irreversible to accept it",
          pending: { action: h.action, element: h.element, dialog: this.heldDialog.message, p_irreversible: this.heldDialog.p_irreversible } };
        break;
      }
      if (failed) {
        if (["AUTOFILL_EMPTY", "AUTOFILL_WHICH", "AUTOFILL_BACKGROUND"].includes(failed.code)) run.stop = { status: "needs_login", info: h.error, accounts: failed.accounts };
        else if (this.timeLeft() === 0) run.stop = { status: "timeout", info: "the step ran out of time; see actions for what was done" };
        else run.miss = h.error;
        break;
      }
      run.count++;
    }
    return run;
  }

  // What a recipe keeps of an action that worked: its target by description, values by name, and
  // no text from the page (fingerprints only).
  recipeStep(act, page, r, values) {
    const step = { tool: act.tool, at: fingerprint(place(page.url), values) }, frameOf = e => page.frameUrls?.get(e.frame);
    if (act.target != null) step.target = describe(act.el, page.elements, values, frameOf);
    if (act.tool === "click" && act.el?.checked != null) step.checked = act.el.checked;
    if (act.valueKey != null && ["type", "select", "upload"].includes(act.tool)) step.valueKey = act.valueKey;
    else if (act.tool === "select" && act.value != null) { step.option = fingerprint(act.value, values); if (act.optionIndex != null) step.optionIndex = act.optionIndex; }
    if (act.key) step.key = act.key;
    if (act.destination != null) step.destination = describe(page.elements.find(e => e.i === act.destination), page.elements, values, frameOf);
    if (GUARDED.has(act.tool)) step.irreversible = r.irreversible;
    return step;
  }

  // Goals that ask for a number of something on the page ("until there are exactly 3 Delete
  // buttons", "at least 5 more results"). Jev judges one page at a time and can't keep count, so
  // it only says whether the goal is a count, of how many and compared how; code does the counting
  // on every page, and says so to Jev. Goals without a number cost nothing.
  async countingGoal(goal) {
    const nums = numbersIn(goal);
    if (!nums.length || !mayCount(goal)) return null;
    const q = {
      counts: { type: "noul", instructions: "Does `task.goal` ask for the page to end up with a certain number of some kind of item (for example 'until there are exactly 3 buttons', 'at least 5 more results'), rather than a number to type, pick or select?" },
      cmp: { type: "choice", instructions: "How does `task.goal` compare the number of items on the page with its number?", criteria: { exactly: null, "at least": null, "at most": null } },
      relative: { type: "choice", instructions: "Is `task.goal`'s number a total for the page, or how many more than there are now?", criteria: { total: null, more: null } },
      ...(nums.length > 1 ? { n: { type: "choice", instructions: "Which number is the count `task.goal` asks for?", criteria: Object.fromEntries(nums.map(n => [String(n), null])) } } : {}),
    };
    const { answers } = await this.call({ task: { goal } }, q);
    if (!(answers.counts?.noul >= 0.8)) return null;
    return { n: nums.length > 1 ? +answers.n?.choice || nums[0] : nums[0], cmp: answers.cmp?.choice ?? "exactly", more: answers.relative?.choice === "more", kind: null, now: 0, base: null };
  }

  // Which kind of element the goal counts (asked until one is on the page: there may be none at
  // first) and how many there are now.
  async count(c, page, goal) {
    const kinds = kindsOf(page.elements);
    if (!c.kind && kinds.size) {
      const options = [...kinds.keys()].slice(0, MAX_SINGLE - 1);
      const { answers } = await this.call({ page: { url: page.url, title: page.title, text: page.text.slice(0, 1200) }, task: { goal } }, {
        kind: { type: "choice", instructions: "Which kind of element does `task.goal` count? A kind ending in \"…\" is every element of that tag whose name starts with those words. `none` if there is none of them on the page yet.", criteria: Object.fromEntries([...options.map(k => [k, null]), ["none", null]]) },
      });
      const pick = answers.kind.choice;
      if (pick !== "none" && (answers.kind.probabilities?.[pick] ?? 1) >= 0.6) c.kind = pick;
    }
    c.now = c.kind ? countKind(page.elements, c.kind) : 0;
    // "more" counts from what the page had when the goal started
    c.base ??= c.more ? c.now : 0;
    c.target = c.base + c.n;
    c.met = !!c.kind && (c.cmp === "at least" ? c.now >= c.target : c.cmp === "at most" ? c.now <= c.target : c.now === c.target);
  }

  countProgress(c) {
    return { counting: c.kind ?? "(none on the page yet)", now: c.now, wanted: `${c.cmp} ${c.target}` };
  }

  // Once the caller acts or navigates by hand, a flow held at a confirmation stop can't be trusted
  // to go on where it stopped. The goal is kept, so the next call for it still doesn't start over.
  breakFlow() { if (this.held) this.held = { goal: this.held.goal }; }

  // One line of the trace: what Jev said this round and what it came to.
  roundRecord(round, answers, act, page) {
    const score = q => +(answers[q]?.noul ?? 0).toFixed(2);
    return {
      round,
      done: +Math.max(answers.done.noul, answers.done_change?.noul ?? 0).toFixed(2),
      done_plain: score("done"),
      done_change: score("done_change"),
      blocked: score("blocked"),
      error_shown: score("error"),
      login: score("login"),
      irreversible: score("irreversible"),
      tool: act.tool,
      p_tool: +act.p_tool.toFixed(2),
      target: act.target,
      p_target: +act.p_target.toFixed(2),
      el: brief(act.el),
      value: act.valueKey,
      elements: page.elements.length,
      stages: answers.stages,
      candidates: act.candidates,
    };
  }

  // The stricter second opinion, asked when "the goal is met" and "here is the next action"
  // contradict each other. One wording, asked the same way from both places that need it.
  async looksFinished(page, goal, history) {
    const { answers } = await this.call({ page, task: { goal, history: history.slice(-12) } }, {
      complete: { type: "noul", instructions: "Has everything `task.goal` asks for already happened on `page`? No if `task.goal` itself still needs an action, such as pressing a submit, search or continue button. Yes when the page offers further steps that `task.goal` does not ask for." },
    });
    return +answers.complete.noul.toFixed(2);
  }

  // The one button on the page that the goal's last clause names in so many words ("... and run the
  // search" and a button called Search), or null. Only verbs that are harmless to repeat count: a
  // second search re-runs the same search, where a second Submit or Apply sends something twice.
  // Anything less than a single exact fit is null.
  buttonGoalEndsWith(page, goal) {
    const last = goal.split(/,|;|\bthen\b|\band\b/i).map(c => c.trim()).filter(Boolean).at(-1) ?? "";
    const verbs = (last.toLowerCase().match(/[a-z]+/g) ?? []).filter(w => REPEATABLE.has(w));
    const says = e => String(e.text ?? "").trim().toLowerCase();
    const named = page.elements.filter(e => /^button|\[button\]/.test(e.tag) && !e.disabled
      && verbs.some(v => says(e) === v || says(e).startsWith(`${v} `)));
    return named.length === 1 ? named[0] : null;
  }

  // Jev writes nothing, but it can pick, so a goal that names what to look for can still fill a
  // field the caller gave no value for: the goal's own phrases become the options. Returns the
  // text to type, or null when none of them is the thing.
  async chooseText(page, goal, el) {
    const phrases = phrasesFrom(goal);
    if (!phrases.length) return null;
    const criteria = Object.fromEntries([...phrases.map(p => [p, null]), ["none of these", "nothing here should be typed into the field"]]);
    const field = { tag: el?.tag, label: el?.label, placeholder: el?.placeholder, near: el?.near };
    const { answers } = await this.call({ page: { url: page.url, title: page.title, text: page.text.slice(0, 1200) }, task: { goal }, field }, {
      text: { type: "choice", instructions: "Which of these, taken from `task.goal`, should be typed into `field` to get on with `task.goal`?", criteria },
    });
    const picked = answers.text.choice;
    const sure = answers.text.probabilities?.[picked] ?? 1;
    return picked === "none of these" || sure < 0.4 ? null : picked;
  }

  // Which key to press, for a round that chose press_key without saying which.
  async chooseKey(page, goal, history) {
    const seenPage = { url: page.url, title: page.title, text: page.text, dialogs: page.dialogs };
    const { answers } = await this.call({ page: seenPage, task: { goal, history: history.slice(-6) } }, {
      key: { type: "choice", instructions: "Which keyboard key should be pressed next for `task.goal`?", criteria: Object.fromEntries(KEYS.map(k => [k, null])) },
    });
    return answers.key.choice;
  }

  // What to drop the dragged element onto. Everything but the element itself is a candidate.
  async chooseDropTarget(page, goal, dragging, exclude) {
    const others = page.elements.filter(e => e.i !== exclude).slice(0, MAX_SINGLE);
    if (!others.length) return null;
    const { answers } = await this.call({ page: { ...page, elements: others }, task: { goal, dragging } }, {
      dest: { type: "choice", instructions: "Onto which entry of `page.elements` (by its `i`) should `task.dragging` be dropped for `task.goal`?", criteria: Object.fromEntries(others.map(e => [String(e.i), null])) },
    });
    return +answers.dest.choice;
  }

  // What the caller asked for by way of a saved login. "autofill:<account>" on any field picks that
  // login for the whole form; plain "autofill" still has the manager asked first, so a form the
  // browser filled with one of several logins isn't just submitted. Two different accounts in one
  // call can't both be meant, and that is a question for the caller, not a guess.
  loginIntent(values) {
    const asked = Object.values(values).map(autofillAccount).filter(a => a !== null);
    const named = [...new Set(asked.filter(Boolean))];
    this.loginAccount = named.length ? named[0] : asked.length ? "" : null;
    this.loginConflict = named.length > 1 ? named : null;
    this.loginPicked = null;
  }

  // recipe: false neither replays nor records for this call.
  async runGoal(goal, { values = {}, maxActions = 10, doneAt = 0.5, minTarget = 0.3, allowIrreversible = false, irreversibleAt = 0.6, log = () => {}, recipe = true } = {}) {
    const t0 = Date.now(), calls0 = this.stats.calls;
    this.pageErrors.length = 0;
    const history = [], rounds = [];
    let prevPage = null, waits = 0, page = null, status = "max_actions", info, pending, accounts, retried = false;
    let lastTool = null;
    // A goal that says plainly what it wants can be checked against the page instead of asked
    // about: the page itself is better evidence than an opinion, and it costs nothing.
    const plain = plainGoal(goal, values);
    // Typing the goal's own words puts them on the page, which is exactly what a "does this page
    // show the goal achieved" question reads. The round after one of those has to be carried by
    // something other than the echo, so the first such finish is not taken at its word.
    let echoedGoal = false;
    const seen = new Map();
    // the element the last action went to, and a list field typed into without choosing from it
    let acted = null, typed = null, pressedEnding = false, staleRounds = 0, waitedOnWall = false;
    ({ prompt: this.promptText } = values);
    this.loginIntent(values);
    // The call right after this goal stopped for confirmation goes on with the same flow: a recipe
    // replays from the action it stopped at, Jev sees what ran before the stop, and the whole flow
    // is recorded under the page it started on. Only the same values, contents included, on the
    // same address, query and fragment included, go on: the confirmation is for what the stop
    // showed, not a message to another recipient or another draft. A call that doesn't fit neither
    // replays nor records: from the start, it would repeat what ran.
    const held = this.held, given = valuesPrint(values);
    this.held = null;
    const again = held?.goal === goal;
    let flow = again && recipe && this.recipes && held.key && held.values === given && held.url === this.page.url() ? held : null;
    // the actions that finished this goal from this page before, and the ones this step takes
    let book = recipe && !again ? this.recipes : null;
    const key = book ? recipeKey(goal, this.page.url(), values) : flow?.key, steps = [];
    let saved = null, run = null, plan = null, counting = null, before = 0;
    // A caller can have a shorter deadline than the step does, and an action that overruns leaves
    // the step still inside a round when that deadline lands. Everything it has done so far lives
    // in these arrays, so hand them out rather than let the work vanish into a one-line error.
    this.progress = { goal, actions: history, rounds, before: 0, startedAt: t0, callsBefore: calls0 };
    try {
    // A goal that counts from what the page has ("load 5 more results") takes that count before
    // it acts, and a replay would already have added to it: such goals neither replay nor record.
    counting = await this.countingGoal(goal);
    if (counting?.more) book = flow = null;
    if (flow) history.push(...flow.history);
    before = history.length;
    this.progress.before = before;
    saved = book?.get(key);
    plan = book ? saved?.steps : flow?.remaining;
    if (Array.isArray(plan) && plan.length) {
      run = await this.replay(plan, { values, allowIrreversible, irreversibleAt, maxActions, history, log });
      steps.push(...plan.slice(0, run.count));
      page = run.page; prevPage = run.prevPage;
      if (run.stop) ({ status, info, pending, accounts } = run.stop);
      // the page no longer fits the rest of the flow: the loop goes on, but it isn't recorded
      if (flow && run.miss) flow = null;
    }
    // After a replay the loop goes on as if it had taken those actions itself: they count toward
    // maxActions, and its first round sees what the last one changed. That round is also what
    // confirms a full replay: a replay never claims "done" on its own.
    // where the loop's own actions start, after whatever a replay did
    const ownFrom = history.length;
    if (!run?.stop) for (let round = run?.count ?? 0; round <= maxActions; round++) {
      if (this.timeLeft() === 0) { status = "timeout"; info = "the step ran out of time; see actions for what was done"; break; }
      // A question costs about a third of a second and so does waiting for the page to go quiet.
      // Taken one after the other that is paid twice, so after an action that rarely replaces the
      // page the question goes out against the page as it is now, while the waiting carries on.
      // If the page has moved by the time the answer lands, the answer is about a page that is no
      // longer there and is thrown away.
      // Not the first round: straight after a navigation the page is still being put together, so
      // the guess is thrown away almost every time and only costs a question.
      const mayGuess = GUESSABLE.has(lastTool) && !counting && round > 0;
      const early = mayGuess ? await this.snapshot() : null;
      const earlyPrint = early && samePage(early);
      const guess = early
        ? this.decide(early, goal, values, history.slice(-12), prevPage ? pageDiff(prevPage, early) : undefined, undefined)
        : null;
      guess?.catch(() => {});

      await this.settle();
      page = await this.snapshot();
      for (const event of this.events.splice(0)) history.push({ event });
      const login = await this.pickNamedLogin(page, values, log);
      if (login) {
        history.push(login.h);
        if (login.stop) { ({ status, info, accounts } = login.stop); break; }
        continue;
      }
      if (counting) await this.count(counting, page, goal);

      // Text typed into a list field with nothing chosen from its list is not a value yet, however
      // much the field looks like the goal: this round can't finish on it. Emptied since, it never
      // took at all. A field can hand its text to another input as it opens its list, so empty
      // means nothing holds it: this field is empty and so is whatever has the focus now.
      const unchosen = !!typed;
      const dropped = typed && await typed.el.evaluate(el => el.isConnected && el.value === "" && !document.activeElement?.value).catch(() => false);
      if (dropped) history.push({ event: `the page emptied ${typed.label} after the focus moved on: type it again and choose from its list` });
      typed = null;
      // a picker still open over the value the step chose, waiting for its Done button
      const open = await this.unconfirmed(acted);

      // something has been done and the page now shows what the goal asked for: no need to ask
      const sinceLast = round > 0 && prevPage ? pageDiff(prevPage, page) : null;
      if (plain && !open && !unchosen && round > 0 && history.slice(before).some(h => h.action) && goalMet(plain, page, sinceLast) === true) {
        status = "done";
        info = `the page shows it: ${plain.kind} ${plain.wants[0]}`;
        rounds.push({ round, checked_in_page: plain.wants[0] });
        break;
      }
      const stillThere = early && samePage(page) === earlyPrint;
      const a = stillThere
        ? await guess
        : await this.decide(page, goal, values, history.slice(-12), round ? pageDiff(prevPage, page) : undefined, counting && this.countProgress(counting));
      if (stillThere) page = early;
      prevPage = page;
      const previous = history.slice(before).filter(h => h.action).at(-1);
      const act = this.resolve(page, a, values, { typedInto: previous?.action === "type" && !previous.error ? previous.element : null });
      const r = this.roundRecord(round, a, act, page);
      let done = r.done;
      rounds.push(r);
      if ((open || unchosen) && done >= doneAt) { done = 0; r.value_not_in = open ? "picker still open" : dropped ? "typed value dropped" : "typed, nothing chosen from its list"; }
      if (counting?.kind) {
        // where a goal counts, the count decides, not Jev's impression of the page
        const wanted = `wanted ${counting.cmp} ${counting.target}`;
        r.count = `${counting.now} × ${counting.kind}, ${wanted}`;
        if (counting.met) {
          status = "done";
          info = `counted ${counting.now} × ${counting.kind}`;
          log(`  r${round}: ${r.count}: done`);
          break;
        }
        done = 0;
        if (act.tool === "none") {
          status = "stuck";
          info = `the page has ${counting.now} × ${counting.kind}; the goal wants ${counting.cmp} ${counting.target}`;
          break;
        }
      }
      log(`  r${round}: ${act.tool}(${r.p_tool}) -> #${act.target} ${r.el} (${r.p_target})${act.valueKey ? ` value=${act.valueKey}` : ""}  done=${r.done} err=${r.error_shown} login=${r.login} irrev=${r.irreversible}  [${page.elements.length} elements${a.stages === 2 ? ", asked in two stages" : ""}]`);

      // the goal's words are on the page because barq typed them there, so this round's "looks
      // done" is not evidence; the next one, after something has actually been acted on, is
      // only the round straight after the echo: by the next one the page has moved on and its
      // "looks done" is its own again
      const echo = echoedGoal;
      echoedGoal = false;
      if (echo && done >= doneAt) { done = 0; r.echo_ignored = true; }
      if (act.tool !== "none" && round > 0 && done >= doneAt && done < 0.85) {
        // "the goal is met" and "here is the next action" disagree: one stricter question settles it
        r.confirm = await this.looksFinished(page, goal, history);
        log(`     confirm=${r.confirm}`);
        if (r.confirm >= 0.65) { status = "done"; break; }   // the stricter question agrees
        if (r.confirm >= 0.45) {
          status = "likely_done";
          info = "the page looks done but Jev is unsure; verify with a check, snapshot or screenshot";
          break;
        }
        const commits = GUARDED.has(act.tool) ? commitsSomething(act.el, act.tool) : null;
        if (GUARDED.has(act.tool) && (a.irreversible.noul >= irreversibleAt || commits)) {
          // mostly done, and the next step is hard to undo: stop here rather than overstep the goal
          status = "done";
          info = "stopped before an action that looks irreversible and may go beyond this goal";
          pending = { action: act.tool, element: brief(act.el), p_irreversible: r.irreversible, ...(commits ? { because: `"${commits}"` } : {}) };
          break;
        }
      } else if (done >= (round > 0 ? doneAt : 0.9) && (done >= 0.85 || act.tool === "none" || round === 0)) {
        if (done < 0.85) {
          // a soft "done" with nothing left to do can still be wrong (an earlier action went to the
          // wrong element, or a button whose name promised the search only closed a calendar): the
          // stricter question decides between done and "verify it yourself". The line is the same
          // 0.85 the round with a chosen action uses; at 0.75 a flight search that never ran was
          // taken as done.
          r.confirm = await this.looksFinished(page, goal, history);
          log(`     confirm=${r.confirm}`);
          // Not finished, nothing chosen to do, and the goal ends by naming a button that is still
          // on the page: that button is the part still to do. Pressed once, and never one whose
          // words pay, send or delete.
          const ending = act.tool === "none" && r.confirm < 0.65 && !pressedEnding ? this.buttonGoalEndsWith(page, goal) : null;
          if (ending && !commitsSomething(ending)) {
            pressedEnding = true;
            const h = { action: "click", element: brief(ending), because: "the goal ends by naming it and the page is not finished" };
            try { r.act_ms = await this.act({ tool: "click", target: ending.i }); } catch (e) { h.error = actionError(e); }
            history.push(h);
            continue;
          }
          if (r.confirm < 0.65) { status = "likely_done"; info = "the page looks done but Jev is unsure; verify with a check, snapshot or screenshot"; break; }
        }
        status = "done"; break;
      }
      if (round === maxActions) break;   // out of actions; the status after the loop says so

      if (!Object.keys(values).length && a.login.noul >= 0.7) {
        // nothing to type: hand the sign-in back rather than clicking through it, single sign-on included
        status = "needs_login";
        info = "the page wants a sign-in and no values were given; log in (e.g. in a headed persistent profile) or pass credentials in values";
        break;
      }
      if (round > 0 && a.error.noul >= 0.7) {
        status = "error";
        info = "the page shows an error after the last action";
        break;
      }

      if (act.tool === "none") {
        // content that arrives late (a modal, a slow render): look once more before giving up
        if (round === 0 && !retried) { retried = true; rounds.pop(); round--; await sleep(1500); continue; }
        // Nothing left to choose in the picker, and its own button still to press: that button is
        // what hands the chosen value to the page, so it is pressed rather than the step ending on
        // a value the form never received.
        if (open) {
          await this.confirmPicker(open, history);
          acted = null;
          continue;
        }
        if (dropped) {
          status = "stuck";
          info = "a value typed into a field with a list of suggestions was emptied by the page, and nothing that fits was on offer";
          break;
        }
        if (round > 0 && a.error.noul < 0.5 && a.blocked.noul < 0.5) {
          // Jev chose actions of its own in this step and now has nothing left to do. That is a step
          // whose result the caller has to confirm, not one going in circles, and calling it stuck
          // sends them off to redo work the page has already taken: a goal that names two things
          // ("add both X and Y") reads as unfinished on a page that shows neither of them in its
          // words. A replay's actions don't count: a recording that ran and left a page Jev calls
          // unfinished, with nothing to add, is one that didn't fit, and that is stuck. It is never
          // "done" from here either. Jev's answer was that the page doesn't look finished, and the
          // stricter question can veto a finish, never make one out of a no.
          if (history.slice(ownFrom).some(h => h.action && h.action !== "wait")) {
            status = "likely_done";
            info = "no further action seems needed but Jev is unsure the goal is met; verify with a check, snapshot or screenshot";
            break;
          }
        }
        if (a.blocked.noul >= 0.5 && !waitedOnWall && (waitedOnWall = true) && await this.wallClears()) {
          history.push({ event: "a browser check cleared by itself" });
          continue;
        }
        status = a.blocked.noul >= 0.5 ? "blocked" : "stuck";
        break;
      }
      // a captcha or a wall, not something to click through, unless it is the kind that lets the
      // browser through on its own
      if (a.blocked.noul >= 0.85) {
        if (!waitedOnWall && (waitedOnWall = true) && await this.wallClears()) {
          history.push({ event: "a browser check cleared by itself" });
          continue;
        }
        status = "blocked"; break;
      }

      if (act.tool === "wait") {
        if (++waits > 6) { status = "stuck"; info = "the page never finished loading"; break; }
        await this.settle({ max: 4000 });
        await sleep(600);
        history.push({ action: "wait" });
        continue;
      }
      if (TARGETED.has(act.tool) && act.p_target < minTarget) {
        status = "ambiguous";
        info = "target confidence too low; refine the goal or act on a candidate directly";
        break;
      }

      // Going nowhere comes in two shapes: the same action on a page that hasn't moved, and a run
      // of actions that keeps coming back round.
      const standstill = `${actionId(act)}|${page.url}|${page.text}|${JSON.stringify(page.elements)}`;
      seen.set(standstill, (seen.get(standstill) ?? 0) + 1);
      if (seen.get(standstill) >= 3) {
        status = "stuck";
        info = "repeating the same action on the same page without progress";
        break;
      }
      const sequence = [...history.filter(h => h.action).map(h => `${h.action}|${h.element}|${h.value ?? ""}`), actionId(act)];
      if (repeatsBlock(sequence, 2, 3) || repeatsBlock(sequence, 3, 3) || repeatsBlock(sequence, 1, 8)) {
        status = "stuck";
        info = "repeating the same sequence of actions; the goal may already be done — check the page";
        break;
      }

      // The page moved on while Jev was deciding: the element it chose has gone, because the page
      // navigated or redrew that part, or it is still there and now says something else, a button
      // that read "Continue" when it was chosen and reads "Delete account" when it would be pressed.
      // What was decided was the page as it was, so the page is looked at again instead, twice at
      // most in a row. Acting on a changed label is how a harmless step becomes an irreversible one.
      const gone = act.target != null && !(await this.locate(act.target).count().catch(() => 0));
      const reworded = !gone && act.target != null && act.el?.text ? await this.locate(act.target).evaluate((el, was) => {
        const now = (el.innerText || "").replace(/\s+/g, " ").trim();
        return now && !now.startsWith(was.slice(0, 40)) && !was.startsWith(now.slice(0, 40)) ? now.slice(0, 60) : null;
      }, act.el.text).catch(() => null) : null;
      if (gone || reworded) {
        if (++staleRounds <= 2) {
          history.push({ event: gone ? `${brief(act.el)} left the page while the step was deciding` : `${brief(act.el)} now says "${reworded}": it changed while the step was deciding` });
          continue;
        }
      } else staleRounds = 0;

      // questions that only make sense once the action is known
      // A goal's own words go into a search or a text field, never into a control that is offering
      // things to pick: typing there leaves the wanted option merely showing on screen, which looks
      // finished and is not, since nothing was chosen.
      const offersOptions = SELECTISH(act.el) || /\[(combobox|listbox)\]/.test(act.el?.tag ?? "")
        || page.elements.some(e => /\[option\]/.test(e.tag));
      if (act.typeNeedsText && offersOptions) {
        act.tool = "click";
        act.typeNeedsText = false;
      }
      if (act.typeNeedsText) {
        act.value = await this.chooseText(page, goal, act.el).catch(() => null);
        if (act.value == null) act.tool = "click";      // nothing in the goal fits: open the field instead
        else { r.tool = act.tool; r.text_from_goal = act.value; echoedGoal = true; }
      }
      // A goal that names an option in so many words does not need the dropdown read out: if
      // exactly one of the options is that word, it is the one meant, and a wrong guess is
      // impossible because anything less than an exact single match falls through to asking.
      if (act.tool === "select" && act.el?.options?.length && act.value == null) {
        const said = `${goal} ${Object.values(values).join(" ")}`;
        const named = act.el.options.filter(o => String(o).trim().length > 1 && mentions(said, String(o).trim()));
        if (named.length === 1) {
          act.value = named[0];
          act.optionIndex = act.el.options.indexOf(named[0]);
          r.option_from_goal = named[0];
        }
      }
      if (act.tool === "select" && act.el?.options?.length && act.value == null) {
        // A dropdown that can't be read or answered is a failed action the next round sees, not an
        // exception out of do(); running out of time still ends the step.
        try {
          const option = await this.chooseOption(page, goal, act.el);
          // Indices distinguish duplicate labels and avoid acting on the shortened preview.
          act.value = option.label; act.optionIndex = option.i; act.optionGroup = option.group; act.valueKey = undefined;
        } catch (e) {
          if (this.abort?.signal.aborted || this.callSignal?.aborted) throw e;
          r.error = actionError(e); log(`  ! ${r.error}`);
          history.push({ action: act.tool, element: brief(act.el), error: r.error });
          continue;
        }
      }
      if (act.tool === "press_key") {   // which key is a question of its own
        act.key = await this.chooseKey(page, goal, history);
        // a key meant for a field goes to the field; anything else goes to the page
        if (!act.el || !(FIELDISH(act.el) || act.el.tag.startsWith("input"))) act.target = null;
      }
      if (act.tool === "drag") {
        const onto = await this.chooseDropTarget(page, goal, brief(act.el), act.target);
        if (onto == null) { status = "stuck"; info = "nothing on the page to drop onto"; break; }
        act.destination = onto;
        r.destination = brief(page.elements.find(e => e.i === onto));
      }
      // Jev's judgment, and a rule on the control's own words for when that judgment is wrong
      const rule = GUARDED.has(act.tool) ? commitsSomething(act.el, act.tool) : null;
      if (GUARDED.has(act.tool) && !allowIrreversible && (a.irreversible.noul >= irreversibleAt || rule)) {
        status = "needs_confirmation"; info = "the next action looks hard to undo; call again with allow_irreversible to go ahead";
        pending = { action: act.tool, element: brief(act.el), ...(act.key ? { key: act.key } : {}), p_irreversible: r.irreversible, ...(rule ? { because: `"${rule}"` } : {}) };
        break;
      }

      lastTool = act.tool;
      const h = { action: act.tool, element: brief(act.el ?? null) };
      if (act.tool === "select" && act.value != null) h.option = act.optionGroup ? `${act.value} (${act.optionGroup})` : act.value;
      if (act.valueKey && VALUED.includes(act.tool)) h.value = act.valueKey;
      if (act.key) h.key = act.key;
      if (r.destination) Object.assign(h, { destination: r.destination });
      if (act.target != null && this.highlight) await this.showDecision(act, r).catch(() => { /* drawing is best effort */ });
      const handle = act.target != null && ["click", "type", "select"].includes(act.tool)
        ? await this.locate(act.target).elementHandle({ timeout: 1000 }).catch(() => null) : null;
      await acted?.dispose().catch(() => {});
      acted = handle;
      this.typedUnchosen = false;
      try {
        r.act_ms = await this.act(act);
        if (act.tool === "type" && this.typedUnchosen && handle) typed = { el: handle, label: brief(act.el) };
      }
      catch (e) {
        h.error = actionError(e); r.error = h.error; log(`  ! ${h.error}`);
        // retrying won't make a password manager fill the field: hand the login back
        if (["AUTOFILL_EMPTY", "AUTOFILL_WHICH", "AUTOFILL_BACKGROUND"].includes(e.code)) {
          history.push(h); status = "needs_login"; info = h.error;
          if (e.accounts) accounts = e.accounts;
          break;
        }
      }
      history.push(h);
      // a dismissed dialog undid the action: the next call does it again
      if ((book || flow) && !h.error && !this.heldDialog) steps.push(this.recipeStep(act, page, r, values));
      if (this.heldDialog) {
        status = "needs_confirmation"; info = "the action raised a confirmation dialog that looks hard to undo, so it was turned down; call again with allow_irreversible to accept it";
        pending = { action: h.action, element: h.element, dialog: this.heldDialog.message, p_irreversible: this.heldDialog.p_irreversible };   // what was turned down
        break;
      }
    }
    } catch (e) {
      if (!this.abort?.signal.aborted && !this.callSignal?.aborted) throw e;
      status = "timeout"; info = "the step ran out of time; see actions for what was done";
    }
    this.shown = page;
    for (const event of this.events.splice(0)) history.push({ event });
    const out = {
      status, goal,
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      actions: history.slice(before),
      rounds,
      jev_calls: this.stats.calls - calls0,
      ms: Date.now() - t0,
      ...(info ? { info } : {}),
      ...(pending ? { pending } : {}),
      ...(accounts ? { accounts } : {}),
      ...(this.pageErrors.length ? { page_errors: this.pageErrors.splice(0) } : {}),
    };
    // what the flow did so far, this call's part and the part before a confirmation stop
    const rec = book ?? (flow ? this.recipes : null), whole = [...(flow?.steps ?? []), ...steps], replayed = (flow?.replayed ?? 0) + (run?.count ?? 0);
    if (rec) {
      const clean = !history.some(h => h.error), all = run && run.count === plan.length;
      if (status === "done" && all && clean && replayed === whole.length) { rec.note(key, { replayed: true }); out.recipe = "replayed"; }
      else {
        // the page no longer fit the recipe, or all of it ran and the goal still wasn't done
        if (run?.miss || (all && !run.stop && status !== "timeout")) rec.note(key, { missed: true });
        if (status === "done" && clean && whole.length) rec.put(key, whole);
        if (replayed) out.recipe = "partly replayed";
        else if (status === "done" && clean && whole.length) out.recipe = "recorded";
      }
    }
    if (status === "needs_confirmation") this.held = {
      goal, values: given, url: this.page.url(), history, key: rec ? key : null, steps: whole, replayed,
      remaining: run?.stop?.status === "needs_confirmation" ? plan.slice(run.count) : null,
    };
    // stopped part way for another reason: where exactly is unknown, so no going on, but the next
    // call for this goal must not start over either
    else if (status !== "done" && (again || history.slice(before).some(h => h.action))) this.held = { goal };
    const last = rounds.at(-1);
    out.done_score = +(last?.done ?? 0);
    // a step that fell short says what the page held, so the caller can take over without a snapshot
    if (status !== "done" && status !== "likely_done") {
      out.page_text = page?.text?.substring(0, 600);
      if (["ambiguous", "stuck", "max_actions"].includes(status)) out.candidates = last?.candidates;
    }
    this.progress = null;
    return out;
  }

  // What the step in flight has done, for a caller whose own time limit ran out first.
  partialStep() {
    const p = this.progress;
    if (!p) return null;
    const last = p.rounds.at(-1);
    return {
      status: "timeout",
      goal: p.goal,
      url: this.page.url(),
      actions: p.actions.slice(p.before),
      rounds: p.rounds,
      done_score: +(last?.done ?? 0),
      ...(last?.candidates ? { candidates: last.candidates } : {}),
      info: "the caller's time limit ran out while the step was still going; this is what it had done by then",
      jev_calls: this.stats.calls - p.callsBefore,
      ms: Date.now() - p.startedAt,
    };
  }

  async showDecision(act, r) {
    const caption = [
      act.tool,
      act.valueKey ? ` \u2190 ${act.valueKey}` : "",
      act.key ? ` ${act.key}` : "",
      `  p=${r.p_target}  done=${r.done}`,
    ].join("");

    const loc = this.locate(act.target);   // the element about to be acted on
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { /* drawn wherever it is */ });
    await loc.evaluate((el, caption) => {
      const RED = "#e5484d";
      const box = el.getBoundingClientRect();
      const outline = document.createElement("div");
      // the enumerator skips anything inside this attribute, so the outline is never a target itself
      outline.setAttribute("data-jev-overlay", "");
      Object.assign(outline.style, {
        position: "fixed", left: `${box.left - 3}px`, top: `${box.top - 3}px`,
        width: `${box.width + 6}px`, height: `${box.height + 6}px`,
        border: `3px solid ${RED}`, borderRadius: "6px", zIndex: 2147483647, pointerEvents: "none",
      });

      const note = document.createElement("div");
      note.textContent = caption;
      Object.assign(note.style, {
        position: "absolute", left: "-3px",
        top: box.top > 30 ? "-26px" : `${box.height + 6}px`,   // under the element when it sits at the top of the window
        background: RED, color: "#fff", font: "600 12px/1 system-ui",
        padding: "5px 7px", borderRadius: "4px", whiteSpace: "nowrap",
      });

      outline.appendChild(note);
      document.documentElement.appendChild(outline);
      setTimeout(() => outline.remove(), 1400);
    }, caption);
    // long enough to see what is about to be clicked, short enough not to slow the step down
    await sleep(HIGHLIGHT_MS);
  }

  async screenshot({ path, fullPage = false } = {}) { return this.page.screenshot({ fullPage, path }); }
  async close() {
    if (this.ownContext) await this.context.close().catch(() => {});
    else for (const p of this.pages) await p.close().catch(() => {});
    if (this.ownBrowser) await this.browser.close().catch(() => {});
  }
}
