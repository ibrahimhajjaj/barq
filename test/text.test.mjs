// Offline tests: text that is cut to size never leaves half an emoji behind, and a slow editor
// still ends up holding the whole value. No Jev calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Barq } from "../src/session.mjs";
import { requestBody } from "../src/jev.mjs";
import { clipMiddle } from "../src/page-model.mjs";

const whole = s => s.isWellFormed();

let browser, b;
before(async () => { browser = await chromium.launch(); b = await Barq.launch({ browser }); });
after(async () => { await b.close(); await browser?.close(); });

test("a request never carries half an emoji, and a whole one goes as it is", () => {
  const body = requestBody({ page: { text: "guard 💂🏿‍♀️", bio: "cut here \uD83D" } }, { q: { type: "noul", instructions: "?" } });
  assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(body), "no stray high half written out");
  const back = JSON.parse(body);
  assert.equal(back.state.page.text, "guard 💂🏿‍♀️");
  assert.ok(whole(back.state.page.bio));
});

test("clipping the middle out of text keeps every emoji whole", () => {
  const s = "😀".repeat(40);
  for (let n = 3; n < 60; n++) assert.ok(whole(clipMiddle(s, n)), `n=${n}`);
});

test("what the page is read as holds no half emoji, however a label is cut", async () => {
  await b.page.setContent(`<button>${"💂🏿‍♀️".repeat(30)}</button><a href="#">${"a😀".repeat(60)}</a>`);
  const page = await b.snapshot();   // as it stands now
  for (const e of page.elements) for (const v of [e.text, e.label]) if (v) assert.ok(whole(v), v);
  assert.ok(whole(page.text));
});

test("an editor too slow to type into key by key still ends up with the whole value", async () => {
  // every key costs the page 300 ms, so 30 of them outlast the time an action gets
  await b.page.setContent(`<textarea id=t></textarea><script>
    document.getElementById("t").addEventListener("keydown", () => { const until = Date.now() + 300; while (Date.now() < until); });
  </script>`);
  const value = "barq: one sentence per step!!";
  await b.typeInto(b.page.locator("#t"), { value }, { timeout: 4000 });
  assert.equal(await b.page.inputValue("#t"), value);
});
