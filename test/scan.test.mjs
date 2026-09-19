// Offline tests: scanning many pages from a local server, no decision model involved.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { scan, normalizeJobs } from "../src/scan.mjs";

let browser, context, server, base, live = 0, peak = 0, flakyHits = 0;
const host = { newTab: () => context.newPage() };
const dir = mkdtempSync(join(tmpdir(), "barq-scan-"));
const sleep = ms => new Promise(done => setTimeout(done, ms));

before(async () => {
  server = http.createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/favicon.ico") return res.writeHead(404).end();
    live++; peak = Math.max(peak, live);
    try {
      if (path.startsWith("/p/")) {
        await sleep(200);
        const n = path.slice(3);
        res.setHeader("content-type", "text/html");
        return res.end(`<title>page ${n}</title><ul><li>item ${n}a</li><li>item ${n}b</li></ul>`);
      }
      if (path === "/more") {
        res.setHeader("content-type", "text/html");
        return res.end(`<ul><li>row 1</li></ul><button onclick="const u = document.querySelector('ul'); u.insertAdjacentHTML('beforeend', '<li>row ' + (u.children.length + 1) + '</li>'); if (u.children.length >= 4) this.remove()">Load more</button>`);
      }
      if (path === "/blocked") { res.writeHead(302, { location: "/sorry/index?continue=x" }); return res.end(); }
      if (path.startsWith("/sorry/")) { res.setHeader("content-type", "text/html"); return res.end("<p>unusual traffic</p>"); }
      if (path === "/flaky") {
        if (++flakyHits === 1) { await sleep(3000); }
        res.setHeader("content-type", "text/html");
        return res.end("<li>steady now</li>");
      }
      res.writeHead(404).end();
    } finally { live--; }
  });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
});
after(async () => { await browser.close(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });

const lines = f => readFileSync(f, "utf8").trim().split("\n").map(l => JSON.parse(l));

test("jobs are URLs or objects, keyed by URL unless given a key, and repeats are dropped", () => {
  const jobs = normalizeJobs(["https://a/1", { url: "https://a/2", key: "two", day: 5 }, "https://a/1"]);
  assert.deepEqual(jobs, [{ url: "https://a/1", key: "https://a/1" }, { url: "https://a/2", key: "two", day: 5 }]);
  assert.throws(() => normalizeJobs([{ key: "x" }]), /no url/);
});

test("pages are read in a few tabs at once, one JSON line each, and a rerun skips what's done", async () => {
  const file = join(dir, "first.jsonl");
  peak = 0;
  const urls = [1, 2, 3, 4].map(n => `${base}/p/${n}`);
  const s1 = await scan(host, urls, { tabs: 2, jitter: [0, 0], checkpoint: file, selector: "li" });
  assert.deepEqual([s1.done, s1.errors, s1.skipped, s1.blocked], [4, 0, 0, null]);
  assert.ok(peak === 2, `two tabs at a time, saw ${peak}`);
  const rows = lines(file);
  assert.deepEqual(rows.find(r => r.url.endsWith("/p/3")).result, ["item 3a", "item 3b"]);
  const s2 = await scan(host, [...urls, `${base}/p/5`, `${base}/p/6`], { tabs: 2, jitter: [0, 0], checkpoint: file, js: "document.title" });
  assert.deepEqual([s2.skipped, s2.done], [4, 2]);
  assert.equal(lines(file).length, 6);
  assert.equal(lines(file).at(-1).result.startsWith("page "), true);
});

test("a 'load more' button is clicked until it's gone, and the result has every row", async () => {
  let rec;
  await scan(host, [`${base}/more`], { tabs: 1, jitter: [0, 0], selector: "li", clickUntilGone: "Load more", onRecord: r => { rec = r; } });
  assert.deepEqual(rec.result, ["row 1", "row 2", "row 3", "row 4"]);
  assert.equal(rec.clicks, 3);
});

test("a site's 'unusual traffic' page stops the whole scan, and what's left stays to do", async () => {
  const file = join(dir, "blocked.jsonl");
  const s = await scan(host, [`${base}/p/1`, `${base}/blocked`, `${base}/p/3`, `${base}/p/4`], { tabs: 1, jitter: [0, 0], checkpoint: file });
  assert.match(s.blocked, /sorry/);
  assert.equal(s.done, 1);
  assert.equal(s.left, 3, "the blocked page and the two after it");
  assert.deepEqual(lines(file).map(r => r.url.split("/").pop()), ["1"]);
});

test("an error gets one more try; a page that keeps failing is written as an error and tried again on the next run", async () => {
  flakyHits = 0;
  let rec;
  const s = await scan(host, [`${base}/flaky`], { tabs: 1, jitter: [0, 0], timeout: 1000, selector: "li", onRecord: r => { rec = r; } });
  assert.deepEqual([s.done, s.errors], [1, 0]);
  assert.deepEqual(rec.result, ["steady now"]);
  const file = join(dir, "missing.jsonl");
  const s2 = await scan(host, [`${base}/nowhere-at-all`], { tabs: 1, jitter: [0, 0], checkpoint: file, waitFor: "li", timeout: 500, js: "(() => { throw new Error('nothing here') })()" });
  assert.equal(s2.errors, 1);
  assert.equal(lines(file)[0].attempt, 2);
  const s3 = await scan(host, [`${base}/nowhere-at-all`], { tabs: 1, jitter: [0, 0], checkpoint: file, timeout: 500, js: "1" });
  assert.equal(s3.skipped, 0, "an error isn't a done page");
});
