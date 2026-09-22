// Offline tests: what the page script reads off a local fixture, and the page-model helpers that need no browser. No Jev calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { Barq, repeatsBlock, actionError, estimateTokens, fitState } from "../src/session.mjs";
import { pageDiff, formatPage, repeatedElements, optionSummary, clipMiddle, numbersIn, mayCount, kindsOf, countKind, phrasesFrom, likelyFor, plainGoal, goalMet } from "../src/page-model.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const FIXTURE = `<!doctype html><html><head><title>Seat booking</title>
<style>.faint{opacity:0;position:absolute} .gone{display:none} .tile{position:relative;width:320px;height:90px} .tile input{opacity:0;position:absolute;inset:0;width:320px;height:90px;margin:0} .tile label{position:relative;display:block;width:320px;height:90px} .tile .inner{height:100%} .offscreen{position:absolute;top:0;left:0;width:1px;height:1px;clip:rect(1px,1px,1px,1px);clip-path:inset(0 0 99.9% 99.9%);margin:0} .swatch{position:relative;padding:10px;list-style:none} .swatch label{display:block;width:42px;height:42px} th{cursor:default} .tappable{cursor:pointer} .below{margin-top:3000px}</style></head><body>
<h1>Book a seat</h1>
<label for="mail">Contact email</label><input id="mail" type="email" placeholder="name@example.com">
<label>Passcode <input type="password" name="code"></label>
<span id="where">Find a city</span><input aria-labelledby="where">
<div id="extras"><input type="checkbox"> window seat<br><input type="checkbox" checked> extra legroom</div>
<table class="bags"><tbody><tr class="done"><td><input class="faint" type="checkbox" aria-label="Toggle bag"></td><td>cabin bag</td></tr></tbody></table>
<div class="tile"><input id="seat14" type="radio" name="seat"><label for="seat14"><div class="inner">row 14, aisle</div></label></div>
<ul class="swatches"><li class="swatch"><input id="navy" class="offscreen" type="radio" name="colour"><label for="navy"><span>Navy</span></label></li></ul>
<input type="file" class="gone" id="ticket">
<button disabled>Pay now</button><button aria-busy="true">Checking…</button>
<select name="bags"><option>No bags</option><option selected>One bag</option></select>
<table><thead><tr><th aria-sort="ascending">Airline</th><th>Price</th></tr></thead><tbody><tr><td>EgyptAir</td><td>320</td></tr></tbody></table>
<div class="tappable">Show details</div>
<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2740%27 height=%2740%27/%3E" width="40" height="40" alt="Airline logo">
<button class="gone">Never shown</button>
<div aria-hidden="true" style="position:relative"><button>Under the sheet</button><div style="position:absolute;inset:0;background:#0003"></div></div>
<seat-map></seat-map>
<iframe srcdoc="<input id='inner' placeholder='Seat number'>" width="300" height="80"></iframe>
<a href="/a">Remove</a><a href="/b">Remove</a>
<p class="below">Text far below the fold</p>
<script>customElements.define("seat-map", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<button>Open seat map</button>"; } });</script>
</body></html>`;

let browser, b, page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  b = await Barq.launch({ browser });
  await b.page.setContent(FIXTURE, { waitUntil: "load" });
  await b.page.waitForTimeout(300);   // the shadow root and the frame fill in after load
  page = await b.snapshot();
});
after(async () => { await b.close(); await browser?.close(); });

const find = test => page.elements.find(test);

test("a field's name is read from its label, however the page attaches one", () => {
  assert.equal(find(e => e.tag === "input:email").label, "Contact email");
  assert.equal(find(e => e.tag === "input:password").label, "Passcode");
  assert.equal(find(e => e.label === "Find a city")?.tag, "input:text");
  const boxes = page.elements.filter(e => e.tag === "input:checkbox" && /seat|legroom/.test(e.label ?? ""));
  assert.deepEqual(boxes.map(e => [e.label, e.checked]), [["window seat", false], ["extra legroom", true]]);
});

test("an invisible checkbox behind a styled one is listed, with the row it belongs to", () => {
  const t = find(e => e.label === "Toggle bag");
  assert.ok(t, "a checkbox at opacity:0 is still a checkbox");
  assert.equal(t.row_state, "done");
  assert.match(t.near, /cabin bag/);
});

test("a file input hidden behind a styled button is listed, marked hidden", () => {
  assert.equal(find(e => e.tag === "input:file")?.hidden, true, "a file input behind a styled button is marked hidden");
});

test("what a control says about itself: disabled, busy, chosen option, sort order", () => {
  assert.equal(find(e => e.text === "Pay now").disabled, true);
  assert.equal(find(e => e.text === "Checking…").busy, true);
  const s = find(e => e.tag === "select");   // the bags dropdown
  assert.equal(s.value, "One bag"); assert.deepEqual(s.options, ["No bags", "One bag"]);
  assert.equal(find(e => e.tag === "th" && e.text === "Airline").sorted, "ascending");
});

test("clickable divs, images, shadow roots and frames all reach the list", () => {
  assert.ok(find(e => e.text === "Show details"), "cursor:pointer div");
  assert.ok(find(e => e.tag === "img" && e.text === "Airline logo"), "image");
  assert.ok(find(e => e.text === "Open seat map"), "shadow DOM");
  const inner = find(e => e.placeholder === "Seat number");
  assert.ok(inner?.frame, "an element inside a frame says which frame it is in");
});

test("a toggle that is off says so, and a field holding an essay says how much is in it", async () => {
  const b2 = await Barq.launch({ browser });
  const essay = "Write a program that generates music in the browser.".repeat(60);
  await b2.page.setContent(`
    <button aria-pressed="true">Deep research</button>
    <button aria-pressed="false">Canvas</button>
    <div contenteditable="true" role="textbox" aria-label="Enter a prompt here">${essay}</div>`);
  const pg = await b2.snapshot();   // listed fresh

  const on = pg.elements.find(e => e.text === "Deep research"), off = pg.elements.find(e => e.text === "Canvas");
  assert.equal(on.active, true);
  // the point: left out, "off" and "this control has no such state" read the same to the model
  assert.equal(off.active, false, "an explicit aria-pressed=false has to come through as off");

  const box = pg.elements.find(e => e.label === "Enter a prompt here");
  assert.ok(box.value.length > 60 && box.value.length <= 120, `value was ${box.value.length} chars`);
  assert.equal(box.value_chars, essay.length, "a cut-off value says how long the whole thing is");
  await b2.close();
});

test("a question about two things is split into two, and a phrase with 'and' in it is left alone", () => {
  const split = q => Barq.prototype.splitQuestion.call(null, q);
  assert.deepEqual(split("Is the toggle on, and does the box hold a long prompt about music?"),
    ["Is the toggle on?", "Does the box hold a long prompt about music?"]);
  assert.deepEqual(split("Is the cart empty and is the total zero?"),
    ["Is the cart empty?", "Is the total zero?"]);
  // one thing asked about, whatever words it uses
  assert.equal(split("Does the cart show one blue mug?"), null);
  assert.equal(split("Does the page show terms and conditions?"), null);
  assert.equal(split("Is the photo in black and white?"), null);
  // a fragment too short to stand as its own question is not a second question
  assert.equal(split("Is it done and is it?"), null);
});

test("a goal's own words are offered as things to type, minus the instruction verbs", () => {
  assert.deepEqual(phrasesFrom("Search for \"blue ceramic mug\" and open the first result")[0], "blue ceramic mug");
  const godel = phrasesFrom("Open the Wikipedia article about Gödel's incompleteness theorems.");
  assert.equal(godel[0], "Gödel's incompleteness theorems", JSON.stringify(godel));
  assert.ok(!godel.includes("Open"), "a verb is not a search term");
  assert.deepEqual(phrasesFrom(""), []);
});

test("a page a little over the question's cap is trimmed to what the goal is about, in page order", () => {
  const els = Array.from({ length: 300 }, (_, i) => ({ i, tag: "a", text: `Article ${i}` }));
  els[250] = { i: 250, tag: "input:search", label: "Search Wikipedia" };
  const kept = likelyFor(els, "Search Wikipedia for incompleteness theorems", 240);
  assert.equal(kept.length, 240);
  assert.ok(kept.some(e => e.label === "Search Wikipedia"), "the field the goal names survives the trim");
  assert.deepEqual(kept.map(e => e.i), [...kept.map(e => e.i)].sort((a, b) => a - b), "and the order still runs down the page");
  const small = els.slice(0, 10);
  assert.equal(likelyFor(small, "anything", 240), small, "a page under the cap is handed back untouched");
});

test("a goal that says plainly what it wants is checked against the page, and anything else is not", () => {
  // what the caller passed in has to show up, all of it
  const filling = plainGoal("Fill in the form", { first: "Ada", last: "Lovelace" });
  assert.equal(goalMet(filling, { elements: [{ tag: "input:text", value: "Ada" }] }), null, "one field of two is not filled in");
  assert.equal(goalMet(filling, { elements: [{ tag: "input:text", value: "Ada" }, { tag: "input:text", value: "Lovelace" }] }), true);

  // a goal with a second thing to do after the typing is not finished by the typing
  assert.equal(plainGoal("Fill in the checkout information and continue", { name: "Ada" }), null);
  assert.equal(plainGoal("Add the two todos, then clear the completed ones", {}), null);

  // a secret cannot be read back off the page, so that one is still asked about
  assert.equal(plainGoal("Type the password", { password: "env:PW" }), null);

  // a choice shows in the control, a tick shows in the box, an address shows in the url
  assert.equal(goalMet(plainGoal("Choose Two in the dropdown", {}), { elements: [{ tag: "select", options: ["One", "Two"], value: "Two" }] }), true);
  assert.equal(goalMet(plainGoal("Tick the Remember box", {}), { elements: [{ tag: "input:checkbox", checked: true, label: "Stickers" }] }), null, "a word has to be a word, not part of one");
  // opening something means the address moved to it: the site's own name in the address it started
  // on proves nothing, which is how a goal like "open the Wikipedia article about X" was once
  // satisfied by the word Wikipedia in en.wikipedia.org before anything had happened
  const opening = plainGoal("Open the Wikipedia article about incompleteness theorems", {});
  const onTheArticle = { url: "https://en.wikipedia.org/wiki/Incompleteness_theorems", title: "", elements: [] };
  const stillHome = { url: "https://en.wikipedia.org/wiki/Main_Page", title: "Wikipedia", elements: [] };
  const moved = { url: "https://en.wikipedia.org/wiki/Main_Page -> https://en.wikipedia.org/wiki/Incompleteness_theorems" };
  assert.equal(goalMet(opening, onTheArticle, moved), true);
  assert.equal(goalMet(opening, onTheArticle, null), null, "no move, no proof");
  assert.equal(goalMet(opening, stillHome, moved), null, "the site's own name is not the thing asked for");

  // something made is something the page did not hold before: the words sitting in the box they
  // were typed into are not a new row
  const adding = plainGoal("Add a todo item", { todo: "buy milk" });
  assert.equal(adding.kind, "create");
  assert.equal(goalMet(adding, { elements: [{ tag: "input:text", value: "buy milk" }] }, { added: [], new_text: "" }), null);
  assert.equal(goalMet(adding, { elements: [] }, { added: ['input:checkbox "Toggle" near "buy milk"'], new_text: "buy milk" }), true);
  assert.equal(goalMet(adding, { elements: [] }, null), null, "with nothing to compare against, nothing is proved");

  // a goal that counts keeps the counting path, which counts in code already
  assert.equal(plainGoal("Add elements until there are exactly 3 Delete buttons", {}), null);

  // and a goal nobody could check this way says so rather than guessing
  assert.equal(plainGoal("Make the table sorted by last name", {}), null);
});

test("a dropdown option the goal names outright is chosen without reading the list", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(`<select><option>All stays</option><option>Design</option><option>Nature</option></select>`);
  const [{ i }] = (await b2.snapshot()).elements;
  b2.decide = async () => ({ ...clickAnswers(i), tool: { choice: "select", probabilities: { select: 0.9 } } });
  b2.call = async () => assert.fail("the list was read out although the goal named the option");
  const r = await b2.do("Choose Design in the category dropdown", { maxActions: 1 });
  assert.equal(await b2.page.locator("select").inputValue(), "Design", r.status);
  await b2.close();
});

test("going somewhere else drops the element numbers that belonged to the page left behind", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.open("data:text/html,<title>one</title><button>Save</button><button>Remove</button>");
  await b2.snapshotText();
  assert.ok(b2.shown, "the page was listed");
  await b2.open("data:text/html,<title>two</title><button>Other</button>");
  assert.equal(b2.shown, null, "and the listing went with the page");
  await b2.close();
});

test("a tab barq has not been sent anywhere says so", async () => {
  const b2 = await Barq.launch({ browser });
  assert.equal(b2.onBlankTab(), true, "a fresh tab is blank until it is sent somewhere");
  // setContent leaves the address alone, so only going somewhere counts as being sent
  await b2.page.setContent("<button>Book a seat</button>");
  assert.equal(b2.onBlankTab(), true, "filled in place, still nowhere");
  await b2.open("data:text/html,<title>seats</title><button>Book a seat</button>");
  assert.equal(b2.onBlankTab(), false);
  await b2.close();
});

test("a frame the page keeps out of sight contributes nothing, however it is hidden", async () => {
  const b2 = await Barq.launch({ browser });
  // the shapes a site uses to park a menu it has closed: display:none, off to the side, clipped by
  // an ancestor, and visibility:hidden. Each frame lays out normally in its own document.
  await b2.page.setContent(`
    <button>Book a seat</button>
    <iframe style="display:none" srcdoc="<button>apps menu</button>"></iframe>
    <iframe style="position:absolute;left:-9999px;width:300px;height:200px" srcdoc="<button>parked menu</button>"></iframe>
    <div style="height:0;overflow:hidden"><iframe style="width:300px;height:200px" srcdoc="<button>clipped menu</button>"></iframe></div>
    <iframe style="visibility:hidden;width:300px;height:200px" srcdoc="<button>invisible menu</button>"></iframe>
    <iframe style="width:300px;height:100px" srcdoc="<button>seat picker</button>"></iframe>`);
  await b2.page.waitForTimeout(300);

  const pg = await b2.snapshot();   // listed fresh
  assert.deepEqual(pg.elements.map(e => e.text), ["Book a seat", "seat picker"], JSON.stringify(pg.elements.map(e => e.text)));
  await b2.close();
});

test("what nobody can see or click is left out", () => {
  assert.equal(find(e => e.text === "Never shown"), undefined);
  assert.equal(find(e => e.text === "Under the sheet"), undefined);
});

test("a dialog inside content the site marked aria-hidden is still listed; what it covers is not", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(`<form aria-hidden="true"><input placeholder="Student number">
    <div style="position:fixed;inset:0;background:#0006"></div>
    <div role="dialog" style="position:fixed;top:40px;left:40px;background:#fff;padding:20px"><p>Announcements</p><button title="Close">x</button></div></form>`);
  const els = (await b2.snapshot()).elements;
  assert.ok(els.some(e => e.tag === "button"), "the dialog's close button");
  assert.ok(!els.some(e => e.placeholder === "Student number"), "the field under the overlay");
  await b2.close();
});

test("settle doesn't wait on a page whose main thread is stuck", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent("<p>busy</p>");
  await b2.page.evaluate(() => setTimeout(() => { const t = Date.now(); while (Date.now() - t < 5000); }, 50));
  await new Promise(r => setTimeout(r, 100));
  const ms = await b2.settle();
  assert.ok(ms < 3500, `settled after ${ms} ms`);
  await b2.close();
});

test("requests are sized in tokens: Arabic pages are cut to fit, and a refusal is retried smaller", async () => {
  const ar = "غزة ".repeat(100), en = "abcd".repeat(100);
  assert.ok(estimateTokens(ar) > 2 * estimateTokens(en), "Arabic costs more per character");
  const page = { url: "u", title: "t", text: "نص ".repeat(4000), elements: Array.from({ length: 368 }, (_, i) => ({ i, tag: "a", text: "رابط إلى مقالة ".repeat(6) })) };
  const yesNo = { complete: { type: "noul", instructions: "Is everything done?" } };
  const fitted = fitState({ page }, yesNo);
  assert.ok(estimateTokens(JSON.stringify(fitted)) <= 26_000);
  assert.ok((fitted.page.elements?.length ?? 0) < 368, "a yes/no question doesn't need every element");
  const pick = { target: { type: "choice", instructions: "Which entry of `page.elements` should be clicked?", criteria: {} } };
  assert.equal(fitState({ page: { ...page, elements: page.elements.slice(0, 20) } }, pick).page.elements.length, 20, "elements a question picks from stay");

  const b2 = await Barq.launch({ browser });
  const sizes = [];
  b2.request = async state => {
    const n = JSON.stringify(state).length; sizes.push(n);
    if (n > 20_000) throw new Error('Jev 400: {"detail":{"error_type":"max_tokens_exceeded"}}');
    return { answers: { complete: { noul: 0.9 } }, ms: 1, tokens: 1, model: "stub" };
  };
  const r = await b2.call({ page }, yesNo);
  assert.equal(r.answers.complete.noul, 0.9);
  assert.equal(sizes.length, 2, "refused once, then answered");
  await b2.close();
});

test("the text is what's on screen; the measurements describe the whole page", () => {
  assert.match(page.text, /Book a seat/);
  assert.doesNotMatch(page.text, /far below the fold/);
  assert.ok(page.metrics.page_height > 3000, "the text far below the fold makes the page tall");
  assert.equal(page.elements.length, page.metrics.elements);
});

test("look-alikes are counted rather than listed one by one", () => {
  assert.equal(page.repeated_elements['a "Remove"'], 2);
  assert.equal(repeatedElements([{ tag: "a", text: "x" }]), undefined, "one of a kind is not a repeat");
});

test("every listed element can be found again and acted on, frames included", async () => {
  const inner = find(e => e.placeholder === "Seat number");
  await b.act({ tool: "type", target: inner.i, value: "14C" });
  assert.equal(await b.locate(inner.i).inputValue(), "14C");
  const box = find(e => e.label === "window seat");
  await b.act({ target: box.i, tool: "click" });
  assert.ok(await b.locate(box.i).isChecked());
});

test("the diff names what appeared, what went, and whether the page moved", () => {
  const cart = { url: "/cart", text: "one seat held", metrics: { elements: 1 }, elements: [{ i: 0, tag: "button", text: "Hold" }] };
  const paid = { url: "/pay", text: "one seat held and paid", metrics: { elements: 2 }, elements: [{ i: 0, tag: "button", text: "Hold" }, { i: 1, tag: "button", text: "Refund" }] };
  const d = pageDiff(cart, paid);
  assert.deepEqual(d.added, ['button "Refund"']);
  assert.equal(d.removed, undefined, "nothing went");
  assert.equal(d.url, "/cart -> /pay");
  assert.equal(d.metrics.elements, "1 -> 2", "the count is given as before -> after");
  assert.equal(d.new_text, "and paid");
  assert.equal(pageDiff(null, paid), undefined, "nothing to compare against on the first page");
});

test("the diff pairs look-alikes, catches value and tick changes, ignores text that merely shifted", () => {
  // a packing list: a field to add an item, a "take everything" box, and one box per item
  const field = value => ({ i: 1, tag: "input:text", placeholder: "Add an item", near: "packing", ...(value ? { value } : {}) });
  const item = (near, checked = false) => ({ i: 3, tag: "input:checkbox", label: "Pack item", near, checked });
  const takeAll = near => ({ i: 2, tag: "input:checkbox", label: "Take everything", near, checked: false });
  const before = { url: "u", text: "packing passport 1 item left", elements: [field("charger"), takeAll("passport"), item("passport")] };
  const after = { url: "u", text: "packing passport charger 2 items left", elements: [field(), takeAll("passport charger"), item("passport"), item("charger")] };
  const d = pageDiff(before, after);
  assert.deepEqual(d.added, ['input:checkbox "Pack item" near "charger" checked=false']);
  assert.deepEqual(d.changed, ['input:text "Add an item" near "packing": value="charger" -> (empty)']);
  assert.equal(d.removed, undefined, "the field was emptied, not replaced");
  assert.equal(d.new_text, "charger 2 items");
  // one box now ticked, and the pairing has to hold across the look-alikes
  const ticked = { ...after, elements: [field(), takeAll("x"), item("passport", true), item("charger")] };
  assert.deepEqual(pageDiff(after, ticked).changed, ['input:checkbox "Pack item" near "passport": checked=false -> checked=true']);
});

test("the diff says so when the same elements only changed places", () => {
  const rows = ["Cairo", "Doha", "Tunis"].map((text, i) => ({ i, tag: "div", text }));
  const listed = { url: "u", text: "", elements: rows };
  const sorted = { url: "u", text: "", elements: [rows[1], rows[0], rows[2]] };
  assert.deepEqual(pageDiff(listed, sorted).reordered, { before: ['div "Cairo"', 'div "Doha"'], after: ['div "Doha"', 'div "Cairo"'] });
  assert.equal(pageDiff(listed, listed).reordered, undefined, "a page compared with itself moved nothing");
});

test("the page reads back as one line per element", () => {
  const txt = formatPage(page);
  assert.match(txt, /^url: /);
  assert.match(txt, /\[\d+\] input:email label="Contact email"/);
});

test("an action, its target and its value are settled together or not at all", () => {
  const form = { elements: [{ i: 0, tag: "button", text: "Send" }, { i: 1, tag: "input:text", label: "Full name" }, { i: 2, tag: "input:file" }] };
  const said = (tool, target) => ({ tool: { choice: tool, probabilities: { [tool]: 0.9 } }, target: { probabilities: target }, value: { choice: "name" } });
  // typing into a button is impossible, so the likeliest text field takes it instead
  let r = b.resolve(form, said("type", { 0: 0.7, 1: 0.3, 2: 0 }), { name: "Ada" });
  assert.deepEqual([r.tool, r.target, r.value], ["type", 1, "Ada"]);
  // the caller gave nothing to type, so the round is marked for the goal to be asked for the text;
  // only if the goal holds nothing usable does it fall back to clicking the field
  r = b.resolve(form, said("type", { 1: 0.9, 0: 0.1 }), {});
  assert.equal(r.tool, "type");
  assert.equal(r.typeNeedsText, true);
  assert.equal(r.value, undefined);
  // an upload can only go to the file input, whatever was picked
  r = b.resolve(form, said("upload", { 0: 0.95, 1: 0.05 }), { name: "/tmp/f" });
  assert.equal(r.target, 2);
});

test("a repeating run of actions is recognised as going nowhere", () => {
  // click, type, click, type, click, type: the same pair three times over
  assert.equal(repeatsBlock(["c", "t", "c", "t", "c", "t"], 2, 3), true);
  assert.equal(repeatsBlock(["s", "c", "t", "c", "t"], 2, 3), false, "only two of the three pairs are in place");
  assert.equal(repeatsBlock(["s", "s", "s"], 1, 5), false, "three of a kind is not yet five");
  assert.equal(repeatsBlock(["s", "s", "s", "s", "s"], 1, 5), true);
  assert.equal(repeatsBlock(["s", "s", "s", "s", "s", "s"], 2, 3), false, "the pairs overlap, so no block repeats cleanly");
});

test("something on top marks what it covers, and a modal without a role is still a dialog", async () => {
  const b2 = await Barq.launch({ browser });
  // a newsletter box thrown over the page: a dimmed sheet, no role="dialog" anywhere
  await b2.page.setContent(`<button id="under">Browse offers</button><p>lots of page</p>
    <div style="position:fixed; inset:0; z-index:50; display:grid; place-items:center">
      <div style="position:absolute; inset:0; background:rgba(0,0,0,.4)"></div>
      <div style="position:relative;background:#fff;padding:40px">Get our weekly deals <button>Subscribe</button></div>
    </div>`);
  const pg = await b2.snapshot();   // listed fresh
  assert.equal(pg.elements.find(e => e.text === "Browse offers").covered, true);
  assert.equal(pg.elements.find(e => e.text === "Subscribe").covered, undefined, "the box's own button is on top, not under it");
  assert.ok(pg.dialogs?.some(d => /Get our weekly deals/.test(d)), JSON.stringify(pg.dialogs));
  const err = await b2.act({ tool: "click", target: pg.elements.find(e => e.text === "Browse offers").i }).then(() => null, actionError);
  assert.match(err, /^click blocked: another element \(a modal, overlay or banner\) covers the target$/);
  await b2.close();
});

test("an input under its own label is clickable, not covered by it", async () => {
  const r = find(e => e.label === "row 14, aisle" && e.tag === "input:radio");
  assert.ok(r, "the real radio under the styled one is listed");
  assert.equal(r.covered, undefined, "a control's own label is not something covering it");
  await b.act({ target: r.i, tool: "click" });
  assert.equal(await b.page.locator("#seat14").isChecked(), true, "clicking the label selects the real radio");
});

test("a one-pixel-clipped input whose swatch sits on top is still clickable", async () => {
  const r = find(e => e.label === "Navy" && e.tag === "input:radio");
  assert.ok(r, "the clipped radio is listed");
  assert.equal(r.covered, undefined, "being clipped out of sight is not being covered");
  await b.act({ target: r.i, tool: "click" });
  assert.equal(await b.page.locator("#navy").isChecked(), true, "clicking the label selects the real radio");
});

test("an ordinary page reports no phantom overlays or dialogs", () => {
  assert.deepEqual(page.elements.filter(e => e.covered).map(e => e.text ?? e.label), [], "nothing is covered once the banner is gone");
  assert.equal(page.dialogs, undefined, "no dialog is left open");
});

// Jev's answers for a round that clicks element `target` and finds nothing finished yet.
const clickAnswers = (target) => ({
  tool: { choice: "click", probabilities: { click: 0.9 } },
  target: { probabilities: { [target]: 0.95 } },
  irreversible: { noul: 0.1 },
  stages: 1,
  // nothing reached yet, nothing in the way
  ...Object.fromEntries(["done", "done_change", "blocked", "error", "login"].map(q => [q, { noul: 0 }])),
});

// Stands in for Jev on a counting goal: it keeps clicking "Add" and calls the goal done too early,
// at 2, the way a single look at the page does.
function countingJev(b, { counts = 0.95, cmp = "exactly" } = {}) {
  const asked = [];
  b.call = async (state, questions) => {   // stands in for Jev
    asked.push(Object.keys(questions).join(","));
    const answers = {};
    for (const name of Object.keys(questions)) { const q = questions[name];
      if (name === "counts") answers.counts = { noul: counts };
      else if (name === "cmp") answers.cmp = { choice: cmp, probabilities: { [cmp]: 0.9 } };
      else if (name === "relative") answers.relative = { choice: "total", probabilities: { total: 0.9 } };
      else if (name === "kind") { const k = Object.keys(q.criteria).find(k => k.includes('"Delete"')) ?? "none"; answers.kind = { choice: k, probabilities: { [k]: 0.9 } }; }
      else if (q.type === "noul") answers[name] = { noul: 0.5 };
    }
    return { answers };
  };
  b.decide = async (page, goal, values, history, change, count) => {
    const deletes = page.elements.filter(e => e.text === "Delete").length;
    const add = page.elements.find(e => e.text === "Add").i;
    return { ...clickAnswers(add), done: { noul: deletes >= 2 ? 0.9 : 0 }, done_change: { noul: deletes >= 2 ? 0.9 : 0 }, count };
  };
  return asked;
}
const ADDER = `<button onclick="const d = document.createElement('button'); d.textContent = 'Delete'; document.body.append(d)">Add</button>`;

test("numbers in goals: counts are told apart from names", () => {
  assert.deepEqual(numbersIn("Add elements until there are exactly 3 Delete buttons"), [3]);
  assert.deepEqual(numbersIn("Pick the 15th, then add two more"), [2]);
  for (const g of ["Add elements until there are exactly 3 Delete buttons", "Add two todos", "Load at least 5 more results"]) assert.ok(mayCount(g), g);
  for (const g of ["Select Option 240", "Choose Two", "Enter the number 42", "Make checkbox 1 checked"]) assert.ok(!mayCount(g), g);
  assert.deepEqual([...kindsOf([{ tag: "button", text: "Delete" }, { tag: "button", text: "Delete" }, { tag: "button", text: "Add" }])], [['button "Delete"', 2], ['button "Add"', 1]]);
});

test("a counting goal is done when the count says so, not when Jev thinks so", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(ADDER);
  countingJev(b2);
  const r = await b2.do("Add elements until there are exactly 3 Delete buttons");
  assert.equal(r.status, "done", r.info);
  assert.equal(await b2.page.locator("text=Delete").count(), 3, "not 2, where Jev called it done");
  assert.match(r.info, /counted 3/);
  await b2.close();
});

test("names that start with the same words are also one kind", () => {
  const people = ["Alice", "Bob", "Carol", "Dan", "Eve"].map(n => ({ tag: "button", text: `Delete ${n}` }));
  const kinds = kindsOf([...people, { tag: "button", text: "Add user" }, { tag: "a", text: "Delete account" }]);
  assert.equal(kinds.get('button "Delete …"'), 5);
  assert.equal(kinds.get('button "Delete Alice"'), 1);
  assert.equal(kinds.get('a "Delete …"'), undefined, "one name is no collection");
  assert.equal([...kinds.keys()][0], 'button "Delete …"');
  // the same names sharing more words give one kind, not one per word
  const users = ["Alice", "Bob"].map(n => ({ tag: "button", text: `Remove user ${n}` }));
  assert.deepEqual([...kindsOf(users).keys()].filter(k => k.includes("…")), ['button "Remove user …"']);
  // counted by the same rule when only one is left and the kind is no longer offered
  assert.equal(countKind(people.slice(4), 'button "Delete …"'), 1);
  assert.equal(countKind(people, 'button "Delete Bob"'), 1);
});

test("a list whose buttons name their rows is counted as one collection", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(`<ul>${["Alice", "Bob", "Carol", "Dan", "Eve"].map(n => `<li>${n} <button onclick="this.parentElement.remove()">Delete ${n}</button></li>`).join("")}</ul>`);
  b2.call = async (state, questions) => {
    const answers = {};
    for (const name of Object.keys(questions)) { const q = questions[name];
      if (name === "counts") answers.counts = { noul: 0.95 };
      else if (name === "cmp") answers.cmp = { choice: "at most", probabilities: { "at most": 0.9 } };
      else if (name === "relative") answers.relative = { choice: "total", probabilities: { total: 0.9 } };
      else if (name === "kind") {
        // the collection when one is offered, else a row's own button
        const keys = Object.keys(q.criteria), k = keys.find(k => k.endsWith(' …"')) ?? keys.find(k => k.includes('"Delete')) ?? "none";
        answers.kind = { choice: k, probabilities: { [k]: 0.9 } };
      } else if (q.type === "noul") answers[name] = { noul: 0.9 };
    }
    return { answers };
  };
  // Jev thinks it's done on every page, and would delete the next user
  b2.decide = async page => ({ ...clickAnswers(page.elements.find(e => e.text?.startsWith("Delete")).i), done: { noul: 0.9 }, done_change: { noul: 0.9 } });
  const r = await b2.do("Delete users until at most 2 remain", { allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  assert.equal(await b2.page.locator("li").count(), 2);
  assert.match(r.info, /counted 2 × button "Delete …"/);
  await b2.close();
});

test("a goal whose number isn't a count is left to Jev, and a goal without a number asks nothing more", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(ADDER);
  let asked = countingJev(b2, { counts: 0.1 });
  const r = await b2.do("Add 3 as the quantity");
  assert.equal(r.status, "done", r.info);
  assert.equal(await b2.page.locator("text=Delete").count(), 2, "Jev's done stands");
  await b2.page.setContent(ADDER);
  asked = countingJev(b2);
  await b2.do("Add some elements");
  assert.ok(!asked.some(q => q.includes("counts")), "no counting question without a number");
  await b2.close();
});

test("a confirm box is dismissed unless the caller asked to accept it", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(`<button onclick="document.body.dataset.c = confirm('Cancel this booking?')">Booking options</button>
    <button onclick="alert('Seat held'); document.body.dataset.a = 'shown'">Hold seat</button>`);
  const snap = await b2.snapshotText();   // as the caller reads it
  const cancel = +snap.match(/\[(\d+)\] button "Booking options"/)[1], hold = +snap.match(/\[(\d+)\] button "Hold seat"/)[1];
  let r = await b2.actOn({ action: "click", element: cancel });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.c), "false", "the booking survives an unasked-for confirm");
  assert.match(r.events.join(), /confirm dialog "Cancel this booking\?" dismissed/);
  r = await b2.actOn({ action: "click", element: hold });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.a), "shown", "the alert was answered and the page went on");
  assert.match(r.events.join(), /alert dialog "Seat held" accepted/);
  await b2.actOn({ action: "click", element: cancel, acceptDialog: true });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.c), "true", "accepted when asked to");
  await b2.close();
});

test("a confirm box that Jev reads as costly comes back to the caller, and an unreachable Jev never accepts one", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(`<button onclick="document.body.dataset.c = confirm('Erase 3 backups for good?')">Free up space</button>`);
  const [{ i }] = (await b2.snapshot()).elements;
  b2.decide = async () => clickAnswers(i);   // always the same button
  b2.call = async () => ({ answers: { q: { noul: 0.9 } } });   // "hard to undo"
  let r = await b2.do("Free up space on the drive");
  assert.equal(r.status, "needs_confirmation", r.info);
  assert.equal(r.pending.dialog, "Erase 3 backups for good?");
  assert.equal(await b2.page.evaluate(() => document.body.dataset.c), "false", "turned down");
  // with Jev out of reach, a confirm is turned down, never accepted
  b2.call = async () => { throw new Error("Jev 503: unavailable"); };
  r = await b2.do("Free up space on the drive");
  assert.equal(r.status, "needs_confirmation", r.info);
  // benign confirm is accepted
  b2.call = async () => ({ answers: { q: { noul: 0.1 } } });   // "easy to undo"
  await b2.do("Free up space on the drive", { maxActions: 1 });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.c), "true", "accepted when asked to");
  await b2.close();
});

test("working through several controls is not mistaken for going round in circles", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(["Mon", "Tue", "Wed", "Thu"].map(d => `<button>${d}</button>`).join(""));
  const ids = (await b2.snapshot()).elements.map(({ i }) => i);
  let n = 0;
  // a different target every round on a page that never changes: not a loop, so it runs out of actions
  b2.decide = async () => clickAnswers(ids[n++ % ids.length]);   // the next day each round
  const r = await b2.do("Open every day", { maxActions: 4 });
  assert.equal(r.status, "max_actions", `${r.info}`);
  await b2.close();
});

test("an element number keeps meaning the element the caller saw, and is refused once it is gone", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(`<button onclick="document.body.dataset.hit = 'apply'">Apply</button><button id="later">Save for later</button>`);
  const snap = await b2.snapshotText();   // as the caller reads it
  const apply = +snap.match(/\[(\d+)\] button "Apply"/)[1], later = +snap.match(/\[(\d+)\] button "Save for later"/)[1];
  // a banner arrives above everything, which shifts every number down by one
  await b2.page.evaluate(() => { const banner = document.createElement("button"); banner.textContent = "Dismiss"; banner.onclick = () => document.body.dataset.hit = "dismiss"; document.body.prepend(banner); });
  await b2.snapshot();   // check() and choose() renumber the page the same way
  await b2.actOn({ action: "click", element: apply });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.hit), "apply", "the old number still means the button the caller saw");
  await b2.page.evaluate(() => document.getElementById("later").remove());
  await assert.rejects(b2.actOn({ action: "click", element: later }), /no longer on the page/);
  await b2.close();
});

test("do() stops at its deadline, cancels the pending Jev call and says what happened", async () => {
  const b = await Barq.launch({ browser });
  await b.page.setContent("<button>Go</button>");
  let cancelled = false;
  // like fetch: an already-aborted signal rejects at once, otherwise on abort
  b.decide = () => new Promise((_, reject) => {
    const stop = () => { cancelled = true; reject(new Error("aborted")); };
    b.abort.signal.aborted ? stop() : b.abort.signal.addEventListener("abort", stop);
  });
  const t0 = Date.now();
  const r = await b.do("Press Go", { timeoutMs: 400 });
  assert.equal(r.status, "timeout");
  assert.ok(cancelled);
  assert.ok(Date.now() - t0 < 1500);
  await b.close();
});

test("open() warns when a page renders no text", async () => {
  const b = await Barq.launch({ browser });
  assert.match((await b.open("data:text/html,<div id=app></div>")).warning, /rendered no text/);
  assert.equal((await b.open("data:text/html,<p>hello</p>")).warning, undefined);
  await b.close();
});

test("a control that pays, sends or deletes waits for allow_irreversible, even when Jev rates it safe", async () => {
  const b2 = await Barq.launch({ browser });
  await b2.page.setContent(`<button onclick="document.body.dataset.paid = 'yes'">Pay now</button>`);
  const [{ i }] = (await b2.snapshot()).elements;
  b2.decide = async () => clickAnswers(i);   // irreversible scored 0.02
  let r = await b2.do("Finish the purchase");
  assert.equal(r.status, "needs_confirmation", r.info);
  assert.equal(r.pending.because, '"Pay"');
  assert.equal(await b2.page.evaluate(() => document.body.dataset.paid), undefined);
  await b2.do("Finish the purchase", { allowIrreversible: true, maxActions: 1 });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.paid), "yes");

  await b2.page.setContent(`<button onclick="document.body.dataset.gone = 'yes'">Delete account</button>`);
  const n = +(await b2.snapshotText()).match(/\[(\d+)\] button "Delete account"/)[1];
  r = await b2.actOn({ action: "click", element: n });
  assert.equal(r.status, "needs_confirmation", r.info);
  assert.equal(await b2.page.evaluate(() => document.body.dataset.gone), undefined);
  await b2.actOn({ action: "click", element: n, allowIrreversible: true });
  assert.equal(await b2.page.evaluate(() => document.body.dataset.gone), "yes");
  await b2.close();
});

test("settle bounds text churn and returns quickly on a quiet page", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent('<p id="tick">tick</p>');
  await b.page.evaluate(() => { window.tick = setInterval(() => document.querySelector('#tick').firstChild.data = String(Date.now()), 100); });
  const churn = await b.settle();
  assert.ok(churn >= 1000 && churn < 2000, `text churn: ${churn}ms`);
  await b.page.evaluate(() => { clearInterval(window.tick); document.querySelector('#tick').textContent = 'quiet'; });
  const quiet = await b.settle();
  assert.ok(quiet < 500, `quiet page: ${quiet}ms`);
  t.diagnostic(`text churn ${churn}ms; quiet page ${quiet}ms`);
});

test("settle observes class, style and control state changes", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  for (const attr of ['class', 'style', 'disabled', 'aria-busy', 'aria-expanded', 'aria-hidden', 'hidden', 'value', 'checked', 'open']) {
    await b.page.setContent('<button>Go</button>');
    await b.page.evaluate(attr => {
      const el = document.querySelector('button'); let n = 0;
      const timer = setInterval(() => {
        el.setAttribute(attr, attr === 'style' ? `opacity:${++n % 2 ? '.8' : '1'}` : String(++n));
        if (n === 3) clearInterval(timer);
      }, 100);
    }, attr);
    const ms = await b.settle();
    // it saw the changes (the last at ~300 ms, then 150 ms of quiet), and didn't sit out the 1.5 s cap
    assert.ok(ms >= 400 && ms < 1200, `${attr}: ${ms}ms`);
  }
});

test("settle waits for a fetch scheduled after act and actOn", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.route('https://fixture.test/**', async route => {
    if (route.request().url().endsWith('/data')) {
      await new Promise(r => setTimeout(r, 600));
      await route.fulfill({ body: 'ready' });
    } else await route.fulfill({ contentType: 'text/html', body: `<button onclick="setTimeout(() => fetch('/data').then(r => r.text()).then(text => document.querySelector('p').textContent = text), 250)">Load</button><p>waiting</p>` });
  });
  await b.open('https://fixture.test/');
  for (const manual of [false, true]) {
    await b.page.locator('p').evaluate(el => el.textContent = 'waiting');
    const i = (await b.snapshot()).elements[0].i;
    await sleep(450);
    const start = Date.now();
    if (manual) await b.actOn({ action: 'click', element: i });
    else { await b.act({ tool: 'click', target: i }); await b.settle(); }
    assert.equal(await b.page.locator('p').textContent(), 'ready');
    assert.ok(Date.now() - start >= 850);
    assert.ok(b.lastActionAt >= start);
    assert.equal(b.settleWaiters.size, 0);
  }
});

test("settle observes delayed work from the end of a slow action", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent(`<button disabled onclick="setTimeout(() => document.querySelector('p').textContent = 'ready', 250)">Load</button><p>waiting</p>`);
  await b.page.evaluate(() => setTimeout(() => document.querySelector('button').disabled = false, 250));
  const i = (await b.snapshot()).elements[0].i;
  await b.act({ tool: 'click', target: i });
  const ended = Date.now();
  await b.settle();
  assert.equal(await b.page.locator('p').textContent(), 'ready');
  assert.ok(b.lastActionEnd >= ended - 20 && b.lastActionEnd - b.lastActionAt >= 200, `action ${b.lastActionAt}..${b.lastActionEnd}, ended ${ended}`);
});

test("settle caps pending requests and ignores requests from before an action", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.route('https://fixture.test/poll', () => {});
  await b.page.setContent('<button>Go</button>');
  const request = b.page.waitForEvent('request');
  await b.page.evaluate(() => { fetch('https://fixture.test/poll').catch(() => {}); });
  await request;
  const ms = await b.settle();
  assert.ok(ms >= 2800 && ms < 3500, `pending fetch: ${ms}ms`);
  const i = (await b.snapshot()).elements[0].i;
  await b.act({ tool: 'click', target: i });
  assert.ok(await b.settle() < 500);

  const old = [...b.inflight.keys()][0];
  b.inflight.set(old, Date.now() - 5100);
  b.lastActionAt = Date.now() - 17_000;
  assert.ok(await b.settle() < 500, 'a request older than five seconds is ignored');
});

test("settle preserves quiet/max overrides and the step deadline", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent('<p>hello</p>');
  let ms = await b.settle({ quiet: 350, max: 1000 });
  assert.ok(ms >= 300 && ms < 700, `custom quiet: ${ms}ms`);
  await b.page.evaluate(() => setInterval(() => document.querySelector('p').textContent = String(Date.now()), 20));
  ms = await b.settle({ quiet: 400, max: 250 });
  assert.ok(ms >= 200 && ms < 500, `custom max: ${ms}ms`);
  b.deadline = Date.now() + 80;
  assert.ok(await b.settle() < 250);
  b.deadline = null;
  assert.equal(b.settleWaiters.size, 0);
});

test("settle follows a requested popup whose document arrives later or keeps loading", async t => {
  // /slow answers after 500 ms; /stream sends its first bytes at once and the rest 3.3 s later,
  // past the cap on waiting for requests
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/slow') { await sleep(500); res.end('<p>New tab ready</p>'); return; }
    res.write('<title>Streaming</title>' + ' '.repeat(4096));
    await sleep(3300);
    res.end('<p>New tab ready</p>');
  });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  for (const html of [`<a href="${base}/slow" target="_blank">Open</a>`, `<button onclick="window.open('${base}/stream')">Open</button>`]) {
    const previous = b.page;
    await previous.goto('data:text/html,' + encodeURIComponent(html));
    const i = (await b.snapshot()).elements[0].i;
    await b.act({ tool: 'click', target: i });
    await b.settle();
    assert.notEqual(b.page, previous);
    assert.equal(await b.page.evaluate(() => document.readyState), 'complete');
    assert.equal(await b.page.locator('p').textContent(), 'New tab ready');
  }
});

test("settle keeps a loading document pending up to its requested maximum", async t => {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/link') { res.end('<a href="/stream">Open</a>'); return; }
    res.setHeader('content-type', 'text/html');
    res.write('<p>Head</p>' + ' '.repeat(4096));
    await sleep(4500);
    res.end('<p id="done">Tail</p>');
  });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await b.open(base + '/link');
  const i = (await b.snapshot()).elements[0].i;
  await b.act({ tool: 'click', target: i });
  const capped = await b.settle({ max: 4000 });
  assert.ok(capped >= 3900 && capped < 4400, `explicit max: ${capped}ms`);
  assert.equal(await b.page.evaluate(() => document.readyState), 'loading');
  await b.settle();
  assert.equal(await b.page.evaluate(() => document.readyState), 'complete');
  assert.ok(await b.page.locator('#done').isVisible());
});

test("settle counts changes inside a frame, also one that predates the session", async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  const p = await context.newPage();
  await p.setContent(`<iframe srcdoc="<p>waiting</p>"></iframe>`);
  const inner = p.frames()[1];
  await inner.locator('p').waitFor();
  const b = await Barq.forPage(p); t.after(() => b.close());
  await sleep(300);   // the main frame is quiet from here on
  // changes at 0, 100 and 200 ms: settled 150 ms after the last one
  await inner.evaluate(() => {
    let n = 0; const change = () => document.querySelector('p').textContent = String(++n);
    change(); const timer = setInterval(() => { change(); if (n === 3) clearInterval(timer); }, 100);
  });
  const ms = await b.settle();
  assert.ok(ms >= 300 && ms < 800, `frame changes: ${ms}ms`);
  assert.equal(await inner.locator('p').textContent(), '3');
});

test("mutation bindings are quiet while idle and untracked requests do not wake settle", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent(`<div>x</div><script>(function tick(n) { document.querySelector('div').style.left = n + 'px'; requestAnimationFrame(() => tick(n + 1)); })(0)</script>`);
  await sleep(100);
  let wakes = 0; const wake = b.wakeSettle.bind(b);
  b.wakeSettle = () => { wakes++; wake(); };
  await sleep(250);
  assert.equal(wakes, 0, `idle mutation wakes: ${wakes}`);
  const untrack = b.page.listeners('requestfinished').at(-1);
  untrack({});
  assert.equal(wakes, 0, 'an untracked request does not wake settle');
  // while settle() waits, a change every frame reaches it at most about every 50 ms
  const ms = await b.settle();
  assert.ok(wakes > 5 && wakes <= ms / 50 + 3, `${wakes} wakes in ${ms}ms`);
  await sleep(250);
  const after = wakes;
  await sleep(250);
  assert.equal(wakes, after, 'quiet again once settle() returns');
});

test("open waits for a delayed module chunk before checking page text", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.route('https://modules.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/main.js') return route.fulfill({ contentType: 'text/javascript', body: `import('/chunk.js')` });
    if (path === '/chunk.js') {
      await sleep(300);
      return route.fulfill({ contentType: 'text/javascript', body: `document.querySelector('#app').textContent = 'App loaded'` });
    }
    return route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="/main.js"></script>` });
  });
  const r = await b.open('https://modules.test/');
  assert.equal(r.warning, undefined);
  assert.equal(await b.page.locator('#app').textContent(), 'App loaded');
});

test("a slow script from another site holds the page for a second at most; the page's own code is waited for", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.route('https://tracker.test/**', async route => { await sleep(4000); return route.fulfill({ contentType: 'text/javascript', body: '' }).catch(() => {}); });
  await b.page.route('https://shop.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/main.js') return route.fulfill({ contentType: 'text/javascript', body: `import('/chunk.js'); const s = document.createElement('script'); s.src = 'https://tracker.test/t.js'; document.head.append(s);` });
    if (path === '/chunk.js') {
      await sleep(300);
      return route.fulfill({ contentType: 'text/javascript', body: `document.querySelector('#app').textContent = 'App loaded'` });
    }
    return route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="/main.js"></script>` });
  });
  const r = await b.open('https://shop.test/');
  assert.equal(await b.page.locator('#app').textContent(), 'App loaded');
  assert.ok(r.ms < 2600, `open took ${r.ms} ms`);
});

test("Jev can keep waiting for a visible spinner", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent('<p>Loading…</p>');
  await b.page.evaluate(() => setTimeout(() => document.querySelector('p').textContent = 'Ready', 700));
  b.decide = async page => ({ ...clickAnswers(0),
    done: { noul: page.text === 'Ready' ? 1 : 0 }, done_change: { noul: page.text === 'Ready' ? 1 : 0 },
    tool: { choice: page.text === 'Ready' ? 'none' : 'wait', probabilities: { none: 1, wait: 1 } },
  });
  const r = await b.do('Wait until ready');
  assert.equal(r.status, 'done');
  assert.ok(r.actions.some(a => a.action === 'wait'));
});

test("inputs two iframes deep are numbered and reachable", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.route('https://*.test/**', route => {
    const host = new URL(route.request().url()).hostname;
    const body = host === 'main.test' ? '<input placeholder="Name"><iframe src="https://outer.test/"></iframe>'
      : host === 'outer.test' ? '<button>Outer</button><iframe src="https://inner.test/"></iframe>'
      : '<input placeholder="Name">';
    return route.fulfill({ contentType: 'text/html', body });
  });
  await b.open('https://main.test/');
  const page = await b.snapshot();   // as it stands now
  assert.equal(b.page.frames().length, 3);
  assert.deepEqual(page.elements.map(e => e.i), [0, 1, 2]);
  const inner = page.elements.find(e => e.placeholder === 'Name' && e.frame === 2);
  assert.ok(inner);
  assert.equal(b.frames.get(inner.i).parentFrame().parentFrame(), b.page.mainFrame());
  await b.act({ tool: 'type', target: inner.i, value: 'Ada' });
  assert.equal(await b.locate(inner.i).inputValue(), 'Ada');
  assert.equal(await b.page.locator('input').inputValue(), '');
  await b.actOn({ action: 'type', element: inner.i, value: 'Lovelace' });
  assert.equal(await b.locate(inner.i).inputValue(), 'Lovelace');
});

test("an element number from a frame that was replaced doesn't match its look-alike", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent(`<button>Main</button><iframe srcdoc="<button onclick='parent.hit = 1'>Go</button>"></iframe>`);
  await b.page.waitForFunction(() => document.querySelector('iframe').contentDocument?.querySelector('button'));
  const go = +(await b.snapshotText()).match(/\[(\d+)\] button "Go"/)[1];
  // a widget re-renders its iframe: same place, same content, a different frame
  await b.page.evaluate(() => { const f = document.querySelector('iframe'), g = f.cloneNode(); g.srcdoc = f.srcdoc.replace('hit = 1', 'hit = 2'); f.replaceWith(g); });
  await b.page.waitForFunction(() => document.querySelector('iframe').contentDocument?.querySelector('button'));
  await assert.rejects(b.actOn({ action: 'click', element: go }), /take a new snapshot/);
  assert.equal(await b.page.evaluate(() => window.hit), undefined);
  const again = +(await b.snapshotText()).match(/\[(\d+)\] button "Go"/)[1];
  await b.actOn({ action: 'click', element: again });
  assert.equal(await b.page.evaluate(() => window.hit), 2);
});

for (const [count, wanted] of [[240, 240], [241, 241], [300, 280], [8000, 7800]]) {
  test(`native dropdown with ${count} options can choose option ${wanted}`, async t => {
    const b = await Barq.launch({ browser }); t.after(() => b.close());
    await b.page.setContent(`<select>${Array.from({ length: count }, (_, i) => `<option value="v${i + 1}">Option ${i + 1}</option>`).join('')}</select>`);
    const initial = await b.snapshot(), el = initial.elements[0];
    assert.equal(el.options.length, 25);
    assert.equal(el.option_count, count);
    assert.match(formatPage(initial), new RegExp(`option_count=${count}`));
    b.decide = async page => {
      const done = page.elements[0].value === `Option ${wanted}`;
      return { ...clickAnswers(el.i), done: { noul: +done }, done_change: { noul: +done },
        tool: { choice: done ? 'none' : 'select', probabilities: { none: 1, select: 1 } } };
    };
    const questions = [];
    b.call = async (state, qs) => {
      const name = Object.keys(qs)[0], criteria = Object.keys(qs[name].criteria);
      assert.ok(criteria.length > 0 && criteria.length <= 240, `${name}: ${criteria.length} choices`);
      questions.push(name);
      if (name === 'group') {
        assert.ok(state.dropdown.groups.reduce((n, g) => n + g.summary.length, 0) <= 36_000, 'summaries fit in one request');
        const group = state.dropdown.groups.find(g => { const n = g.summary.match(/\d+/g).map(Number); return n[0] <= wanted && wanted <= n.at(-1); });
        assert.ok(group, 'a group summary covers the desired option');
        return { answers: { group: { choice: String(group.g), probabilities: { [group.g]: 1 } } } };
      }
      const option = state.dropdown.options.find(o => o.label === `Option ${wanted}`);
      assert.ok(option, 'the full dropdown supplies options beyond its preview');
      assert.ok(criteria.includes(String(option.i)));
      return { answers: { opt: { choice: String(option.i) } } };
    };
    const r = await b.do(`Select Option ${wanted}`);
    assert.equal(r.status, 'done');
    assert.deepEqual(questions, count > 240 ? ['group', 'opt'] : ['opt']);
    assert.equal(await b.page.locator('select').inputValue(), `v${wanted}`);
    assert.equal(await b.page.locator('select').evaluate(el => el.selectedIndex), wanted - 1);
    assert.equal(r.actions[0].option, `Option ${wanted}`);
  });
}

test("dropdown choices retain full labels and distinguish duplicate labels", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  const label = 'A dropdown label that is longer than the preview allows';
  await b.page.setContent(`<select><option>Start</option><option value="first" label="${label}">short</option><option value="second" label="${label}">short</option></select>`);
  b.decide = async () => ({ ...clickAnswers(0), tool: { choice: 'select', probabilities: { select: 1 } } });
  b.call = async (state, qs) => {
    assert.deepEqual(Object.keys(qs.opt.criteria), ['0', '1', '2']);
    assert.equal(state.dropdown.options[2].label, label);
    return { answers: { opt: { choice: '2' } } };
  };
  await b.do('Select the second matching label', { maxActions: 1 });
  assert.equal(await b.page.locator('select').inputValue(), 'second');
});

// do() on a page with a <select>: Jev (stubbed) picks it, `answer` answers the dropdown questions.
async function selectWith(b, answer, opts = {}) {
  const el = (await b.snapshot()).elements.find(e => e.tag === 'select');
  b.decide = async () => ({ ...clickAnswers(el.i), tool: { choice: 'select', probabilities: { select: 1 } } });
  b.call = answer;
  return b.do('Choose the right option', { maxActions: 1, ...opts });
}
const range = (from, to) => Array.from({ length: to - from }, (_, k) => from + k);

test("a dropdown refilled while Jev chooses is a failed action, not a different option", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent(`<select><option value="a">Apple</option><option value="b">Banana</option><option value="c">Cherry</option></select>`);
  const r = await selectWith(b, async state => {
    // another field changed and the list was refilled while the question was out
    await b.page.evaluate(() => { document.querySelector('select').innerHTML = '<option value="k">Kiwi</option><option value="a">Apple</option><option value="b">Banana</option>'; });
    return { answers: { opt: { choice: String(state.dropdown.options.find(o => o.label === 'Banana').i) } } };
  });
  assert.equal(await b.page.locator('select').inputValue(), 'k');
  assert.match(r.actions[0].error, /dropdown changed/);
});

test("a dropdown whose options can't be read is a recorded action error, and the deadline still ends the step", { timeout: 20_000 }, async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent(`<select><option>One</option><option>Two</option></select>`);
  const page = await b.snapshot();   // as it stands now
  const el = page.elements[0];
  b.call = async () => assert.fail('no question without the options');
  // re-rendered since the page was read: the element the answer named is not there any more
  await b.page.evaluate(() => { const s = document.querySelector('select'), c = s.cloneNode(true); c.removeAttribute('data-jev-i'); s.replaceWith(c); });
  const t0 = Date.now();
  await assert.rejects(b.chooseOption(page, 'Choose Two', el), /options could not be read/);
  assert.ok(Date.now() - t0 < 6000, `${Date.now() - t0}ms`);

  let r;

  await b.page.setContent(`<select><option>One</option><option>Two</option></select>`);
  b.decide = async () => ({ ...clickAnswers(el.i), tool: { choice: 'select', probabilities: { select: 1 } } });
  b.call = () => new Promise((_, reject) => b.abort.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  // a goal that does not name the option, so the list has to be read and the step is left waiting
  r = await b.do('Choose the second thing in the list', { timeoutMs: 1000 });
  assert.equal(r.status, 'timeout');
});

test("long option lists keep each label's distinguishing end and ask over the likeliest groups", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  const label = n => `Department of Computer Science and Engineering, Room ${n}`;
  await b.page.setContent(`<select>${range(0, 300).map(n => `<option value="r${n}">${label(n)}</option>`).join('')}</select>`);
  const asked = [];
  await selectWith(b, async (state, qs) => {
    if (qs.group) {
      for (const g of state.dropdown.groups) {
        const rooms = g.summary.split(' | ');
        assert.equal(rooms.length, 30, g.summary);
        assert.ok(rooms.every((room, k) => room.endsWith(` ${g.g * 30 + k}`)), g.summary);
      }
      return { answers: { group: { choice: '3', probabilities: { 3: 0.5, 7: 0.3, 1: 0.15, 0: 0.05 } } } };
    }
    asked.push(...Object.keys(qs.opt.criteria).map(Number));
    return { answers: { opt: { choice: String(state.dropdown.options.find(o => o.label === label(215)).i) } } };
  });
  assert.deepEqual(asked, [...range(30, 60), ...range(90, 120), ...range(210, 240)]);
  assert.equal(await b.page.locator('select').inputValue(), 'r215');
});

test("the dropdown question carries a short page excerpt and clipped options", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  const label = n => `Option ${n} ` + 'with a very long description '.repeat(10);
  await b.page.setContent(`<p>${'Lots of page text. '.repeat(400)}</p>${'<button>Other</button>'.repeat(200)}
    <select>${range(0, 240).map(n => `<option value="${'v'.repeat(100)}${n}">${label(n)}</option>`).join('')}</select>`);
  await selectWith(b, async state => {
    assert.deepEqual(Object.keys(state.page), ['url', 'title', 'text']);
    assert.ok(state.page.text.length <= 1200);
    assert.ok(state.dropdown.options.every(o => o.label.length <= 80 && o.value.length <= 40));
    assert.equal(new Set(state.dropdown.options.map(o => o.value)).size, 240, 'clipped values stay distinct');
    assert.ok(JSON.stringify(state).length < 45_000, `${JSON.stringify(state).length} chars`);
    return { answers: { opt: { choice: '7' } } };
  });
  assert.equal(await b.page.locator('select').evaluate(s => s.selectedIndex), 7);
});

test("options keep the <optgroup> they are listed under", async t => {
  const b = await Barq.launch({ browser }); t.after(() => b.close());
  await b.page.setContent(`<select><optgroup label="Europe"><option value="fr">Paris</option><option>Lyon</option></optgroup><optgroup label="America"><option value="us">Paris</option></optgroup></select>`);
  const r = await selectWith(b, async state => ({ answers: { opt: { choice: String(state.dropdown.options.find(o => o.label === 'Paris' && o.group === 'America').i) } } }));
  assert.equal(await b.page.locator('select').inputValue(), 'us');
  assert.equal(r.actions[0].option, 'Paris (America)');
});

test("option summaries list every option while they fit and show the range when they don't", () => {
  const opts = range(7771, 7805).map(n => ({ label: `Option ${n}` }));
  const s = optionSummary(opts, 152);
  assert.ok(s.length <= 152 && s.startsWith('Option 7771 … ') && s.endsWith(' … Option 7804'), s);
  assert.equal(optionSummary(opts.slice(0, 3), 700), 'Option 7771 | Option 7772 | Option 7773');
  assert.equal(optionSummary([{ label: 'Paris', group: 'Europe' }, { label: 'Lyon', group: 'Europe' }, { label: 'Paris', group: 'America' }], 700), 'Europe: Paris | Lyon | America: Paris');
  assert.equal(clipMiddle('Department of Computer Science, Room 101', 20), 'Department o…oom 101');
});
