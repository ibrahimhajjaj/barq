#!/usr/bin/env node
// What a benchmark run would have cost the calling model in tokens, against the usual way of
// driving a browser: a page snapshot after every action. barq sends back a few lines per step
// instead, and the page itself is read by Jev, which the caller never pays for.
//
//   node bench/context-cost.mjs bench/results/<run>.json
//
// The snapshot side is an estimate: the page is loaded once now and its accessibility snapshot
// counted once per action the run took, which is what a snapshot-per-action loop would have sent.

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { TASKS, HARD, GUARD } from "./tasks.mjs";

const run = JSON.parse(readFileSync(process.argv[2], { encoding: "utf8" }));
const byId = new Map(run.results.map(result => [result.id, result]));
const tasks = [...TASKS, ...HARD, ...GUARD].filter(t => byId.has(t.id));
const tokens = chars => Math.round(chars / 4);

// what the caller actually receives for one step
function stepReply(step) {
  const actions = (step.actions || []).map(a => a.event ? `(event) ${a.event}` : `${a.action} ${a.element || ""}${a.value ? ` <- values.${a.value}` : ""}`);
  const reply = { status: step.status, url: step.url, title: step.title, actions, done_score: step.done_score, jev_calls: step.jev_calls, ms: step.ms };
  for (const field of ["info", "pending", "page_text", "candidates"]) if (step[field]) reply[field] = step[field];
  return JSON.stringify(reply, null, 1);
}

const browser = await chromium.launch({ headless: true });
const rows = [];
for (const task of tasks) {
  const result = byId.get(task.id);
  const page = await browser.newPage({ viewport: { height: 800, width: 1280 } });
  let snapshot = "";
  try {
    await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500);   // late content
    snapshot = await page.ariaSnapshot({ mode: "ai" });
  } catch { /* a page that won't load counts as nothing, which understates the snapshot side */ }
  await page.close();

  const actions = result.steps.reduce((n, s) => n + (s.actions || []).filter(a => a.action).length, 0);
  rows.push({
    id: task.id,
    actions,
    steps: result.steps.length,
    snapshot_tokens: tokens(snapshot.length),
    playwright_mcp_tokens: tokens((actions + 1) * snapshot.length),
    jev_browser_tokens: tokens(300 + result.steps.reduce((n, s) => n + stepReply(s).length, 0)),
    jev_tokens_offloaded: result.tokens,
  });
}
await browser.close();

const col = (v, w) => String(v).padStart(w);
const total = field => rows.reduce((n, row) => n + row[field], 0);
const ratio = row => row.playwright_mcp_tokens / row.jev_browser_tokens;

console.log(`${"task".padEnd(22)}${col("actions", 8)}${col("snap tok", 10)}${col("full tok", 12)}${col("barq tok", 11)}${col("ratio", 7)}`);
for (const row of rows) console.log(`${row.id.padEnd(22)}${col(row.actions, 8)}${col(row.snapshot_tokens, 10)}${col(row.playwright_mcp_tokens, 12)}${col(row.jev_browser_tokens, 11)}${col(`${ratio(row).toFixed(1)}×`, 7)}`);

const ratios = rows.map(ratio).sort((a, b) => a - b);
console.log(`\ntotal: snapshot-style ≈ ${total("playwright_mcp_tokens")} tokens to the LLM; barq ≈ ${total("jev_browser_tokens")} tokens to the LLM (+ ${total("jev_tokens_offloaded")} tokens read by model)`);
console.log(`median ratio ${ratios[Math.floor(ratios.length / 2)].toFixed(1)}×`);
