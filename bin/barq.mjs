#!/usr/bin/env node
// barq run <flow.json> [--headed] [--json] [--allow-irreversible]
// barq do <url> "<goal>" [key=value ...] [--headed] [--allow-irreversible]
import { readFileSync } from "node:fs";
import { runFlow } from "../src/flow.mjs";
import { Barq } from "../src/session.mjs";

const argv = process.argv.slice(2);   // what follows `barq`
const flag = name => argv.includes(name);
const pos = argv.filter(arg => !arg.startsWith("--"));
const headed = flag("--headed");   // show the browser
const allowIrreversible = flag("--allow-irreversible");   // go through orders, payments, sends

const usage = () => {
  console.error(`usage:
  barq run <flow.json> [--headed] [--json] [--allow-irreversible]
  barq do <url> "<goal>" [key=value ...] [--headed] [--allow-irreversible]`);
  process.exit(2);
};

if (pos[0] === "run" && pos[1]) {   // barq run flow.json
  const flow = JSON.parse(readFileSync(pos[1], { encoding: "utf8" }));
  console.log(`▶ ${flow.name ?? pos[1]} at ${flow.url}`);
  const out = await runFlow(flow, { headed, allowIrreversible, slowMo: headed ? 300 : 0 });
  console.log(`\n${out.passed} of ${out.steps} steps done, ${out.calls} Jev calls, ${out.jev_ms} ms in Jev out of ${out.total_ms} ms`);
  if (flag("--json")) console.log(JSON.stringify(out, null, 2));
  process.exit(out.passed < out.steps ? 1 : 0);
} else if (pos[0] === "do" && pos[1] && pos[2]) {
  const values = Object.fromEntries(pos.slice(3).map(pair => [pair.split("=")[0], pair.split("=").slice(1).join("=")]));
  const b = await Barq.launch({ headed, slowMo: headed ? 300 : 0 });
  try {
    await b.open(pos[1]);
    const r = await b.do(pos[2], { values, log: console.log, allowIrreversible });
    const { rounds, ...rest } = r;   // the rounds are in the trace
    console.log(JSON.stringify(rest, null, 2));
    process.exitCode = r.status !== "done" ? 1 : 0;
  } finally { await b.close(); }
} else usage();
