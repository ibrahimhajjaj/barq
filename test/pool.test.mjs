// Offline tests: sessions, queues, time limits and recovery, on a launched headless Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SessionPool, CallTimeout, CallCancelled } from "../src/pool.mjs";
import { LaunchedBrowser } from "../src/browsers.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
let server, base, pool, launches = 0;

before(async () => {
  server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<title>${req.url}</title><h1>${req.url}</h1>`); });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  pool = new SessionPool({ open: () => { launches++; return LaunchedBrowser.launch(); } });
});
after(async () => { await pool.closeAll(); server.close(); });

test("each session gets its own tab, and different sessions run side by side", async () => {
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    pool.run("a", async jb => { await jb.open(`${base}/a`); await sleep(400); return jb.page; }),
    pool.run("b", async jb => { await jb.open(`${base}/b`); await sleep(400); return jb.page; }),
  ]);
  assert.notEqual(a.result, b.result);
  assert.ok(Date.now() - t0 < 1500, "the two sessions waited on each other");
  assert.deepEqual(pool.list().map(s => s.url).sort(), [`${base}/a`, `${base}/b`]);
});

test("calls on one session run in order", async () => {
  const order = [];
  await Promise.all([
    pool.run("a", async () => { await sleep(200); order.push(1); }),
    pool.run("a", async () => { order.push(2); }),
  ]);
  assert.deepEqual(order, [1, 2]);
});

test("a call that runs out of time keeps a tab that still answers, and is told to stop", async () => {
  await pool.run("slow", jb => jb.open(`${base}/kept`));
  let stopped = false;
  await assert.rejects(pool.run("slow", (jb, signal) => new Promise(resolve => signal.addEventListener("abort", () => { stopped = true; resolve(); })), { timeoutMs: 300 }), CallTimeout);
  assert.ok(stopped);
  const { result, recovered } = await pool.run("slow", jb => jb.page.url());
  assert.equal(result, `${base}/kept`);
  assert.equal(recovered, false);
});

test("a tab that stops answering is replaced and reopened at the last URL", async () => {
  await pool.run("hung", jb => jb.open(`${base}/hung`));
  await assert.rejects(pool.run("hung", jb => jb.page.evaluate("while (true) {}"), { timeoutMs: 500 }), CallTimeout);
  const { result, recovered } = await pool.run("hung", jb => jb.page.url());
  assert.equal(result, `${base}/hung`);
  assert.equal(recovered, true);
});

test("the caller can cancel a call", async () => {
  const ac = new AbortController();
  const call = pool.run("cancel", () => new Promise(() => {}), { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(call, CallCancelled);
  assert.equal((await pool.run("cancel", () => "next call runs")).result, "next call runs");
});

test("a crashed tab is replaced", async () => {
  await pool.run("crash", jb => jb.open(`${base}/crash`));
  // Page.crash never answers: the renderer is gone before it could
  await pool.run("crash", async jb => { const s = await jb.context.newCDPSession(jb.page); s.send("Page.crash").catch(() => {}); await sleep(1500); });
  const { result, recovered } = await pool.run("crash", jb => jb.page.url());
  assert.equal(result, `${base}/crash`);
  assert.equal(recovered, true);
});

test("a tab closed between calls is replaced", async () => {
  await pool.run("c", jb => jb.open(`${base}/c`));
  await pool.run("c", jb => jb.page.close());
  const { result, recovered } = await pool.run("c", jb => jb.page.url());
  assert.equal(result, `${base}/c`);
  assert.equal(recovered, true);
});

test("a browser that died is launched again, once, however many sessions need it", async () => {
  await pool.run("d", jb => jb.open(`${base}/d`));
  await pool.run("d2", jb => jb.open(`${base}/d2`));
  const before = launches;
  await (await pool.browser()).dispose();
  const [a, b] = await Promise.all([pool.run("d", jb => jb.page.url()), pool.run("d2", jb => jb.page.url())]);
  assert.equal(launches, before + 1);
  assert.equal(a.result, `${base}/d`);
  assert.equal(b.result, `${base}/d2`);
});

test("closing a session stops its running call and fails the queued ones; the name can be used again", async () => {
  await pool.run("g", jb => jb.open(`${base}/g`));
  const running = pool.run("g", (jb, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))));
  const queued = pool.run("g", () => "should not run");
  await sleep(100);
  assert.equal(await pool.close("g"), true);
  await assert.rejects(running);
  await assert.rejects(queued, /was closed/);
  const { result } = await pool.run("g", jb => jb.page.url());
  assert.equal(result, "about:blank", "a new session starts in a fresh tab");
});

test("closing a session closes only its tab", async () => {
  await pool.run("e", jb => jb.open(`${base}/e`));
  await pool.run("f", jb => jb.open(`${base}/f`));
  assert.equal(await pool.close("e"), true);
  assert.ok(!pool.list().some(s => s.session === "e"));
  assert.equal((await pool.run("f", jb => jb.page.url())).result, `${base}/f`);
});
