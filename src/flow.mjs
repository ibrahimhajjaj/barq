// Runs a flow written as JSON, shaped { name, url, steps: [{ goal, values?, url?, maxActions?, assert? }] }.
// A step's `assert` is the source of a function run in the page afterwards: what really happened, whatever the step said.
import { Barq } from "./session.mjs";

const SUCCEEDED = new Set(["done", "likely_done"]);
const firstLine = e => String(e?.message ?? e).split("\n")[0];

// One step, start to finish: run it, then let the page say whether it really happened.
async function runStep(b, step, number, { log, allowIrreversible }) {
  if (step.url) await b.open(step.url);   // a step can start somewhere else
  log(`step ${number}: ${step.goal}`);

  const values = step.values ?? (step.text == null ? {} : { text: step.text });
  let rec;
  try {
    rec = await b.do(step.goal, {
      values,
      log,
      maxActions: step.maxActions ?? 10,
      allowIrreversible: step.allowIrreversible ?? allowIrreversible,
    });
  } catch (e) {
    rec = { status: "exception", goal: step.goal, info: firstLine(e).slice(0, 200), rounds: [] };
  }

  rec.step = number;
  rec.ok = SUCCEEDED.has(rec.status);
  if (step.assert) {
    await b.settle();
    rec.truth = await b.page.evaluate(`(${step.assert})()`).catch(e => `assert error: ${firstLine(e)}`);
  }

  const why = rec.info ? ` (${rec.info})` : "";
  const truth = step.assert ? `  truth=${rec.truth}` : "";
  log(`  => ${rec.status}${why}${truth}  ${rec.jev_calls ?? 0} calls ${rec.ms ?? 0}ms`);
  return rec;
}

export async function runFlow(flow, options = {}) {
  const {
    headed = false, slowMo = 0, browser, log = console.log,
    stopOnFail = flow.stopOnFail !== false, allowIrreversible = false,
  } = options;

  const b = await Barq.launch({ headed, slowMo, browser });
  const startedAt = Date.now();
  const results = [];
  try {
    await b.open(flow.url);
    for (const [index, step] of flow.steps.entries()) {
      const rec = await runStep(b, step, index + 1, { log, allowIrreversible });
      results.push(rec);
      if (stopOnFail && !rec.ok) break;
    }
  } finally {
    await b.close();
  }

  return {
    name: flow.name,
    results,
    total_ms: Date.now() - startedAt,
    ...b.stats,
    passed: results.filter(r => r.ok).length,
    steps: flow.steps.length,
  };
}
