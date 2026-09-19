// Offline tests: secrets stay out of Jev's view, out of results, and are resolved only when typed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { JevBrowser } from "../src/session.mjs";
import { formatPage } from "../src/page-model.mjs";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(() => browser.close());

test("what is typed into a password field never comes back from the page, only that it is filled", async () => {
  const b = await JevBrowser.launch({ browser });   // shares the one Chromium
  await b.page.setContent(`<label>Email <input id=e name=email></label><label>Password <input id=p type=password name=pw></label>
    <label>One-time code <input id=o autocomplete=one-time-code></label><label>Shipping <input id=s name=shipping_pin_code></label>`);
  await b.page.fill("#e", "a@b.com"); await b.page.fill("#p", "hunter22"); await b.page.fill("#o", "123456"); await b.page.fill("#s", "11511");
  const snap = await b.snapshot();
  const text = JSON.stringify(snap) + formatPage(snap);
  assert.doesNotMatch(text, /hunter22|123456/);
  assert.equal(snap.elements.find(e => e.label === "Password").filled, true);
  assert.equal(snap.elements.find(e => e.label === "Email").value, "a@b.com");
  await b.close();
});
