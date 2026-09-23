// Offline tests: steps that finished are recorded and replayed without Jev, and a replay stops
// wherever the page no longer fits it. Jev is stubbed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Barq } from "../src/session.mjs";
import { RecipeBook, recipeKey, fingerprint } from "../src/recipes.mjs";

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
  // a replay is never taken on trust: what it did has to show on the page. Here the goal says
  // plainly what it makes, so the page answers for itself and nothing is asked at all.
  const n = jev(b, () => finished(0.8));
  r = await b.do("Add the todo", { values: { text: "buy milk" } });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, "replayed");
  assert.deepEqual([n.decide, n.call], [0, 0], "the page showed the new item, so no question was needed");
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

  // the search page again: without the result's fragment, which makes it another page
  await b.page.goto("about:blank");
  await b.page.setContent(page);
  const n = jev(b, () => finished(0.95));
  const r = await b.do("Search and open the result", { values: { q: "dogs" } });
  assert.equal(r.recipe, "replayed");
  assert.equal(n.decide, 1);
  assert.equal(await b.page.inputValue("input"), "dogs");
  assert.equal(await b.page.evaluate(() => location.hash), "#dogs", "the link for the new value, not the recorded one");
  const saved = readFileSync(file, "utf8");
  assert.doesNotMatch(saved, /cats|dogs/);
});

test("the recipe file holds none of the page's words, and still replays", async t => {
  const PAGES = {
    "/kumquat/orchard": `<h1>Quokka Marzipan Observatory</h1><label>Pelican <input placeholder="Tangerine"></label>
      <button>Gondola</button><select aria-label="Basalt"><option>Walrus</option><option>Obsidian</option><option>Nectarine</option></select>
      <p>Harbour Mosaic <a href="/kumquat/lagoon">Saffron</a></p>`,
    "/kumquat/lagoon": `<h1>Lagoon Cormorant</h1>`,
  };
  const { b, file } = await session(t, "");
  await b.page.route("https://words.test/**", route => route.fulfill({ contentType: "text/html", body: PAGES[new URL(route.request().url()).pathname] ?? "" }));
  await b.open("https://words.test/kumquat/orchard");
  const words = await b.page.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll("*")].flatMap(e => [...e.attributes].map(a => a.value))].join(" "));
  jev(b, (page, history) => !did(history, "Pelican") ? answer({ tool: "type", target: el(page, e => e.label === "Pelican"), value: "note" })
    : !did(history, "Gondola") ? answer({ target: el(page, e => e.text === "Gondola") }) : finished(0.95));
  assert.equal((await b.do("Write the zebracorn", { values: { note: "zebracorn" } })).recipe, "recorded");
  const stone = (page, history) => page.url.endsWith("/lagoon") ? finished(0.95)
    : !history.some(h => h.action === "select") ? answer({ tool: "select", target: el(page, e => e.tag === "select") }) : answer({ target: el(page, e => e.text === "Saffron") });
  jev(b, stone, () => ({ opt: { choice: "1" } }));
  assert.equal((await b.do("Pick the obsidian stone")).recipe, "recorded");

  const saved = readFileSync(file, "utf8");
  const pageWords = new Set(`${words} ${await b.page.evaluate(() => document.body.innerText)} kumquat orchard lagoon words.test zebracorn Write Pick obsidian stone`.match(/[\p{L}.]{4,}/gu).map(w => w.toLowerCase()));
  assert.deepEqual([...pageWords].filter(w => saved.toLowerCase().includes(w)), []);

  // replays from the fingerprints alone: the same option, then the same link
  await b.open("https://words.test/kumquat/orchard");
  const n = jev(b, () => finished(0.95));
  const r = await b.do("Pick the obsidian stone");
  assert.equal(r.recipe, "replayed");
  assert.equal(n.decide, 1);
  assert.equal(r.actions[0].option, "Obsidian");
  assert.equal(new URL(b.page.url()).pathname, "/kumquat/lagoon");
});

test("a recipe is tied to its page's query and fragment, and not to tracking parameters", async t => {
  const { b } = await session(t, "");
  await b.page.route("https://items.test/**", route => route.fulfill({ contentType: "text/html", body: `<button onclick="document.body.dataset.added = 1">Add to list</button>` }));
  const add = (page, history) => !did(history, "Add to list") ? answer({ target: el(page, e => e.text === "Add to list") }) : finished(0.95);
  const added = () => b.page.evaluate(() => document.body.dataset.added);
  await b.open("https://items.test/item?id=A");
  jev(b, add);
  assert.equal((await b.do("Add the item to my list")).recipe, "recorded");
  // item B has the same controls, but nothing recorded on item A runs there: Jev decides
  await b.open("https://items.test/item?id=B");
  let n = jev(b, () => finished(0.95));
  let r = await b.do("Add the item to my list");
  assert.equal(r.recipe, undefined);
  assert.equal(n.decide, 1);
  assert.equal(await added(), undefined);
  // item A through a tracked link is item A
  await b.open("https://items.test/item?utm_source=x&id=A");
  n = jev(b, () => finished(0.95));
  r = await b.do("Add the item to my list");
  assert.equal(r.recipe, "replayed");
  assert.equal(n.decide, 1);
  assert.equal(await added(), "1");
  // a fragment tells pages apart the same way
  await b.open("https://items.test/app#tenant=A");
  jev(b, add);
  assert.equal((await b.do("Add the item to my list")).recipe, "recorded");
  await b.open("https://items.test/app#tenant=B");
  await b.page.reload();
  jev(b, () => finished(0.95));
  assert.equal((await b.do("Add the item to my list")).recipe, undefined);
  assert.equal(await added(), undefined);
});

test("a step in a frame replays only in a frame at the same address", async t => {
  const { b } = await session(t, "");
  let widget = "pay";
  await b.page.route("https://frames.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    route.fulfill({ contentType: "text/html", body: path === "/checkout" ? `<p>Checkout</p><iframe src="/widgets/${widget}" width=300 height=80></iframe>`
      : `<button onclick="parent.document.body.dataset.clicked = '${path}'">Continue</button>` });
  });
  const clicked = () => b.page.evaluate(() => document.body.dataset.clicked);
  await b.open("https://frames.test/checkout");
  jev(b, (page, history) => !did(history, "Continue") ? answer({ target: el(page, e => e.text === "Continue") }) : finished(0.95));
  assert.equal((await b.do("Continue the checkout")).recipe, "recorded");
  await b.open("https://frames.test/checkout");
  let n = jev(b, () => finished(0.95));
  assert.equal((await b.do("Continue the checkout")).recipe, "replayed");
  assert.equal(n.decide, 1);
  assert.equal(await clicked(), "/widgets/pay");
  // the page now embeds another widget with the same button: it isn't clicked for the recorded one
  widget = "ads";
  await b.open("https://frames.test/checkout");
  n = jev(b, () => finished(0.95));
  const r = await b.do("Continue the checkout");
  assert.equal(r.recipe, undefined);
  assert.deepEqual(r.actions, []);
  assert.equal(await clicked(), undefined);
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
  assert.deepEqual(book.get(key).steps.map(s => s.target.name), ["Next", "Done"].map(t => fingerprint(t)));
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
  assert.deepEqual(book.get(recipeKey("Buy the mug", "https://shop.test/mug")).steps.map(s => s.target.name), ["Add to cart", "Pay now"].map(t => fingerprint(t)));
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

test("a flow held at a confirmation stop goes on only with the same values on the same address", async t => {
  const MAIL = `<input placeholder="To"><button onclick="document.body.dataset.sent = (document.body.dataset.sent ?? '') + document.querySelector('input').value + ';'">Send</button>`;
  const { b } = await session(t, MAIL);
  const send = (page, history) => !did(history, "To") ? answer({ tool: "type", target: el(page, e => e.placeholder === "To"), value: "recipient" })
    : !did(history, "Send") ? answer({ target: el(page, e => e.text === "Send") }) : finished(0.95);
  const sent = () => b.page.evaluate(() => document.body.dataset.sent);
  jev(b, send);
  assert.equal((await b.do("Send the message", { values: { recipient: "alice" }, allowIrreversible: true })).recipe, "recorded");

  // the replay types alice and stops before Send
  await b.page.setContent(MAIL);
  jev(b, () => finished(0.95));
  assert.equal((await b.do("Send the message", { values: { recipient: "alice" } })).status, "needs_confirmation");
  assert.equal(await b.page.inputValue("input"), "alice");
  // allowed, but for bob: nothing of the held flow replays, Jev starts over
  let n = jev(b, send);
  let r = await b.do("Send the message", { values: { recipient: "bob" }, allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, undefined);
  assert.deepEqual(n.histories[0], []);
  assert.equal(await sent(), "bob;", "never the draft typed for alice");

  // the same values on another address (another draft): no going on either
  await b.page.setContent(MAIL);
  jev(b, () => finished(0.95));
  assert.equal((await b.do("Send the message", { values: { recipient: "alice" } })).status, "needs_confirmation");
  await b.page.evaluate(() => { location.hash = "draft=2"; });
  n = jev(b, send);
  r = await b.do("Send the message", { values: { recipient: "alice" }, allowIrreversible: true });
  assert.equal(r.recipe, undefined);
  assert.deepEqual(n.histories[0], []);
  assert.equal(await sent(), "alice;");
});

test("a goal that counts from what the page has now is neither replayed nor recorded", async t => {
  const MORE = `${"<button>Result</button>".repeat(5)}<button onclick="for (let k = 0; k < 5; k++) this.insertAdjacentHTML('beforebegin', '<button>Result</button>')">Load more</button>`;
  const { b } = await session(t, MORE);
  // Jev: the goal wants 5 more "Result" buttons than the page has, and the next action is "Load more"
  const counts = () => {
    b.call = async (state, questions) => {   // stands in for Jev
      const answers = {};
      for (const name of Object.keys(questions)) { const q = questions[name];
        if (name === "counts") answers.counts = { noul: 0.95 };
        else if (name === "cmp") answers.cmp = { choice: "at least", probabilities: { "at least": 0.9 } };
        else if (name === "relative") answers.relative = { choice: "more", probabilities: { more: 0.9 } };
        else if (name === "kind") answers.kind = { choice: 'button "Result"', probabilities: { 'button "Result"': 0.9 } };
        else if (q.type === "noul") answers[name] = { noul: 0.9 };
      }
      return { answers };
    };
    b.decide = async page => answer({ target: el(page, e => e.text === "Load more"), done: 0.9 });
  };
  const results = () => b.page.$$eval("button", l => l.filter(x => x.textContent === "Result").length);
  counts();
  let r = await b.do("Load 5 more results");
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, undefined);
  assert.equal(await results(), 10);
  await b.page.setContent(MORE);
  counts();
  r = await b.do("Load 5 more results");
  assert.equal(r.status, "done", r.info);
  assert.equal(r.recipe, undefined);
  assert.equal(await results(), 10, "5 more than the page had when the step started");
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
  // two actions, and then the page itself shows the item rather than a round being spent on it
  assert.equal(n.decide, 2);
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

test("a decision about an element that left the page while it was being made is not acted on", async t => {
  const { b } = await session(t, `<button onclick="document.body.dataset.clicked = 'old'">Continue</button>`);
  let first = true;
  jev(b, async (page, history) => {
    const target = el(page, e => e.text === "Continue");
    if (first) {
      first = false;
      // the page redraws the button while Jev is still deciding
      await b.page.evaluate(() => { document.body.innerHTML = `<button onclick="document.body.dataset.clicked = 'new'">Continue</button>`; });
      return answer({ target });
    }
    return did(history, "Continue") && history.some(h => h.action === "click") ? finished(0.95) : answer({ target });
  });
  const started = Date.now();
  const r = await b.do("Press continue", { recipe: false });
  assert.equal(r.status, "done", r.info);
  assert.equal(await b.page.evaluate(() => document.body.dataset.clicked), "new", "the button that is on the page now");
  assert.ok(r.actions.some(h => h.event?.includes("left the page")), "said why it looked again");
  assert.ok(Date.now() - started < 3000, "no waiting out a click on an element that is gone");
});
