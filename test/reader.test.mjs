// Offline tests for the page reader: block extraction on a fixture, passages, batching, and the
// ranking done around Jev's answer (Jev itself is stubbed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readBlocks, toText, passages, batches, findPassages } from "../src/reader.mjs";

const FIXTURE = `<!doctype html><html><head><title>Reader</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<header><h1>Coffee guide</h1></header>
<main>
  <div class="heading"><h2 style="display:inline">Growing</h2><span> [edit]</span></div>
  <div><div>Coffee grows in <b>over 70 countries</b>, mostly near the equator.</div></div>
  <p style="display:none">Hidden paragraph</p>
  <p aria-hidden="true">Screen-reader hidden</p>
  <ul><li>Arabica</li><li>Robusta</li></ul>
  <table><tr><th>Country</th><th>Share</th></tr><tr><td>Brazil</td><td>31%</td></tr></table>
  <script>var notText = 1;</script>
  <p class="far" style="margin-top:3000px">Below the fold, still read.</p>
</main>
<footer>Contact: coffee@example.com</footer>
<iframe srcdoc="<p>Inside a frame</p>" width="200" height="60"></iframe>
</body></html>`;

let browser, page, blocks;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(FIXTURE);
  await page.waitForTimeout(200);
  blocks = await readBlocks(page);
});
after(() => browser.close());

test("blocks cover the whole page, skip hidden text, and keep headings, lists, rows and regions", () => {
  const text = toText(blocks);
  assert.match(text, /^# Coffee guide$/m);
  assert.match(text, /^## Growing/m, "an inline <h2> inside a div is still a heading");
  assert.match(text, /Coffee grows in over 70 countries, mostly near the equator\./, "nested divs read as one block");
  assert.match(text, /^- Arabica$/m);
  assert.match(text, /^\| Brazil \| 31% \|$/m);
  assert.match(text, /Below the fold, still read\./);
  assert.doesNotMatch(text, /Hidden paragraph|Screen-reader hidden|notText/);
  assert.equal(blocks.find(b => b.text.startsWith("Home")).region, "nav");
  assert.equal(blocks.find(b => b.text.startsWith("Contact")).region, "footer");
  assert.equal(blocks.find(b => b.text === "Inside a frame").region, "frame");
  assert.doesNotMatch(toText(blocks, { regions: ["main"] }), /Home|Contact/);
});

test("passages break at headings and carry their heading", () => {
  const ps = passages(blocks);
  const grow = ps.find(p => p.text.includes("70 countries"));
  assert.equal(grow.heading, "Growing [edit]");
  assert.ok(ps.every(p => !/^#/.test(p.text)));
  const long = passages([{ kind: "h2", text: "A" }, ...Array.from({ length: 20 }, () => ({ kind: "p", region: "main", text: "x".repeat(100) }))], { size: 300 });
  assert.ok(long.length >= 6 && long.every(p => p.text.length <= 400));
});

test("batches respect the option and size limits", () => {
  const list = Array.from({ length: 500 }, (_, i) => ({ i, heading: "", text: "y".repeat(100) }));
  const b = batches(list, { maxOptions: 240, maxChars: 30_000 });
  assert.ok(b.every(g => g.length <= 240));
  assert.ok(b.every(g => g.reduce((n, p) => n + p.text.length + 40, 0) <= 30_000));
  assert.equal(b.flat().length, 500);
});

test("findPassages ranks across batches and reports when nothing answers", async () => {
  const list = Array.from({ length: 300 }, (_, i) => ({ i, heading: "", text: `passage ${i}` }));
  const call = async (state) => {
    const ids = state.passages.map(p => String(p.i));
    const probabilities = Object.fromEntries([...ids, "none"].map(k => [k, 0]));
    if (ids.includes("250")) { probabilities["250"] = 0.8; probabilities["251"] = 0.15; probabilities.none = 0.05; } else probabilities.none = 1;
    return { answers: { best: { probabilities } } };
  };
  const r = await findPassages("q", list, call);
  assert.equal(r.requests, 2);
  assert.deepEqual(r.passages.map(p => p.i), [250, 251]);
  assert.equal(r.answered, 0.95);
  const none = await findPassages("q", list, async s => ({ answers: { best: { probabilities: Object.fromEntries([...s.passages.map(p => [String(p.i), 0]), ["none", 1]]) } } }));
  assert.equal(none.answered, 0);
  assert.deepEqual(none.passages, []);
});

test("JevBrowser.read pages through the text and answers a question with passages", async () => {
  const { JevBrowser } = await import("../src/session.mjs");
  const b = await JevBrowser.launch({ browser });   // shares the one Chromium
  await b.page.setContent(FIXTURE, { waitUntil: "load" });
  const all = await b.read({ maxChars: 60 });
  assert.equal(all.offset, 0);
  assert.ok(all.text.length <= 60 && all.next_offset > 0);
  assert.doesNotMatch(all.text, /Home|Contact/, "navigation and footer are left out by default");
  let text = all.text, at = all.next_offset;
  while (at != null) { const r = await b.read({ offset: at, maxChars: 60 }); text += "\n" + r.text; at = r.next_offset; }
  assert.equal(text, (await b.read({ maxChars: 100_000 })).text, "pages join back into the whole text");
  assert.match((await b.read({ allRegions: true })).text, /Contact: coffee@example.com/);

  b.call = async state => {
    const hit = state.passages.find(p => p.text.includes("31%"));
    const probabilities = Object.fromEntries([...state.passages.map(p => [String(p.i), p === hit ? 0.9 : 0]), ["none", 0.1]]);
    return { answers: { best: { probabilities } } };
  };
  const r = await b.read({ question: "Which country grows the most?" });
  assert.equal(r.passages.length, 1);
  assert.match(r.passages[0].text, /Brazil \| 31%/);
  assert.equal(r.answered, 0.9);
  await b.close();
});
