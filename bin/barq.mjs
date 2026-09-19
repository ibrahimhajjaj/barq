#!/usr/bin/env node
// barq run <flow.json> [--headed] [--json] [--allow-irreversible]
// barq do <url> "<goal>" [key=value ...] [--headed] [--allow-irreversible]
// barq scan <jobs.json|urls.txt> [--js <expr> | --selector <css> | --extract <module>] [--out <file.jsonl>] ...
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scan } from "../src/scan.mjs";
import { openBrowser, browserConfig } from "../src/browsers.mjs";
import { runFlow } from "../src/flow.mjs";
import { Barq } from "../src/session.mjs";

const argv = process.argv.slice(2);   // what follows `barq`
const flag = name => argv.includes(name);
// options that take a value; everything else starting with -- is a switch
const VALUED = new Set(["--js", "--selector", "--extract", "--out", "--tabs", "--jitter", "--click-until-gone", "--wait-for", "--retries"]);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const pos = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));
const headed = flag("--headed");   // show the browser
const allowIrreversible = flag("--allow-irreversible");   // go through orders, payments, sends

const usage = () => {
  console.error(`usage:
  barq run <flow.json> [--headed] [--json] [--allow-irreversible]
  barq do <url> "<goal>" [key=value ...] [--headed] [--allow-irreversible]
  barq scan <jobs.json|urls.txt> [--js <expr> | --selector <css> | --extract <module.mjs>]
            [--out <file.jsonl>] [--tabs 3] [--jitter 1000-3000] [--click-until-gone <text>]
            [--wait-for <css>] [--retries 1] [--headed]
    jobs.json: an array of URLs or of { url, key?, ... }; a .txt file: one URL per line.
    Results go one JSON line per page to --out; a rerun with the same --out skips what's done.
    Your own browser: set BARQ_ATTACH=edge (or chrome...), as for the MCP server.`);
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
} else if (pos[0] === "scan" && pos[1]) {
  const text = readFileSync(pos[1], "utf8");
  const jobs = pos[1].endsWith(".json") ? JSON.parse(text) : text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const extract = opt("--extract") ? (await import(pathToFileURL(resolve(opt("--extract"))).href)).default : undefined;
  const [lo, hi] = (opt("--jitter") ?? "1000-3000").split("-").map(Number);
  const out = resolve(opt("--out") ?? `scan-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const host = await openBrowser({ ...browserConfig(), ...(headed ? { headed: true } : {}) });
  let n = 0;
  try {
    const summary = await scan(host, jobs, {
      tabs: Number(opt("--tabs") ?? 3), jitter: [lo, hi ?? lo], checkpoint: out, retries: Number(opt("--retries") ?? 1),
      js: opt("--js"), selector: opt("--selector"), extract, clickUntilGone: opt("--click-until-gone"), waitFor: opt("--wait-for"),
      onRecord: (r, s) => { if (++n % 10 === 0 || r.error) console.error(`${s.done + s.errors}/${s.total - s.skipped}${r.error ? ` error on ${r.key}: ${r.error}` : ""}`); },
    });
    console.log(JSON.stringify(summary, null, 1));
    if (summary.blocked) console.error(`stopped: ${summary.blocked}. A person has to look at the site before going on; rerun with the same --out to resume.`);
    process.exitCode = summary.blocked ? 2 : summary.errors ? 1 : 0;
  } finally { await host.dispose(); }
} else usage();
