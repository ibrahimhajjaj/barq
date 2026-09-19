// Offline tests: steps that finished are recorded and replayed without Jev, and a replay stops
// wherever the page no longer fits it. Jev is stubbed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Barq } from "../src/session.mjs";
import { RecipeBook, recipeKey } from "../src/recipes.mjs";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

// A session with its own recipe file; `notes` collects what the book was told about replays.
async function session(t, html) {
  const dir = mkdtempSync(join(tmpdir(), "jev-recipes-"));
  const book = new RecipeBook({ file: join(dir, "recipes.json") });
  const notes = [], note = book.note.bind(book);
  book.note = (key, n) => { notes.push(n); note(key, n); };
  const b = await Barq.launch({ browser, recipes: book });
  t.after(async () => { await b.close(); rmSync(dir, { recursive: true, force: true }); });
  await b.page.setContent(html, { waitUntil: "load" });
  return { b, book, notes, file: book.file };
}

// Jev's per-round answers
const answer = ({ tool = "click", target, value, done = 0, irreversible = 0.1 } = {}) => ({
  done: { noul: done }, done_change: { noul: done }, blocked: { noul: 0 }, error: { noul: 0 }, login: { noul: 0 }, irreversible: { noul: irreversible },
  tool: { choice: tool, probabilities: { [tool]: 0.9 } }, stages: 1,
  ...(target != null ? { target: { probabilities: { [target]: 0.95 } } } : {}), ...(value ? { value: { choice: value } } : {}),
});
const finished = done => answer({ tool: "none", done });
const el = (page, pred) => page.elements.find(pred).i;
const did = (history, name) => history.some(h => h.element?.includes(name));

// Stub Jev with a function of the page and history; counts its decisions and other questions.
function jev(b, decide, other = () => ({ complete: { noul: 0.9 }, q: { noul: 0.1 } })) {
  const n = { decide: 0, call: 0, changes: [], histories: [] };
  b.decide = async (page, goal, values, history, lastChange) => { n.decide++; n.changes.push(lastChange); n.histories.push(history); return decide(page, history); };
  b.call = async () => { n.call++; return { answers: other() }; };
  return n;
}

const TODO = `<input placeholder="New todo"><button onclick="const li = document.createElement('li');
  li.textContent = document.querySelector('input').value; document.querySelector('ul').append(li)">Add</button><ul></ul>`;
const addTodo = (page, history) => !did(history, "New todo") ? answer({ tool: "type", target: el(page, e => e.placeholder === "New todo"), value: "text" })
  : !did(history, "Add") ? answer({ target: el(page, e => e.text === "Add") }) : finished(0.95);
const items = b => b.page.$$eval("li", l => l.map(x => x.textContent));

test("a step that finished is recorded, and repeated on the same page it replays with one Jev round", async t => {
  const { b } = await session(t, TODO);
  jev(b, addTodo);
  let r = await b.do("Add the todo", { values: { text: "buy milk" } });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "recorded");

  await b.page.setContent(TODO);
  // the same score after two actions of its own would end the step, so it must end it after a replay
  const n = jev(b, () => finished(0.8));
  r = await b.do("Add the todo", { values: { text: "buy milk" } });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "replayed");
  assert.deepEqual([n.decide, n.call], [1, 0]);
  assert.ok(n.changes[0], "the round after the replay sees what its last action changed");
  assert.deepEqual(r.actions.map(h => `${h.action} ${h.value ?? ""}`.trim()), ["type text", "click"]);
  assert.deepEqual(await items(b), ["buy milk"]);
});

test("values are replayed by name, and what they contained never reaches the recipe file", async t => {
  const page = `<input placeholder="Search"><button onclick="const v = document.querySelector('input').value;
    document.querySelector('#out').innerHTML = '<a href=#' + v + '>Open ' + v + '</a>'">Go</button><div id=out></div>`;
  const { b, file } = await session(t, page);
  jev(b, (page, history) => !did(history, "Search") ? answer({ tool: "type", target: el(page, e => e.placeholder === "Search"), value: "q" })
    : !did(history, "Go") ? answer({ target: el(page, e => e.text === "Go") })
    : !did(history, "Open") ? answer({ target: el(page, e => e.text?.startsWith("Open")) }) : finished(0.95));
  assert.equal((await b.do("Search and open the result", { values: { q: "cats" } })).recipe, "recorded");
  assert.equal(await b.page.evaluate(() => location.hash), "#cats");

  await b.page.setContent(page);
  const n = jev(b, () => finished(0.95));
  const r = await b.do("Search and open the result", { values: { q: "dogs" } });
  assert.equal(r.recipe, "replayed");
  assert.equal(n.decide, 1);
  assert.equal(await b.page.inputValue("input"), "dogs");
  assert.equal(await b.page.evaluate(() => location.hash), "#dogs", "the link for the new value, not the recorded one");
  const saved = readFileSync(file, "utf8");
  assert.doesNotMatch(saved, /cats|dogs/);
  assert.match(saved, /\{q\}/);
});

test("a target that is gone stops the replay, and the loop finishes the step and records it again", async t => {
  const WIZARD = name => `<button onclick="document.body.dataset.next = 1">Next</button><button onclick="document.body.dataset.end = 1">${name}</button>`;
  const { b, book, notes } = await session(t, WIZARD("Finish"));
  jev(b, (page, history) => !did(history, "Next") ? answer({ target: el(page, e => e.text === "Next") })
    : !did(history, "Finish") ? answer({ target: el(page, e => e.text === "Finish") }) : finished(0.95));
  assert.equal((await b.do("Complete the wizard")).recipe, "recorded");

  await b.page.setContent(WIZARD("Done"));
  const n = jev(b, (page, history) => !did(history, "Done") ? answer({ target: el(page, e => e.text === "Done") }) : finished(0.95));
  const r = await b.do("Complete the wizard");
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "partly replayed");
  assert.equal(n.decide, 2);
  assert.deepEqual(notes, [{ missed: true }]);
  assert.deepEqual(await b.page.evaluate(() => ({ ...document.body.dataset })), { next: "1", end: "1" });
  const key = recipeKey("Complete the wizard", b.page.url(), {});
  assert.deepEqual(book.get(key).steps.map(s => s.target.name), ["Next", "Done"]);
});

test("a replayed action on a control that pays waits for allow_irreversible, then pays on the next call without Jev", async t => {
  const PAY = `<button onclick="document.body.dataset.paid = 'yes'">Pay now</button>`;
  const { b, notes } = await session(t, PAY);
  jev(b, (page, history) => !did(history, "Pay") ? answer({ target: el(page, e => e.text === "Pay now") }) : finished(0.95));
  assert.equal((await b.do("Finish the purchase", { allowIrreversible: true })).recipe, "recorded");

  await b.page.setContent(PAY);
  const n = jev(b, () => finished(0.95));
  const r = await b.do("Finish the purchase");
  assert.equal(r.status, "needs_confirmation", r.info);
  assert.equal(r.pending.because, '"Pay"');
  assert.equal(await b.page.evaluate(() => document.body.dataset.paid), undefined);
  assert.deepEqual([n.decide, n.call, r.actions.length, notes.length], [0, 0, 0, 0]);
  // allowed, the replay goes on from the action it stopped at; Jev only checks the result
  const again = jev(b, () => finished(0.95));
  const r2 = await b.do("Finish the purchase", { allowIrreversible: true });
  assert.equal(r2.status, "done");
  assert.equal(r2.recipe, "replayed");
  assert.deepEqual([again.decide, again.call], [1, 0]);
  assert.deepEqual(r2.actions.map(h => h.element), ['button "Pay now"']);
  assert.equal(await b.page.evaluate(() => document.body.dataset.paid), "yes");
  // a fresh start replays again
  await b.page.setContent(PAY);
  jev(b, () => finished(0.95));
  assert.equal((await b.do("Finish the purchase", { allowIrreversible: true })).recipe, "replayed");
});

test("going on after a confirmation stop never repeats what ran before it", async t => {
  // one page that never changes address: add to the cart, then pay
  const SHOP = `<button onclick="document.body.dataset.cart = +(document.body.dataset.cart || 0) + 1">Add to cart</button>
    <button onclick="document.body.dataset.paid = 'yes'">Pay now</button>`;
  const { b } = await session(t, SHOP);
  const flow = (page, history) => !did(history, "Add to cart") ? answer({ target: el(page, e => e.text === "Add to cart") })
    : !did(history, "Pay") ? answer({ target: el(page, e => e.text === "Pay now") }) : finished(0.95);
  jev(b, flow);
  assert.equal((await b.do("Buy the mug", { allowIrreversible: true })).recipe, "recorded");
  await b.page.setContent(SHOP);
  jev(b, () => finished(0.95));
  assert.equal((await b.do("Buy the mug")).status, "needs_confirmation", "the replay adds to the cart, then stops at Pay");
  assert.equal(await b.page.evaluate(() => document.body.dataset.cart), "1");
  jev(b, (page, history) => !did(history, "Pay") ? answer({ target: el(page, e => e.text === "Pay now") }) : finished(0.95));
  await b.do("Buy the mug", { allowIrreversible: true });
  assert.equal(await b.page.evaluate(() => document.body.dataset.cart), "1", "the mug is in the cart once");
  assert.equal(await b.page.evaluate(() => document.body.dataset.paid), "yes");
});

// A shop on two addresses: the mug's page adds it to the cart and goes to the checkout, which pays.
async function shop(t) {
  const PAGES = {
    "/mug": `<button onclick="localStorage.cart = +(localStorage.cart || 0) + 1; location.href = '/checkout'">Add to cart</button>`,
    "/checkout": `<p>Your cart</p><button onclick="localStorage.paid = +(localStorage.paid || 0) + 1; document.title = 'paid'; document.body.append('Thank you')">Pay now</button>`,
  };
  const s = await session(t, "");
  await s.b.page.route("https://shop.test/**", route => route.fulfill({ contentType: "text/html", body: PAGES[new URL(route.request().url()).pathname] ?? "" }));
  const start = async () => { await s.b.open("https://shop.test/mug"); await s.b.page.evaluate(() => localStorage.clear()); };
  const cart = () => s.b.page.evaluate(() => localStorage.cart), paid = () => s.b.page.evaluate(() => localStorage.paid);
  // Jev: add the mug, then pay
  const buy = page => page.text.includes("Thank you") ? finished(0.95)
    : page.url.endsWith("/mug") ? answer({ target: el(page, e => e.text === "Add to cart") }) : answer({ target: el(page, e => e.text === "Pay now") });
  return { ...s, start, cart, paid, buy };
}

test("a flow stopped for confirmation is recorded whole under its first page, then replays end to end", async t => {
  const { b, book, start, cart, buy } = await shop(t);
  await start();
  let n = jev(b, buy);
  let r = await b.do("Buy the mug");
  assert.equal(r.status, "needs_confirmation", r.info);
  assert.equal(r.recipe, undefined);
  // the next call goes on at the checkout, knowing the mug is in the cart, and records the whole flow
  n = jev(b, buy);
  r = await b.do("Buy the mug", { allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "recorded");
  assert.deepEqual(r.actions.map(h => h.element), ['button "Pay now"']);
  assert.ok(did(n.histories[0], "Add to cart"), "Jev sees what ran before the stop");
  assert.equal(await cart(), "1");
  assert.deepEqual(book.get(recipeKey("Buy the mug", "https://shop.test/mug")).steps.map(s => s.target.name), ["Add to cart", "Pay now"]);
  assert.equal(book.get(recipeKey("Buy the mug", "https://shop.test/checkout")), null);

  // from the start again: the replay adds the mug and stops at Pay, then pays when allowed
  await start();
  n = jev(b, () => finished(0.95));
  r = await b.do("Buy the mug");
  assert.equal(r.status, "needs_confirmation", r.info);
  assert.equal(r.pending.because, '"Pay"');
  assert.equal(n.decide, 0);
  r = await b.do("Buy the mug", { allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "replayed");
  assert.equal(n.decide, 1, "only the round that checks the result");
  assert.equal(await b.page.title(), "paid");
  assert.equal(await cart(), "1");
});

test("a different goal in between ends the held flow", async t => {
  const { b, book, start, cart, buy } = await shop(t);
  await start();
  jev(b, buy);
  assert.equal((await b.do("Buy the mug")).status, "needs_confirmation");
  assert.equal(await cart(), "1");
  jev(b, () => finished(0.95));
  await b.do("Look at the cart");
  // a new call at the checkout: Jev starts without the earlier actions, and only this call's are recorded
  const n = jev(b, buy);
  const r = await b.do("Buy the mug", { allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "recorded");
  assert.deepEqual(n.histories[0], []);
  assert.equal(await cart(), "1");
  assert.equal(book.get(recipeKey("Buy the mug", "https://shop.test/mug")), null);
  assert.equal(book.get(recipeKey("Buy the mug", "https://shop.test/checkout")).steps.length, 1);
});

test("after the caller acts by hand, the next call neither goes on with the flow nor starts over", async t => {
  const { b, start, cart, paid, buy } = await shop(t);
  await start();
  jev(b, buy);
  await b.do("Buy the mug");
  await b.do("Buy the mug", { allowIrreversible: true });
  await start();
  jev(b, () => finished(0.95));
  assert.equal((await b.do("Buy the mug")).status, "needs_confirmation");
  const pay = +(await b.snapshotText()).match(/\[(\d+)\] button "Pay now"/)[1];
  await b.actOn({ action: "click", element: pay, allowIrreversible: true });
  jev(b, buy);
  const r = await b.do("Buy the mug", { allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  assert.deepEqual(r.actions, []);
  assert.deepEqual([await cart(), await paid()], ["1", "1"]);
});

test("a held flow whose next step is gone goes on in the loop and isn't recorded", async t => {
  const { b, book, notes, start, buy } = await shop(t);
  await start();
  jev(b, buy);
  await b.do("Buy the mug");
  await b.do("Buy the mug", { allowIrreversible: true });
  const key = recipeKey("Buy the mug", "https://shop.test/mug"), before = book.get(key);
  await start();
  jev(b, () => finished(0.95));
  assert.equal((await b.do("Buy the mug")).status, "needs_confirmation");
  // the checkout now says "Place order" instead
  await b.page.evaluate(() => { document.querySelector("button").textContent = "Place order"; });
  const n = jev(b, (page, history) => !did(history, "Place order") ? answer({ target: el(page, e => e.text === "Place order") }) : finished(0.95));
  const r = await b.do("Buy the mug", { allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, undefined);
  assert.equal(n.decide, 2);
  assert.equal(await b.page.title(), "paid");
  assert.deepEqual(book.get(key), before);
  assert.deepEqual(notes, []);
});

test("a confirm dialog opened by a replayed action is handed back as in the loop", async t => {
  const CLEAN = `<button onclick="document.body.dataset.c = confirm('Permanently delete 3 files?')">Clean up</button>`;
  const { b } = await session(t, CLEAN);
  jev(b, (page, history) => !did(history, "Clean up") ? answer({ target: el(page, e => e.text === "Clean up") }) : finished(0.95));
  assert.equal((await b.do("Clean up the folder", { allowIrreversible: true })).recipe, "recorded");

  await b.page.setContent(CLEAN);
  const n = jev(b, () => finished(0.95), () => ({ q: { noul: 0.9 } }));
  const r = await b.do("Clean up the folder");
  assert.equal(r.status, "needs_confirmation", r.info);
  assert.deepEqual(r.pending, { action: "click", element: 'button "Clean up"', dialog: "Permanently delete 3 files?", p_irreversible: 0.9 });
  assert.equal(await b.page.evaluate(() => document.body.dataset.c), "false");
  assert.deepEqual([n.decide, n.call], [0, 1]);
});

test("an action whose confirm dialog was dismissed runs again on the next call and is recorded once", async t => {
  const CLEAN = `<button onclick="if (confirm('Permanently delete 3 files?')) document.body.append('Deleted')">Clean up</button>`;
  const { b, book } = await session(t, CLEAN);
  const clean = page => page.text.includes("Deleted") ? finished(0.95) : answer({ target: el(page, e => e.text === "Clean up") });
  jev(b, clean, () => ({ q: { noul: 0.9 } }));
  assert.equal((await b.do("Clean up the folder")).status, "needs_confirmation");
  jev(b, clean);
  const r = await b.do("Clean up the folder", { allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "recorded");
  assert.equal(book.get(recipeKey("Clean up the folder", b.page.url())).steps.length, 1);
});

test("recipe: false neither replays nor records", async t => {
  const { b, file } = await session(t, TODO);
  jev(b, addTodo);
  await b.do("Add the todo", { values: { text: "buy milk" } });
  const before = readFileSync(file, "utf8");

  await b.page.setContent(TODO);
  const n = jev(b, addTodo);
  let r = await b.do("Add the todo", { values: { text: "buy milk" }, recipe: false });
  assert.equal(r.recipe, undefined);
  assert.equal(n.decide, 3);
  r = await b.do("Add the todo again", { values: { text: "walk the dog" }, recipe: false });
  assert.equal(r.status, "done", r.info);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a replay the next round doesn't confirm goes on in the loop, and is never done on its own", async t => {
  const STEPS = `<button onclick="document.body.insertAdjacentHTML('beforeend', '<button onclick=&quot;document.body.dataset.ok = 1&quot;>Continue</button>')">Next</button>`;
  const { b, notes } = await session(t, `<button>Next</button>`);
  jev(b, (page, history) => !did(history, "Next") ? answer({ target: el(page, e => e.text === "Next") }) : finished(0.95));
  await b.do("Get through the form");

  // the page now wants one more action after the recorded ones
  await b.page.setContent(STEPS);
  let n = jev(b, (page, history) => !did(history, "Continue") ? answer({ target: el(page, e => e.text === "Continue"), done: 0.2 }) : finished(0.95));
  let r = await b.do("Get through the form");
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "partly replayed");
  assert.equal(n.decide, 2);
  assert.deepEqual(notes, [{ missed: true }]);
  assert.equal(await b.page.evaluate(() => document.body.dataset.ok), "1");

  // replayed in full, but the page doesn't look done: not "done"
  await b.page.setContent(STEPS);
  n = jev(b, () => finished(0.1));
  r = await b.do("Get through the form");
  assert.equal(r.status, "stuck");
  assert.equal(r.recipe, "partly replayed");
  assert.equal(r.actions.length, 2);
  // stopped part way: the next call for it doesn't start the replay over
  jev(b, () => finished(0.95));
  r = await b.do("Get through the form");
  assert.deepEqual([r.status, r.recipe, r.actions.length], ["done", undefined, 0]);
  assert.equal(await b.page.getByText("Continue").count(), 1);
});

test("a checkbox already in the state a step leaves it is not clicked again", async t => {
  const BOX = checked => `<label><input type=checkbox ${checked ? "checked" : ""}> walk the dog</label>`;
  const { b, notes } = await session(t, BOX(false));
  jev(b, (page, history) => !did(history, "walk the dog") ? answer({ target: el(page, e => e.tag === "input:checkbox") }) : finished(0.95));
  assert.equal((await b.do("Mark walk the dog as done")).recipe, "recorded");

  await b.page.setContent(BOX(true));
  const n = jev(b, () => finished(0.95));
  const r = await b.do("Mark walk the dog as done");
  assert.equal(r.status, "done", r.info);
  assert.equal(r.actions.length, 0);
  assert.equal(n.decide, 1);
  assert.deepEqual(notes, [{ missed: true }]);
  assert.equal(await b.page.isChecked("input"), true);
});

test("a cancelled call stops before replaying anything", async t => {
  const { b, notes } = await session(t, TODO);
  jev(b, addTodo);
  await b.do("Add the todo", { values: { text: "buy milk" } });

  await b.page.setContent(TODO);
  const ac = new AbortController(); ac.abort();
  b.callSignal = ac.signal;
  const r = await b.do("Add the todo", { values: { text: "buy milk" } });
  b.callSignal = null;
  assert.equal(r.status, "timeout");
  assert.equal(r.actions.length, 0);
  assert.deepEqual(notes, []);
  assert.deepEqual(await items(b), []);
});
