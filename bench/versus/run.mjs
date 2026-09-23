// Head-to-head: the same driving model does the same tasks through Playwright MCP and through
// barq, and reports the code each task hands out only when it is really done.
// usage: node bench/versus/run.mjs [--stacks playwright,barq] [--only id,id] [--model sonnet] [--out file.json]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { start, TASKS, LIVE } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const stacks = arg("--stacks", "playwright,barq").split(",");
const only = arg("--only")?.split(",");
const model = arg("--model", "sonnet");
const transcripts = process.argv.includes("--transcripts");
const out = resolve(arg("--out", join(here, "..", "results", `versus-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`)));

const SERVERS = {
  playwright: { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp@0.0.82", "--headless", "--isolated"] },
  barq: { name: "barq", command: process.execPath, args: [resolve(here, "../../bin/barq-mcp.mjs")], env: { BARQ_ATTACH: "launch" } },
};

function drive(stack, task, base) {
  const dir = mkdtempSync(join(tmpdir(), "barq-versus-"));
  const { name, ...server } = SERVERS[stack];
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: server } }));
  const prompt = task.check
    ? `Use the browser tools to do this. Open ${task.url}. Goal: ${task.goal} When it is done, reply with only the full URL of the page you ended on, nothing else.`
    : `Use the browser tools to do this. Open ${base}${task.path}. Goal: ${task.goal} When it is done the site shows a confirmation code. Reply with only that code, nothing else. If you can't get it, reply NONE.`;
  const args = ["-p", prompt, "--model", model, "--output-format", transcripts ? "stream-json" : "json", ...(transcripts ? ["--verbose"] : []), "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", join(dir, "mcp.json"),
    "--allowedTools", `mcp__${name}`, "--disable-slash-commands", "--no-session-persistence", "--max-turns", "40"];
  return new Promise(done => {
    const t0 = Date.now();
    const p = spawn("claude", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = "";
    p.stdout.on("data", d => so += d); p.stderr.on("data", d => se += d);
    const kill = setTimeout(() => p.kill("SIGKILL"), 10 * 60_000);
    p.on("close", () => {
      clearTimeout(kill);
      let r = null, calls = [];
      if (transcripts) {
        const events = so.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        r = events.find(e => e.type === "result") ?? null;
        calls = events.filter(e => e.type === "assistant").flatMap(e => e.message.content.filter(c => c.type === "tool_use").map(c => `${c.name.replace(/^mcp__\w+__/, "")} ${JSON.stringify(c.input).slice(0, 160)}`));
      } else { try { r = JSON.parse(so); } catch {} }
      done({ ms: Date.now() - t0, reply: r?.result?.trim() ?? null, cost: r?.total_cost_usd ?? null, turns: r?.num_turns ?? null,
        tokens: r?.usage ? (r.usage.input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.output_tokens ?? 0) : null,
        error: r ? (r.is_error ? r.subtype : null) : (se || so).slice(0, 300), ...(transcripts ? { calls } : {}) });
    });
  });
}

const { server, base, codes } = await start();
const results = [];
try {
  for (const task of [...TASKS, ...LIVE].filter(t => !only || only.includes(t.id))) {
    for (const stack of stacks) {
      const r = await drive(stack, task, base);
      const right = task.check ? task.check(r.reply?.trim() ?? "") : r.reply?.includes(codes[task.id]) ?? false;
      results.push({ task: task.id, stack, right, ...r });
      console.log(`${right ? "✓" : "✗"} ${task.id.padEnd(8)} ${stack.padEnd(10)} ${(r.ms / 1000).toFixed(1)}s  $${r.cost?.toFixed(3) ?? "?"}  ${r.turns ?? "?"} turns  ${r.tokens ?? "?"} tokens${r.error ? `  (${r.error})` : ""}${right ? "" : `  reply=${JSON.stringify(r.reply)}`}`);
    }
  }
} finally { server.close(); }
const sum = stacks.map(s => { const rs = results.filter(r => r.stack === s), n = rs.length || 1;
  return { stack: s, right: `${rs.filter(r => r.right).length}/${rs.length}`, median_s: +(rs.map(r => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)] / 1000).toFixed(1), cost_usd: +rs.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(3), tokens: rs.reduce((a, r) => a + (r.tokens ?? 0), 0), turns: +(rs.reduce((a, r) => a + (r.turns ?? 0), 0) / n).toFixed(1) }; });
console.table(sum);
writeFileSync(out, JSON.stringify({ model, at: new Date().toISOString(), summary: sum, results }, null, 1));
console.log("→", out);
