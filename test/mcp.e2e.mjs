#!/usr/bin/env node
// End to end: start the MCP server on stdio and work TodoMVC through nothing but its tools.
// Needs the network and a TypeSafe key. Run: node test/mcp.e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const server = fileURLToPath(new URL("../bin/barq-mcp.mjs", import.meta.url));
const client = new Client({ name: "barq-e2e", version: "0" });
// recipes off: a replay would skip the decisions this checks, and the user's recipe file stays untouched
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, BARQ_RECIPES: "0" } }));

// Every reply is measured as well as checked: the point of these tools is how little text the
// caller has to read, so a tool that starts returning pages should be visible here.
const replyChars = {};

async function call(name, args = {}) {   // one tool call, failing loudly
  const started = Date.now();
  const reply = await client.callTool({ name, arguments: args });
  const [part] = reply.content;
  const text = part.type === "text" ? part.text : "";
  replyChars[name] = (replyChars[name] ?? 0) + text.length;
  if (reply.isError) throw new Error(`${name}: ${text}`);
  const shown = part.type === "text" ? (process.env.FULL ? text : text.slice(0, 160).replace(/\n/g, " ")) : `[${part.type} ${part.data.length} b64 chars]`;
  console.log(`${name} ${Date.now() - started}ms`, shown);
  return part.type === "text" ? (text.startsWith("{") ? JSON.parse(text) : text) : part;
}

try {
const TOOLS = ["browser_act", "browser_call_site_tool", "browser_check", "browser_choose", "browser_close", "browser_do", "browser_open", "browser_read", "browser_scan", "browser_scan_status", "browser_screenshot", "browser_sessions", "browser_site_tools", "browser_snapshot"];
assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), TOOLS);

// a small list app: two items typed, one ticked, then read back
await call("browser_open", { url: "https://demo.playwright.dev/todomvc/#/" });
const first = await call("browser_do", { goal: "Add a todo item", values: { todo: "book the flight" } });
assert.equal(first.status, "done");

const second = await call("browser_do", { goal: "Add a todo item", values: { todo: "renew the passport" }, explain: true });
assert.ok(["done", "likely_done"].includes(second.status), second.status);   // likely_done asks the caller to look, which the check below does
assert.ok(second.rounds.length >= 1, "explain returns the rounds");

// the step left a trace with its rounds, and with value names but no contents
const trace = JSON.parse(readFileSync(second.trace, "utf8"));
assert.equal(trace.goal, "Add a todo item");
assert.deepEqual(trace.values, ["todo"]);
assert.ok(trace.rounds.length >= 1);

const both = await call("browser_check", { question: "Are there exactly two todo items, 'book the flight' and 'renew the passport'?" });
assert.ok(both.p_yes > 0.6, `check p=${both.p_yes}`);
const left = await call("browser_choose", { question: "How many items are left?", options: ["0", "1", "2", "3"] });
assert.equal(left.choice, "2");

// taking over by hand: the snapshot numbers an element, browser_act works on that number
const snapshot = await call("browser_snapshot");
const toggle = snapshot.split("\n").find(l => /input:checkbox label="Toggle Todo"/.test(l) && /book the flight/.test(l));
assert.ok(toggle, "the snapshot lists the toggle of the first item");
await call("browser_act", { action: "click", element: +toggle.match(/^\[(\d+)\]/)[1] });
const ticked = await call("browser_check", { question: "Is 'book the flight' marked as completed while 'renew the passport' is not?" });
assert.ok(ticked.p_yes > 0.6, `check p=${ticked.p_yes}`);

const read = await call("browser_read", { question: "Which todo items are on the list?" });
assert.ok(read.passages.some(p => /renew the passport/.test(p.text)), "the reader finds the items");
await call("browser_screenshot", {});

// a second session works in its own tab while the first keeps its page
const [side, stillThere] = await Promise.all([
  call("browser_open", { url: "https://example.com/", session: "side" }),
  call("browser_check", { question: "Is this a todo list app?" }),
]);
assert.equal(side.session, "side");
assert.ok(stillThere.p_yes > 0.6, `the main session lost its page: p=${stillThere.p_yes}`);
assert.deepEqual((await call("browser_sessions")).sessions.map(s => s.session).sort(), ["main", "side"]);

// many pages and no decisions at all: started in the background, followed by its id
const scan = await call("browser_scan", { urls: ["https://example.com/", "https://example.org/"], js: "document.title", tabs: 2 });
let progress;
for (let i = 0; i < 60; i++) {
  progress = await call("browser_scan_status", { scan: scan.scan });
  if (progress.status !== "running") break;
  await new Promise(r => setTimeout(r, 500));
}
assert.equal(progress.status, "finished");
assert.equal(progress.summary.done, 2);
assert.equal(readFileSync(scan.file, "utf8").trim().split("\n").length, 2, "one line per page");

// a name nobody opened is a slip, not an empty cleanup: it says so and lists what is open
const slip = await client.callTool({ name: "browser_close", arguments: { session: "all-of-them" } });
assert.ok(slip.isError, "closing an unknown session should be an error");
assert.match(slip.content[0].text, /no session named "all-of-them".*main.*side/s);

// "all" as the session name means every session, the way the description says
await call("browser_close", { session: "all" });
assert.deepEqual((await call("browser_sessions")).sessions, [], "nothing is left open");
console.log("\nMCP e2e passed. Text returned to the client (chars):", replyChars);
} finally {
  await client.close();
}
