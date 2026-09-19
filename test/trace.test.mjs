import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceLog, traceDir, redact } from "../src/trace.mjs";

test("trace directories follow each platform's convention and can be turned off", () => {
  assert.match(traceDir({}, "darwin"), /Library\/Logs\/jev-browser$/);
  assert.match(traceDir({ XDG_STATE_HOME: "/s" }, "linux"), /^\/s\/jev-browser\/traces$/);
  assert.equal(traceDir({ JEV_BROWSER_TRACES: "0" }, "darwin"), null);
  assert.equal(traceDir({ JEV_BROWSER_TRACES: "/t" }, "darwin"), "/t");
});

test("secret values are redacted wherever they appear; other values stay", () => {
  const r = redact({ actions: ["type <- values.password"], page_text: "Wrong password hunter22 for bob" }, { password: "hunter22", email: "bob@x.com" });
  assert.equal(r.page_text, "Wrong password [redacted] for bob");
  assert.deepEqual(redact({ a: "bob@x.com" }, { email: "bob@x.com" }), { a: "bob@x.com" });
});

test("a step is written as JSON under its day, and old days are pruned", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-trace-"));
  mkdirSync(join(dir, "2001-01-01"));
  mkdirSync(join(dir, "keep-me"));
  const log = new TraceLog({ dir, keepDays: 14 });
  assert.equal(existsSync(join(dir, "2001-01-01")), false);
  assert.equal(existsSync(join(dir, "keep-me")), true, "only day folders are pruned");
  const file = log.write("do", { goal: "Log in!", status: "done" }, { session: "side", values: { password: "pw-123" } });
  assert.match(file, /\d{4}-\d{2}-\d{2}\/\d+-side-log-in\.json$/);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(rec.status, "done");
  assert.equal(rec.session, "side");
  assert.equal(new TraceLog({ dir: null }).write("do", {}), null);
  rmSync(dir, { recursive: true, force: true });
});
