#!/usr/bin/env node
// An MCP server on stdio: one browser session, kept between calls, that Jev drives for the client.
//
//   claude mcp add jev-browser -- node <checkout>/bin/jev-browser-mcp.mjs
//
// Environment: TYPESAFE_API_KEY, and JEV_BROWSER_HEADED=1 to watch it,
// JEV_BROWSER_PROFILE=<dir> for a profile kept on disk with its logins, JEV_BROWSER_LOG=1 for each round on stderr
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JevBrowser } from "../src/session.mjs";

// What is kept is the promise of a launch rather than the session, so calls that arrive together get one browser.
let session;
function browser() {
  session ??= JevBrowser.launch({ userDataDir: process.env.JEV_BROWSER_PROFILE || undefined, headed: process.env.JEV_BROWSER_HEADED === "1", highlight: process.env.JEV_BROWSER_HEADED === "1" })
    .catch(e => { session = undefined; throw e; });   // a failed launch is tried again next call
  return session;
}
async function closeSession() {   // safe to call with nothing open
  if (!session) return;
  const s = session; session = undefined;   // taken before the await, so nothing new lands on it
  const open = await s.catch(() => null); await open?.close();
}
const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] });
const fail = e => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e).split("\n", 1)[0] }] });
const wrap = fn => async args => fn(args).catch(fail);
const stderrLog = process.env.JEV_BROWSER_LOG === "1" ? line => process.stderr.write(`${line}\n`) : () => {};

const server = new McpServer({ version: "0.1.1", name: "jev-browser" });

server.registerTool("browser_open", {   // go to an address
  title: "Open URL",
  description: "Go to a URL and wait for the page to settle. The first call starts the browser.",
  inputSchema: { url: z.string().describe("A full address, scheme included") },
}, wrap(async ({ url }) => {
  const b = await browser();
  const r = await b.open(url);
  const page = await b.snapshot();   // as it stands now
  return text(Object.assign({}, r, { elements: page.elements.length, visible_text: page.text.substring(0, 400) }));
}));

server.registerTool("browser_do", {   // one outcome, Jev choosing each action
  title: "Do one browser step",
  description: [
    "Reach ONE outcome you could see on the current page. A fast decision model, Jev, chooses every element, action and value; it can't plan or write text, so:",
    "- Give one outcome per call (\"Log in\", \"Put the Backpack in the cart\", \"Open the Pull requests tab\"); steps that must happen in order are separate calls.",
    "- Everything to type, every option to pick and every file to upload goes in `values`, under names that say what it is ({email, password}).",
    "- Give an open-ended goal an end you can count (\"until at least 3 new results are shown\").",
    "What comes back: done; likely_done (Jev isn't sure the goal was met, so check with browser_check or browser_snapshot first); needs_login (a sign-in wall and no credentials: have the user log in, for instance with JEV_BROWSER_HEADED=1 and JEV_BROWSER_PROFILE, or pass them in values); needs_confirmation (the next click looks irreversible: call again with allow_irreversible=true only if the user wants it); error (the page shows one); blocked; stuck; ambiguous (see candidates, then browser_act); max_actions.",
    "After a step that changes something, confirm with browser_check that nothing else changed with it.",
  ].join("\n"),
  inputSchema: {
    goal: z.string().describe("One outcome you could see on the page"),
    values: z.record(z.string(), z.string()).optional().describe("Strings Jev may type, select or upload, each under a name"),
    max_actions: z.number().int().min(1).max(30).optional().describe("Actions allowed in this step. Default 10"),
    allow_irreversible: z.boolean().optional().describe("Go ahead with actions that are hard to undo: ordering, paying, sending, deleting"),
    explain: z.boolean().optional().describe("Put Jev's probabilities for every round in the result"),
  },
}, wrap(async ({ goal, values, max_actions, allow_irreversible, explain }) => {
  const b = await browser();
  const r = await b.do(goal, { log: stderrLog, values: values ?? {}, maxActions: max_actions ?? 10, allowIrreversible: Boolean(allow_irreversible) });
  const actions = r.actions.map(h => h.event ? `(event) ${h.event}` : [h.action, h.key, h.element, h.value && `<- values.${h.value}`, h.option && `<- "${h.option}"`, h.destination && `-> ${h.destination}`, h.error && `ERROR: ${h.error}`].filter(Boolean).join(" "));
  const { status, url, title, done_score, jev_calls, ms } = r; const out = { status, url, title, actions, done_score, jev_calls, ms };
  for (const key of ["info", "pending", "page_text", "candidates"]) if (r[key]) out[key] = r[key];
  if (explain) out.rounds = r.rounds.map(({ candidates, ...round }) => round);
  return text(out);
}));

server.registerTool("browser_check", {   // a yes/no about the page
  title: "Check page",
  description: "A yes/no question about the current page, answered as the probability of yes: 0.85 or more is a reliable yes, 0.15 or less a reliable no, and in between you should look with browser_snapshot.",
  inputSchema: { question: z.string().describe("One yes/no question") },
}, wrap(async ({ question }) => {
  const b = await browser();
  const p = await b.check(question);   // 0 to 1
  return text({ question, p_yes: Number(p.toFixed(3)) });
}));

server.registerTool("browser_choose", {   // which of several things holds
  title: "Choose about page",
  description: "Which of several options holds for the current page. You supply the options, since Jev can't write any. Returns the one chosen and a probability for each.",
  inputSchema: { question: z.string(), options: z.array(z.string()).min(2).max(255).describe("Two to 255 answers to choose from") },
}, wrap(async ({ question, options }) => {
  const b = await browser();
  const r = await b.choose(question, options);   // { choice, probabilities }
  return text({ choice: r.choice, confidence: r.confidence, probabilities: Object.fromEntries(Object.entries(r.probabilities).map(([option, p]) => [option, Number(p.toFixed(3))])) });
}));

server.registerTool("browser_snapshot", {   // the page as numbered elements
  title: "Page snapshot",
  description: "The current page, short: the text on screen and every control, numbered. For taking over when browser_do comes back ambiguous or stuck; act on the numbers with browser_act.",
  inputSchema: {},
}, wrap(async () => text(await (await browser()).snapshotText())));

server.registerTool("browser_act", {   // one action on a numbered element
  title: "Act on element",
  description: "One action on an element number taken from the latest browser_snapshot or from browser_do's candidates, with no decision model involved. The number is matched to the page as it is now; if the element has gone, take a new snapshot. A confirm or prompt the action raises is turned down unless accept_dialog is true.",
  inputSchema: {
    action: z.enum("click type press_enter press_key select hover right_click drag upload scroll back".split(" ")),
    element: z.number().int().optional().describe("The element's number [i]; scroll, back and a key pressed on the whole page need none"),
    value: z.string().optional().describe("What to type, the label of the option to select, or the path of a file to upload"),
    key: z.string().optional().describe("Which key press_key presses, such as Escape"),
    destination: z.number().int().optional().describe("For drag: the number of the element to drop on"),
    accept_dialog: z.boolean().optional().describe("Say yes to a confirm or prompt this action raises (\"Delete this item?\"). By default it is turned down"),
  },
}, wrap(async ({ accept_dialog, ...args }) => text(await (await browser()).actOn({ ...args, acceptDialog: !!accept_dialog }))));

server.registerTool("browser_screenshot", {   // the page as a picture
  title: "Screenshot",
  description: "A picture of the current page: what is on screen, or all of it with full_page.",
  inputSchema: { full_page: z.boolean().optional().describe("The whole page rather than the screen") },
}, wrap(async ({ full_page }) => {
  const buf = await (await browser()).screenshot({ fullPage: Boolean(full_page) });
  return { content: [{ type: "image", mimeType: "image/png", data: buf.toString("base64") }] };
}));

server.registerTool("browser_close", {   // one session, or all of them
  title: "Close browser",
  description: "End the browser session; whatever is called next starts a new one.",
  inputSchema: {},
}, wrap(async () => {
  await closeSession();
  return text({ closed: true });   // nothing was left open
}));

const shutdown = () => closeSession().finally(() => process.exit(0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
const transport = new StdioServerTransport(); await server.connect(transport);
