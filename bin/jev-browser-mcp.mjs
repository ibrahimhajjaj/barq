#!/usr/bin/env node
// MCP server (stdio): Jev-driven browser sessions for an LLM client.
//
//   claude mcp add jev-browser -- node <checkout>/bin/jev-browser-mcp.mjs
//
// Env: TYPESAFE_API_KEY (or the macOS keychain item "typesafe-api-key"),
//      JEV_BROWSER_ATTACH=chrome|edge|brave|...|auto to work in a browser the user already runs,
//      JEV_BROWSER_PLACEMENT=auto|group|window|tab for where the agent's tabs go in that browser,
//      otherwise a launched Chromium: JEV_BROWSER_HEADED=1, JEV_BROWSER_CHANNEL=chrome|msedge,
//      JEV_BROWSER_PROFILE=/dir (persistent profile, keeps logins),
//      JEV_BROWSER_LOG=1 (rounds to stderr), JEV_BROWSER_TRACES=<dir>|0 (per-step records on disk)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SessionPool } from "../src/pool.mjs";
import { browserConfig } from "../src/browsers.mjs";
import { TraceLog } from "../src/trace.mjs";

const config = browserConfig();
// Attached to the user's own browser, let go of it after a while without calls: while connected,
// every one of their tabs reports to this process.
const idleMin = Number(process.env.JEV_BROWSER_IDLE_MIN ?? (config.kind === "attach" ? 15 : 0));
const pool = new SessionPool({ highlight: config.kind === "launch" && config.headed, idleMs: idleMin * 60_000 });

const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] });
const fail = e => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e).split("\n", 1)[0] }] });
const stderrLog = process.env.JEV_BROWSER_LOG === "1" ? line => process.stderr.write(`${line}\n`) : () => {};
// one file per browser_do step, with every round's probabilities (JEV_BROWSER_TRACES=0 turns it off)
const traces = new TraceLog();

const session = z.string().regex(/^[\w.-]{1,40}$/).optional().describe("Browser session: its own tab. Calls on different sessions run in parallel, calls on one session run in order. Default \"main\"");

const RECOVERED = "the previous tab was gone, so this ran in a new tab reopened at the last URL";

// Runs fn in the session's tab, stopping it if the client cancels the request. Plain objects come
// back as JSON with the session name (when not "main") and a note if the tab had to be replaced
// first; MCP content passes through untouched.
function tool(fn, timeoutMs = 60_000) {
  return async (args, extra) => {
    try {
      const name = args.session ?? "main";
      const limit = typeof timeoutMs === "function" ? timeoutMs(args) : timeoutMs;
      const { result, recovered } = await pool.run(name, jb => fn(jb, args), { timeoutMs: limit, signal: extra?.signal });
      if (result?.content) return result;
      if (!result || typeof result !== "object") return text(recovered ? `(${RECOVERED})\n${result}` : String(result));
      if (name !== "main") result.session = name;
      if (recovered) result.recovered = RECOVERED;
      return text(result);
    } catch (e) { return fail(e); }
  };
}

const server = new McpServer({ name: "jev-browser", version: "0.2.0" });

server.registerTool("browser_open", {   // go to an address
  title: "Open URL",
  description: "Navigate the session's tab to a URL and wait until the page settles. Starts the browser and the tab on first use.",
  inputSchema: { url: z.string().describe("Absolute URL"), session },
}, tool(async (b, { url }) => {
  const r = await b.open(url);
  const page = await b.snapshot();   // as it stands now
  return { ...r, elements: page.elements.length, visible_text: page.text.slice(0, 400) };
}));

server.registerTool("browser_do", {   // one outcome, Jev choosing each action
  title: "Do one browser step",
  description: [
    "Reach ONE outcome you could see on the current page. A fast decision model, Jev, chooses every element, action and value; it can't plan or write text, so:",
    "- Give one outcome per call (\"Log in\", \"Put the Backpack in the cart\", \"Open the Pull requests tab\"); steps that must happen in order are separate calls.",
    "- Everything to type, every option to pick and every file to upload goes in `values`, under names that say what it is ({email, password}).",
    "- Give an open-ended goal an end you can count (\"until at least 3 new results are shown\").",
    "Statuses: done | likely_done (Jev is unsure the goal is met: verify with browser_check or browser_snapshot before moving on) | needs_login (sign-in wall and no credentials given: ask the user to log in, or pass credentials in values) | needs_confirmation (next click looks irreversible: re-call with allow_irreversible=true only if the user wants it) | error (page shows an error) | blocked | stuck | ambiguous (see candidates; use browser_act) | max_actions | timeout (ran out of time; see actions).",
    "After a step that changes something, confirm with browser_check that nothing else changed with it.",
  ].join("\n"),
  inputSchema: {
    goal: z.string().describe("One outcome you could see on the page"),
    values: z.record(z.string(), z.string()).optional().describe("Strings Jev may type, select or upload, each under a name"),
    max_actions: z.number().int().min(1).max(30).optional().describe("Actions allowed in this step. Default 10"),
    timeout_s: z.number().int().min(5).max(600).optional().describe("Time limit for the whole step. Default 90"),
    allow_irreversible: z.boolean().optional().describe("Go ahead with actions that are hard to undo: ordering, paying, sending, deleting"),
    explain: z.boolean().optional().describe("Put Jev's probabilities for every round in the result"),
    session,
  },
}, tool(async (b, { goal, values, max_actions, timeout_s, allow_irreversible, explain, session: name }) => {
  const r = await b.do(goal, { values: values ?? {}, maxActions: max_actions ?? 10, timeoutMs: (timeout_s ?? 90) * 1000, allowIrreversible: !!allow_irreversible, log: stderrLog });
  const trace = traces.write("do", { ...r, values: Object.keys(values ?? {}), model: b.stats.model }, { session: name ?? "main", values });
  const actions = r.actions.map(h => h.event ? `(event) ${h.event}` : [h.action, h.key, h.element, h.value && `<- values.${h.value}`, h.option && `<- "${h.option}"`, h.destination && `-> ${h.destination}`, h.error && `ERROR: ${h.error}`].filter(Boolean).join(" "));
  const { status, url, title, done_score, jev_calls, ms } = r; const out = { status, url, title, actions, done_score, jev_calls, ms };
  for (const key of ["info", "pending", "page_text", "candidates"]) if (r[key]) out[key] = r[key];
  if (explain) out.rounds = r.rounds.map(({ candidates, ...round }) => round);
  if (trace) out.trace = trace;
  return out;
}, ({ timeout_s }) => ((timeout_s ?? 90) + 30) * 1000));

server.registerTool("browser_check", {   // a yes/no about the page
  title: "Check page",
  description: "A yes/no question about the current page, answered as the probability of yes: 0.85 or more is a reliable yes, 0.15 or less a reliable no, and in between you should look with browser_snapshot.",
  inputSchema: { question: z.string(), session },
}, tool(async (b, { question }) => ({ question, p_yes: +(await b.check(question)).toFixed(3) })));

server.registerTool("browser_choose", {   // which of several things holds
  title: "Choose about page",
  description: "Which of several options holds for the current page. You supply the options, since Jev can't write any. Returns the one chosen and a probability for each.",
  inputSchema: { question: z.string(), options: z.array(z.string()).min(2).max(255), session },
}, tool(async (b, { question, options }) => {
  const r = await b.choose(question, options);   // { choice, probabilities }
  return { choice: r.choice, confidence: r.confidence, probabilities: Object.fromEntries(Object.entries(r.probabilities).map(([k, v]) => [k, +v.toFixed(3)])) };
}));

server.registerTool("browser_snapshot", {   // the page as numbered elements
  title: "Page snapshot",
  description: "The current page, short: the text on screen and every control, numbered. For taking over when browser_do comes back ambiguous or stuck; act on the numbers with browser_act.",
  inputSchema: { session },
}, tool(b => b.snapshotText()));

server.registerTool("browser_read", {   // what the page says
  title: "Read page",
  description: [
    "Read the current page's text: the whole page, not just what is on screen. Use it to answer questions from a page instead of taking snapshots.",
    "- With `question`: Jev picks the passages that answer it from the whole page (about a second, even on long pages) and only those come back, each with its heading and a probability. `answered` near 0 means the page doesn't seem to contain the answer.",
    "- Without: the text a page at a time, max_chars per call; pass next_offset back as offset to continue.",
    "Navigation, sidebars and footers are left out unless all_regions is true.",
  ].join("\n"),
  inputSchema: {
    question: z.string().optional().describe("What you want to know from the page"),
    offset: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(500).max(40_000).optional().describe("Default 12000"),
    all_regions: z.boolean().optional(),
    session,
  },
}, tool((b, { question, offset, max_chars, all_regions }) => b.read({ question, offset: offset ?? 0, maxChars: max_chars ?? 12_000, allRegions: !!all_regions })));

server.registerTool("browser_act", {   // one action on a numbered element
  title: "Act on element",
  description: "Perform one action on an element number from the latest browser_snapshot (or from browser_do candidates). No decision model involved. Numbers are matched to the current page; if the element is gone, take a new snapshot. Confirm/prompt dialogs the action opens are dismissed unless accept_dialog is true. A control that pays, sends, posts or deletes returns needs_confirmation instead of acting, unless allow_irreversible is true.",
  inputSchema: {
    action: z.enum("click type press_enter press_key select hover right_click drag upload scroll back".split(" ")),
    element: z.number().int().optional().describe("The element's number [i]; scroll, back and a key pressed on the whole page need none"),
    value: z.string().optional().describe("What to type, the label of the option to select, or the path of a file to upload"),
    key: z.string().optional().describe("Which key press_key presses, such as Escape"),
    destination: z.number().int().optional().describe("For drag: the number of the element to drop on"),
    accept_dialog: z.boolean().optional().describe("Say yes to a confirm or prompt this action raises (\"Delete this item?\"). By default it is turned down"),
    allow_irreversible: z.boolean().optional().describe("Act even if the control pays, sends, posts or deletes; only when the user wants it"),
    session,
  },
}, tool((b, { accept_dialog, allow_irreversible, session: _, ...args }) => b.actOn({ ...args, acceptDialog: !!accept_dialog, allowIrreversible: !!allow_irreversible })));

server.registerTool("browser_screenshot", {   // the page as a picture
  title: "Screenshot",
  description: "A picture of the current page: what is on screen, or all of it with full_page.",
  inputSchema: { full_page: z.boolean().optional(), session },
}, tool(async (b, { full_page }) => {
  const buf = await b.screenshot({ fullPage: !!full_page });
  return { content: [{ type: "image", mimeType: "image/png", data: buf.toString("base64") }] };
}));

server.registerTool("browser_sessions", {
  title: "List sessions",
  description: "The open browser sessions, their current URLs and whether a call is running in each.",
  inputSchema: {},
}, async () => text({ sessions: pool.list() }));

server.registerTool("browser_close", {   // one session, or all of them
  title: "Close session",
  description: "Close a session's tab (default \"main\"), or every session and the browser connection with all=true. The next call on a closed session starts a fresh tab.",
  inputSchema: { session, all: z.boolean().optional() },
}, async ({ session: name, all }) => {
  try {
    if (all) { await pool.closeAll(); return text({ closed: "all" }); }
    return text({ closed: await pool.close(name ?? "main") });
  } catch (e) { return fail(e); }
});

// Close only what this server opened: its tabs, and a browser it launched itself. Don't wait on a
// step that is still running, and don't hang on a browser that no longer answers.
let exiting = false;
const shutdown = async () => {
  if (exiting) return;
  exiting = true;
  setTimeout(() => process.exit(0), 5000).unref();
  await Promise.race([pool.closeAll().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
process.stdin.on("close", shutdown);
const transport = new StdioServerTransport(); await server.connect(transport);
