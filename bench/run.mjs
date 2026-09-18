#!/usr/bin/env node
// Runs the benchmark tasks and judges each one by what the page says afterwards, not by what the
// step claims. A step is only correct when its status is the expected one AND its check in the page
// returns true; a "done" over a failed check is a false done, the number this project guards above
// speed.
//
// usage: node bench/run.mjs, optionally with --set base|hard|guard|local|all, --only id,id, --concurrency 3 and --out file.json

import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Barq } from "../src/session.mjs";
import { RecipeBook } from "../src/recipes.mjs";
import { TASKS, HARD, GUARD } from "./tasks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };

// tasks.local.mjs is git-ignored: everyday pages of our own, kept out of the repo
const LOCAL = existsSync(resolve(here, "tasks.local.mjs")) ? (await import("./tasks.local.mjs")).LOCAL : [];
const sets = { base: TASKS, hard: HARD, guard: GUARD, local: LOCAL };
const chosen = arg("--set", "all") === "all"
  ? [...TASKS, ...HARD, ...GUARD, ...LOCAL]
  : arg("--set", "all").split(",").flatMap(name => sets[name] ?? []);
const only = arg("--only")?.split(",").map(id => id.trim());
const queue = chosen.filter(t => !only || only.includes(t.id));

const outFile = resolve(arg("--out", resolve(here, "results", `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`)));
const browser = await chromium.launch({ headless: true });
// recipes are off unless asked for: a benchmark that replays its own runs measures the wrong thing
const recipes = process.env.BARQ_RECIPES ? new RecipeBook() : null;

async function runTask(task) {
  const b = await Barq.launch({ browser, recipes });
  const log = [], note = line => log.push(line);
  const r = { id: task.id, cat: task.cat, expect: task.expect || "pass", guard: !!task.guard, steps: [] };
  const started = Date.now();
  let allStepsOk = true;

  try {
    await b.open(task.url);
    for (const step of task.steps) {
      note(`step: ${step.goal}`);
      let out;
      try {
        out = await b.do(step.goal, { values: step.values || {}, maxActions: step.maxActions || 10, allowIrreversible: !task.guard, log: note });
      } catch (e) {
        out = { status: "exception", info: String(e.message).split("\n")[0].slice(0, 200), rounds: [], actions: [] };
      }
      // ground truth: the page itself, or the events the step reported
      if (step.assert) {
        await b.settle();
        out.truth = await b.page.evaluate(`(${step.assert})()`).catch(e => `assert error: ${e.message.split("\n")[0]}`);
      }
      if (step.assertEvents) out.truth = out.actions.some(a => a.event && new RegExp(step.assertEvents, "i").test(a.event));

      out.expected_status = step.expectStatus || "done";
      // likely_done means "verify me", which is an acceptable answer wherever done is expected
      const statusOk = out.status === out.expected_status || (out.expected_status === "done" && out.status === "likely_done");
      out.step_ok = statusOk && (out.truth === undefined || out.truth === true);
      note(`  => ${out.status}${out.info ? ` (${out.info})` : ""}${out.truth !== undefined ? ` truth=${out.truth}` : ""}`);
      r.steps.push({ goal: step.goal, ...out });
      if (!out.step_ok) { allStepsOk = false; break; }
    }
  } catch (e) {
    r.error = String(e.message).split("\n")[0];
    allStepsOk = false;
  }

  r.ms = Date.now() - started;
  r.calls = b.stats.calls;
  r.tokens = b.stats.tokens;
  r.jev_ms = b.stats.jev_ms;

  const last = r.steps.at(-1), ranEveryStep = r.steps.length === task.steps.length;
  r.claimed = ranEveryStep && r.steps.every(s => s.status === s.expected_status);
  r.truth = ranEveryStep && (last?.truth === undefined ? last?.status === "done" : last.truth === true);
  if (r.expect === "fail") {
    // tasks built to be impossible: getting them right means never claiming success
    r.correct = !r.steps.some(s => ["done", "likely_done"].includes(s.status));
    r.achieved = null;
  } else {
    r.correct = allStepsOk && ranEveryStep;
    r.achieved = r.truth;
  }
  r.false_done = r.steps.some(s => s.status === "done" && s.truth !== undefined && s.truth !== true);
  r.likely_done = r.steps.filter(s => s.status === "likely_done").map(s => ({ goal: s.goal, truth: s.truth }));
  r.log = log;

  await b.close();
  console.log(`${r.correct ? "✓" : "✗"} ${task.id.padEnd(22)} status=${last?.status || "-"} truth=${last?.truth} ${r.calls} calls ${(r.ms / 1000).toFixed(1)}s${r.false_done ? "  FALSE-DONE" : ""}`);
  return r;
}

const results = [];
let next = 0;
const worker = async () => { while (next < queue.length) results.push(await runTask(queue[next++])); };
await Promise.all(Array.from({ length: +arg("--concurrency", 3) }, worker));
await browser.close();
results.sort((a, b) => queue.findIndex(t => t.id === a.id) - queue.findIndex(t => t.id === b.id));

// where the guard would have stopped a task that wasn't asked to be guarded: too many of these and
// ordinary steps start needing confirmation
const wouldPause = results.filter(r => !r.guard).flatMap(r => r.steps.flatMap(s => (s.rounds || [])
  .filter(round => round.irreversible >= 0.6 && ["click", "press_enter", "press_key"].includes(round.tool))
  .map(round => `${r.id}: ${round.tool} ${round.el} (${round.irreversible})`)));

const calls = results.reduce((n, r) => n + r.calls, 0);
const summary = {
  tasks: results.length,
  correct: results.filter(r => r.correct).length,
  false_done: results.filter(r => r.false_done).length,
  likely_done: results.flatMap(r => r.likely_done.map(step => `${r.id}: ${step.goal} (truth=${step.truth})`)),
  calls,
  tokens: results.reduce((n, r) => n + r.tokens, 0),
  avg_jev_ms: Math.round(results.reduce((n, r) => n + r.jev_ms, 0) / Math.max(calls, 1)),
  guard_would_pause: wouldPause,   // unguarded tasks where the guard would have stopped
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ summary, results }, null, 1));

console.log(`\n${summary.correct}/${summary.tasks} correct · ${summary.false_done} false-done · ${calls} calls (avg ${summary.avg_jev_ms}ms) · ${summary.tokens} tokens`);
if (summary.likely_done.length) console.log(`likely_done (caller should verify):\n  ${summary.likely_done.join("\n  ")}`);
if (wouldPause.length) console.log(`the guard would have stopped these (tasks run unguarded):\n  ${wouldPause.join("\n  ")}`);
console.log(`→ ${outFile}`);
