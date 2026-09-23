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

test("a button whose words change while Jev decides is not pressed on the old decision", async t => {
  const { b } = await session(t, `<button onclick="document.body.dataset.pressed = this.textContent">Continue</button>`);
  let round = 0;
  jev(b, async page => {
    const target = el(page, e => e.tag === "button");
    // the page relabels the button while Jev is still deciding about "Continue"
    if (round++ === 0) await b.page.evaluate(() => { document.querySelector("button").textContent = "Delete account"; });
    return answer({ target });
  });
  const r = await b.do("Continue to the next page", { recipe: false });
  assert.equal(r.status, "needs_confirmation", r.info);
  assert.equal(await b.page.evaluate(() => document.body.dataset.pressed ?? null), null, "nothing was pressed");
  assert.ok(r.actions.some(h => h.event?.includes('now says "Delete account"')), "it said why it looked again");
});

test("a browser check that lets the browser through by itself is waited out, not called blocked", async t => {
  const { b } = await session(t, `<title>Just a moment...</title><p>Checking your browser before accessing the shop.</p>
    <script>setTimeout(() => { document.title = "Shop"; document.body.innerHTML = "<button onclick=\\"this.textContent='Added'\\">Add to basket</button>"; }, 4000)</script>`);
  jev(b, (page, history) => {
    if (did(history, "Add to basket")) return finished(0.95);
    const add = page.elements.find(e => e.text === "Add to basket");
    return add ? answer({ target: add.i }) : { ...answer({ tool: "none" }), blocked: { noul: 0.9 } };
  });
  const r = await b.do("Add the item to the basket", { recipe: false });
  assert.equal(r.status, "done", r.info);
  assert.equal(await b.page.textContent("button"), "Added");
});

test("a real wall is still blocked", async t => {
  const { b } = await session(t, `<title>Access denied</title><p>You don't have permission to access this page.</p>`);
  jev(b, () => ({ ...answer({ tool: "none" }), blocked: { noul: 0.95 } }));
  const started = Date.now();
  const r = await b.do("Open the shop", { recipe: false });
  assert.equal(r.status, "blocked");
  assert.ok(Date.now() - started < 5000, "no wait for a page that isn't a browser check");
});

test("what the site's own code reported going wrong comes back with the step", async t => {
  const { b } = await session(t, `<button onclick="console.error('cart service unavailable'); throw new Error('addItem failed')">Add to basket</button>`);
  jev(b, (page, history) => did(history, "Add to basket") ? finished(0.95) : answer({ target: el(page, e => e.text === "Add to basket") }));
  const r = await b.do("Add the item to the basket", { recipe: false });
  assert.deepEqual(r.page_errors?.map(e => e.kind).sort(), ["console", "error"], JSON.stringify(r.page_errors));
  assert.ok(r.page_errors.some(e => e.text.includes("addItem failed")));
});

test("a step counts the Jev tokens it spent and what they cost", async t => {
  const { b } = await session(t, `<button>Go</button>`);
  jev(b, (page, history) => did(history, "Go") ? finished(0.95) : answer({ target: el(page, e => e.text === "Go") }));
  const decide = b.decide;
  b.decide = async (...a) => { b.stats.tokens += 5000; return decide(...a); };
  const r = await b.do("Press Go", { recipe: false });
  assert.equal(r.jev_tokens, 10000);
  assert.equal(r.jev_cost_usd, 0.00042);
});

test("a session kept to one site doesn't follow a link off it, and says so", async t => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.headers.host.startsWith("localhost") ? "<title>elsewhere</title><p>off the list</p>"
      : `<title>shop</title><a href="http://localhost:${server.address().port}/win">Claim your prize</a>`);
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const home = `http://127.0.0.1:${server.address().port}/`;
  const { b } = await session(t, "");
  await b.keepTo(["127.0.0.1"]);
  await b.open(home);
  jev(b, (page, history) => did(history, "Claim") ? finished(0.95) : answer({ target: el(page, e => e.text === "Claim your prize") }));
  const r = await b.do("Claim the prize", { recipe: false });
  assert.equal(r.status, "blocked", r.info);
  assert.match(r.info, /outside the sites this session may visit/);
  assert.equal(b.page.url(), home, "the tab stayed on the allowed site");
  await assert.rejects(b.open(`http://localhost:${server.address().port}/`), /outside the sites this session may visit/);
});

test("Jev split between look-alikes is asked again among just those before the step gives up", async t => {
  const { b } = await session(t, `<h2>Billing</h2><a href="#" onclick="document.body.dataset.opened='billing'">Edit</a>
    <h2>Shipping</h2><a href="#" onclick="document.body.dataset.opened='shipping'">Edit</a>`);
  const n = jev(b, (page, history) => {
    if (history.some(h => h.action === "click")) return finished(0.95);
    const [billing, shipping] = page.elements.filter(e => e.text === "Edit").map(e => e.i);
    return { ...answer({ target: billing }), target: { probabilities: { [billing]: 0.26, [shipping]: 0.25 } } };
  });
  let narrowed = null;
  b.call = async (state, questions) => {
    n.call++;
    if (!questions.target) return { answers: { complete: { noul: 0.9 }, q: { noul: 0.1 } } };
    narrowed = state.page.elements.map(e => e.under);
    const shipping = state.page.elements.find(e => e.under === "Shipping").i;
    return { answers: { target: { choice: String(shipping), probabilities: { [shipping]: 0.9, [state.page.elements.find(e => e.under === "Billing").i]: 0.1 } } } };
  };
  const r = await b.do("Edit the shipping address", { recipe: false });
  assert.equal(r.status, "done", r.info);
  assert.deepEqual(narrowed?.sort(), ["Billing", "Shipping"], "only the two it was split between were offered, each with its heading");
  assert.equal(await b.page.getAttribute("body", "data-opened"), "shipping");
});

test("still split after asking again, the step stops as ambiguous", async t => {
  const { b } = await session(t, `<a href="#">Edit</a><a href="#">Edit</a>`);
  const n = jev(b, page => {
    const [x, y] = page.elements.map(e => e.i);
    return { ...answer({ target: x }), target: { probabilities: { [x]: 0.26, [y]: 0.25 } } };
  });
  b.call = async (state, questions) => {
    n.call++;
    const [x, y] = state.page.elements.map(e => e.i);
    return { answers: questions.target ? { target: { choice: String(x), probabilities: { [x]: 0.52, [y]: 0.48 } } } : { complete: { noul: 0.9 } } };
  };
  const r = await b.do("Edit it", { recipe: false });
  assert.equal(r.status, "ambiguous");
});

const FORM = `<form><label>First name <input name="first"></label><label>Last name <input name="last"></label>
  <label>Email <input name="email"></label><label>Password <input type="password" name="pw"></label><button type="button">Sign up</button></form>`;
const LABELS = { first: "First name", last: "Last name", email: "Email", password: "Password" };

test("values Jev places with confidence all go in one round, each where it belongs", async t => {
  const { b } = await session(t, FORM);
  const values = { first: "Ada", last: "Lovelace", email: "ada@example.com" };
  const n = jev(b, (page, history) => {
    if (history.filter(h => h.action === "type").length >= 3) return finished(0.95);
    const field = name => el(page, e => e.label === LABELS[name]);
    const bind = (name, p = 0.95) => ({ choice: String(field(name)), probabilities: { [field(name)]: p } });
    return { ...answer({ tool: "type", target: field("first"), value: "first" }), bindKeys: ["first", "last", "email"],
      bind_0: bind("first"), bind_1: bind("last"), bind_2: bind("email") };
  });
  const r = await b.do("Fill in the sign-up form", { values, recipe: false });
  assert.equal(r.status, "done", r.info);
  assert.equal(n.decide, 1, "one Jev round placed all three");
  assert.deepEqual(r.rounds[0].filled, ["first", "last", "email"]);
  assert.deepEqual(await b.page.$$eval("input:not([type=password])", l => l.map(x => x.value)), ["Ada", "Lovelace", "ada@example.com"]);
});

test("a value Jev is unsure of, or two values claiming one field, are left to the usual one-at-a-time", async t => {
  const { b } = await session(t, FORM);
  const values = { first: "Ada", last: "Lovelace", email: "ada@example.com", password: "s3cret" };
  const typedPerRound = [];
  jev(b, (page, history) => {
    typedPerRound.push(history.filter(h => h.action === "type").length);
    const field = name => el(page, e => e.label === LABELS[name]);
    const bind = (name, p) => ({ choice: String(field(name)), probabilities: { [field(name)]: p } });
    if (typedPerRound.length > 1) return finished(0.95);
    return { ...answer({ tool: "type", target: field("first"), value: "first" }), bindKeys: ["first", "last", "email", "password"],
      bind_0: bind("first", 0.95), bind_1: bind("first", 0.9), bind_2: bind("email", 0.5), bind_3: bind("first", 0.99) };
  });
  await b.do("Fill in the sign-up form", { values, recipe: false });
  assert.deepEqual(typedPerRound, [0, 1], "nothing was filled in bulk; the round typed its one field");
});

test("an order placed once is not placed again when the step is run a second time", async t => {
  const { b } = await session(t, `<p>Basket: 1 item</p><button onclick="document.body.dataset.orders = (+document.body.dataset.orders || 0) + 1">Place order</button>`);
  const place = (page, history) => did(history, "Place order") ? finished(0.95) : answer({ target: el(page, e => e.text === "Place order"), irreversible: 0.9 });
  jev(b, place);
  let r = await b.do("Place the order", { recipe: false, allowIrreversible: true });
  assert.equal(r.status, "done", r.info);
  // the caller didn't see that answer (it timed out on their side) and asks again
  r = await b.do("Place the order", { recipe: false, allowIrreversible: true });
  assert.equal(r.status, "needs_confirmation");
  assert.match(r.info, /already pressed in this session/);
  assert.ok(r.pending.already_done_at);
  assert.equal(await b.page.getAttribute("body", "data-orders"), "1", "one order, not two");
});

test("a different page's button of the same name is its own action", async t => {
  const { b } = await session(t, "");
  jev(b, (page, history) => did(history, "Send") ? finished(0.95) : answer({ target: el(page, e => e.text === "Send"), irreversible: 0.9 }));
  const thread = n => `data:text/html,<title>thread ${n}</title><button onclick="document.body.dataset.sent = 1">Send</button>`;
  await b.open(thread(1));
  assert.equal((await b.do("Send it", { recipe: false, allowIrreversible: true })).status, "done");
  await b.open(thread(2));
  assert.equal((await b.do("Send it", { recipe: false, allowIrreversible: true })).status, "done");
});

// A form whose answer page says only that it arrived; with `stays`, the page's script stops the send.
async function sentForm(t, { stays = false } = {}) {
  const { b } = await session(t, "");
  await b.page.route("https://form.test/**", route => route.fulfill({ contentType: "text/html", body: new URL(route.request().url()).pathname === "/received"
    ? "<title>Done</title><h1>Received!</h1>"
    : `<form action="/received"${stays ? ' onsubmit="return false"' : ""}><label>Name <input name="name"></label><label>City <input name="city"></label><button>Submit</button></form>` }));
  await b.open("https://form.test/form");
  jev(b, (page, history) => {
    const typed = history.filter(h => h.action === "type").length;
    if (typed === 0) return answer({ tool: "type", target: el(page, e => e.label === "Name"), value: "name" });
    if (typed === 1) return answer({ tool: "type", target: el(page, e => e.label === "City"), value: "city" });
    if (!did(history, "Submit")) return answer({ target: el(page, e => e.text === "Submit") });
    return finished(0.55);   // leaning done, as Jev does on a page that shows none of the values
  });
  b.call = async () => ({ answers: { complete: { noul: 0.3 }, q: { noul: 0.3 } } });   // and the stricter check unsure
  return b.do("Fill in the name and city, then submit the form", { values: { name: "Ada", city: "Lisbon" }, recipe: false });
}

test("a form filled from the values and sent to a new page ends done, though the page shows none of them", async t => {
  const r = await sentForm(t);
  assert.equal(r.status, "done", r.info);
  assert.match(r.info, /the form was sent/);
});

test("a Submit that leaves the page where it was is still left for the caller to check", async t => {
  const r = await sentForm(t, { stays: true });
  assert.equal(r.status, "likely_done", r.info);
});

const CAPTCHA = `<title>Verify</title><p>Select all squares with traffic lights</p><button>Verify</button>`;
const shopOrWall = (page, history) => {
  if (did(history, "Add to basket")) return finished(0.95);
  const add = page.elements.find(e => e.text === "Add to basket");
  return add ? answer({ target: add.i }) : { ...answer({ tool: "none" }), blocked: { noul: 0.95 } };
};

test("a captcha in a browser someone can see is put in front of them, and the step goes on once they're past it", async t => {
  const { b } = await session(t, CAPTCHA);
  const seen = [];
  b.front = async () => { seen.push("front"); return async () => seen.push("back"); };
  jev(b, shopOrWall);
  // the person solves it a moment later
  setTimeout(() => b.page.setContent(`<button onclick="this.textContent='Added'">Add to basket</button>`).catch(() => {}), 4000);
  const r = await b.do("Add the item to the basket", { recipe: false, waitForUserS: 20 });
  assert.equal(r.status, "done", r.info);
  assert.deepEqual(seen, ["front", "back"], "brought forward once, given back when the step ended");
  assert.ok(r.actions.some(h => h.event?.includes("got past the check")));
});

test("a captcha nobody can see is handed back with how to let a person in; nothing waits", async t => {
  const { b } = await session(t, CAPTCHA);
  jev(b, shopOrWall);
  const started = Date.now();
  const r = await b.do("Add the item to the basket", { recipe: false, waitForUserS: 20 });
  assert.equal(r.status, "blocked");
  assert.match(r.info, /BARQ_ATTACH/);
  assert.ok(Date.now() - started < 8000);
});

// A contacts table with a form under it; `drops` makes the save lose the city.
const CONTACTS = drops => `<table><tr><th>Name</th><th>City</th></tr><tr><td>Grace</td><td>Arlington</td></tr></table>
  <label>Name <input id="n"></label><label>City <input id="c"></label>
  <button onclick="document.querySelector('table').insertAdjacentHTML('beforeend', '<tr><td>' + n.value + '</td><td>' + (${drops} ? '' : c.value) + '</td></tr>')">Save contact</button>`;
async function saveContact(t, drops) {
  const { b } = await session(t, CONTACTS(drops));
  jev(b, (page, history) => {
    const typed = history.filter(h => h.action === "type").length;
    if (typed === 0) return answer({ tool: "type", target: el(page, e => e.label === "Name"), value: "name" });
    if (typed === 1) return answer({ tool: "type", target: el(page, e => e.label === "City"), value: "city" });
    if (!did(history, "Save contact")) return answer({ target: el(page, e => e.text === "Save contact") });
    return finished(0.55);
  });
  b.call = async () => ({ answers: { complete: { noul: 0.3 }, q: { noul: 0.3 } } });
  return b.do("Fill in the contact form and save it", { values: { name: "Ada", city: "Lisbon" }, recipe: false });
}

test("a save read back as one new record holding the typed values ends done", async t => {
  const r = await saveContact(t, false);
  assert.equal(r.status, "done", r.info);
  assert.match(r.info, /one new record holding "Ada", "Lisbon"/);
});

test("a save whose new record lacks a typed value is left for the caller to check", async t => {
  const r = await saveContact(t, true);
  assert.equal(r.status, "likely_done", r.info);
});

test("data the page is still loading after a click is waited for before the step gives up", async t => {
  const { b } = await session(t, "");
  await b.page.route("https://slow.test/**", async route => {
    if (new URL(route.request().url()).pathname === "/data") { await new Promise(done => setTimeout(done, 7000)); return route.fulfill({ body: "Data loaded with AJAX get request." }); }
    return route.fulfill({ contentType: "text/html", body: `<button onclick="fetch('/data').then(r => r.text()).then(t => { document.getElementById('out').textContent = t })">Load data</button><p id="out"></p>` });
  });
  await b.open("https://slow.test/");
  jev(b, (page, history) => {
    if (page.text.includes("Data loaded")) return finished(0.95);
    return did(history, "Load data") ? answer({ tool: "none" }) : answer({ target: el(page, e => e.text === "Load data") });
  });
  const r = await b.do("Load the data and wait for it to appear", { recipe: false, timeoutMs: 40_000 });
  assert.equal(r.status, "done", r.info);
  assert.match(await b.page.textContent("#out"), /Data loaded/);
});

test("a page that takes a quarter of a minute to finish is waited on while Jev asks to wait", async t => {
  const { b } = await session(t, `<button onclick="setTimeout(() => { document.getElementById('out').textContent = 'Data calculated on the client side.' }, 12000)">Start</button><p id="out"></p>`);
  jev(b, (page, history) => page.text.includes("Data calculated") ? finished(0.95)
    : did(history, "Start") ? answer({ tool: "wait" }) : answer({ target: el(page, e => e.text === "Start") }));
  const r = await b.do("Start it and wait for the data", { recipe: false, maxActions: 20 });
  assert.equal(r.status, "done", r.info);
});

test("with the goal half met, a next step that may be hard to undo is held even under the usual line", async t => {
  const { b } = await session(t, `<p>Checkout: overview</p><button onclick="document.body.dataset.ordered = 1">Finish</button>`);
  jev(b, page => ({ ...answer({ target: el(page, e => e.text === "Finish"), done: 0.57, irreversible: 0.59 }) }));
  b.call = async () => ({ answers: { complete: { noul: 0.37 }, q: { noul: 0.37 } } });
  // as if one round went by already: the step continued to the overview
  const decide = b.decide; let first = true;
  b.decide = async (...x) => { const a = await decide(...x); if (first) { first = false; return { ...a, done: { noul: 0 }, done_change: { noul: 0 }, tool: { choice: "wait", probabilities: { wait: 0.9 } } }; } return a; };
  const r = await b.do("Fill in the checkout information and continue", { recipe: false });
  assert.equal(r.status, "likely_done", r.info);
  assert.equal(r.pending?.element, 'button "Finish"');
  assert.equal(await b.page.getAttribute("body", "data-ordered"), null, "the order was not placed");
});
