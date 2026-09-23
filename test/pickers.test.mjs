// Offline tests: fields that take their value from a list, pickers that keep their own Done button,
// and a goal that ends by naming a button. No Jev calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Barq } from "../src/session.mjs";

// A field that shows its suggestions a moment after each keystroke, as most do. It names a list
// through aria-controls that is not the one it draws, which is the case the lookup has to survive.
const SUGGESTING = (attrs, options) => `<!doctype html><body>
<div id="elsewhere"></div>
<input id="field" ${attrs} aria-controls="elsewhere" autocomplete="off">
<ul id="list" role="listbox"></ul>
<script>
  const field = document.getElementById("field"), list = document.getElementById("list");
  const OPTIONS = ${JSON.stringify(options)};
  field.addEventListener("input", () => setTimeout(() => {
    const typed = field.value.toLowerCase();
    list.innerHTML = typed ? OPTIONS.map(o => '<li role="option">' + o + '</li>').join("") : "";
  }, 200));
  list.addEventListener("click", e => {
    const li = e.target.closest("[role=option]");
    if (li) { field.value = li.textContent; field.dataset.chosen = "yes"; list.innerHTML = ""; }
  });
</script></body>`;

const PICKERS = `<!doctype html><body>
<div role="dialog" id="calendar">
  <div role="grid"><div role="gridcell" id="day" tabindex="0" style="cursor:pointer" onclick="this.dataset.picked = 1"><span aria-label="Tuesday, October 20, 2026">20</span></div></div>
  <button id="done">Done</button>
</div>
<div role="dialog" id="plain"><input id="note"><button>OK</button></div>
<div role="alertdialog" id="sure"><div role="option" id="choice">Keep</div><button>OK</button></div>
<button id="close"><svg aria-label="Close dialog" width="10" height="10"></svg>x</button>
</body>`;

let browser, b;
before(async () => {
  browser = await chromium.launch({ headless: true });
  b = await Barq.launch({ browser });
});
after(async () => { await b.close(); await browser?.close(); });

const typeInto = async (value) => {
  await b.typeInto(b.page.locator("#field"), { value }, { timeout: 4000 });
  return { value: await b.page.inputValue("#field"), chosen: await b.page.getAttribute("#field", "data-chosen"), unchosen: b.typedUnchosen };
};

test("a list field takes the suggestion that starts with what was typed, from whichever list shows it", async () => {
  await b.page.setContent(SUGGESTING('role="combobox" aria-label="Where to?"', ["Lisbon, Portugal", "Lisbon, Maine", "Humberto Delgado Airport"]));
  const got = await typeInto("Lisbon");
  assert.equal(got.value, "Lisbon, Portugal", "the first suggestion that fits, in the site's order");
  assert.equal(got.chosen, "yes");
  assert.equal(got.unchosen, false);
});

test("nothing that starts with the text: nothing is chosen, and the step is told so", async () => {
  await b.page.setContent(SUGGESTING('role="combobox" aria-label="Where to?"', ["Porto, Portugal"]));
  const got = await typeInto("Lisbon");
  assert.equal(got.value, "Lisbon");
  assert.equal(got.chosen, null);
  assert.equal(got.unchosen, true);
});

test("a query box keeps what was typed rather than taking a suggested query", async () => {
  for (const attrs of ['type="search" role="combobox"', 'role="combobox" name="q"', 'role="combobox" aria-label="Search the shop"']) {
    await b.page.setContent(SUGGESTING(attrs, ["lisbon weather", "lisbon flights"]));
    const got = await typeInto("lisbon");
    assert.equal(got.value, "lisbon", attrs);
    assert.equal(got.chosen, null, attrs);
  }
});

test("a picker's own Done is found for a control inside it, and never another dialog's OK", async () => {
  await b.page.setContent(PICKERS);
  const done = await b.unconfirmed(await b.page.$("#day"));
  assert.equal(await done.evaluate(el => el.id), "done");
  assert.equal(await b.unconfirmed(await b.page.$("#note")), null, "a dialog that picks nothing has no Done to press");
  assert.equal(await b.unconfirmed(await b.page.$("#choice")), null, "an are-you-sure dialog is never answered for the user");
  await b.page.evaluate(() => document.getElementById("calendar").remove());
  assert.equal(await b.unconfirmed(done), null, "a picker that has closed has nothing left to confirm");
});

test("a calendar day is listed with its date, and a short label that isn't one is left alone", async () => {
  await b.page.setContent(PICKERS);
  const page = await b.snapshot();   // as it stands now
  assert.ok(page.elements.some(e => e.text === "20" && e.label === "Tuesday, October 20, 2026"));
  assert.ok(page.elements.some(e => e.text === "x" && !e.label), "'x' is not a word of 'Close dialog'");
});

test("a goal that ends by naming a button safe to press twice picks that button, and only that", () => {
  const page = els => ({ elements: els.map((e, i) => ({ i, tag: "button", ...e })) });
  const search = page([{ text: "Search" }, { text: "Done. Search for one-way flights" }, { text: "Explore" }]);
  assert.equal(b.buttonGoalEndsWith(search, "Set a one way trip to Lisbon, and run the search")?.text, "Search");
  assert.equal(b.buttonGoalEndsWith(page([{ text: "Submit" }]), "Fill in the form and submit it"), null, "a second submit sends twice");
  assert.equal(b.buttonGoalEndsWith(page([{ text: "Search" }, { text: "Search" }]), "then search"), null, "two that fit is no fit");
  assert.equal(b.buttonGoalEndsWith(page([{ text: "Search", disabled: true }]), "and search"), null);
  assert.equal(b.buttonGoalEndsWith(search, "Search for Lisbon, then open the first result"), null, "only the last clause counts");
});

test("Enter straight after typing goes to the field typed into, not a checkbox Jev leaned toward", () => {
  const page = { elements: [
    { i: 1, tag: "input:text", placeholder: "What needs to be done?" },
    { i: 3, tag: "input:checkbox", label: "Toggle Todo" },
    { i: 5, tag: "input:submit", text: "Add" },
  ] };
  const answers = target => ({ tool: { choice: "press_enter", probabilities: { press_enter: 0.97 } }, target: { probabilities: target } });
  const typed = 'input:text "What needs to be done?"';
  const r = b.resolve(page, answers({ 3: 0.55, 1: 0.27 }), { second: "walk the dog" }, { typedInto: typed });
  assert.deepEqual([r.tool, r.target, r.p_target, r.target_by], ["press_enter", 1, 1, "the field just typed into"]);
  // a button that sends the form is still somewhere Enter can go
  assert.equal(b.resolve(page, answers({ 5: 0.8, 1: 0.1 }), {}, {}).target, 5);
  // without typing just before, a checkbox is no place for Enter: the likeliest field takes it
  assert.equal(b.resolve(page, answers({ 3: 0.6, 1: 0.3 }), {}, {}).target, 1);
});

test("keys never go to a button that took the focus from the field; a field that takes over gets them", async () => {
  await b.page.setContent(`<input id="field"><button id="bin" onclick="document.body.dataset.pressed = 1">Delete</button>
    <script>document.getElementById("field").addEventListener("focus", () => document.getElementById("bin").focus());</script>`);
  await b.typeInto(b.page.locator("#field"), { value: "a b c" }, { timeout: 4000 });
  assert.equal(await b.page.getAttribute("body", "data-pressed"), null, "the space in the text pressed nothing");
  assert.equal(await b.page.inputValue("#field"), "a b c");

  await b.page.setContent(`<input id="field" placeholder="Search docs"><div id="overlay" hidden><input id="real"></div>
    <script>document.getElementById("field").addEventListener("focus", () => { overlay.hidden = false; real.focus(); });</script>`);
  await b.typeInto(b.page.locator("#field"), { value: "hooks" }, { timeout: 4000 });
  assert.equal(await b.page.inputValue("#real"), "hooks", "the search the page opened got the text");
});

test("with every value typed, a 'type' aimed at a radio is a click on that radio", () => {
  const page = { elements: [
    { i: 0, tag: "input:text", label: "Text input", value: "hello" },
    { i: 11, tag: "input:radio", label: "Checked radio" },
    { i: 12, tag: "input:radio", label: "Default radio" },
  ] };
  const answers = { tool: { choice: "type", probabilities: { type: 0.8 } }, target: { probabilities: { 12: 0.68, 11: 0.13, 0: 0.12 } } };
  const r = b.resolve(page, answers, { text_input: "hello" }, { entered: ["text_input"] });
  assert.deepEqual([r.tool, r.target], ["click", 12]);
  // a value still to type keeps the rule that finds it a field
  assert.equal(b.resolve(page, answers, { text_input: "hello", other: "x" }, { entered: ["text_input"] }).tool, "type");
});
