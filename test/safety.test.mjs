import { test } from "node:test";
import assert from "node:assert/strict";
import { commitsSomething } from "../src/safety.mjs";

const el = text => ({ tag: "button", text });

test("controls that pay, send, publish or delete are caught", () => {
  for (const t of ["Pay now", "Place your order", "Buy now", "Confirm purchase", "Send", "Post", "Publish", "Delete account", "Cancel subscription", "Transfer", "إرسال", "ادفع الآن", "حذف"]) {
    assert.ok(commitsSomething(el(t)), t);
  }
  assert.ok(commitsSomething({ tag: "input:text", placeholder: "Send a message" }), "Enter in a chat box sends");
  assert.equal(commitsSomething({ tag: "input:text", placeholder: "What needs to be done?", value: "buy milk" }), null, "typed content is not the control's wording");
});

test("everyday controls pass", () => {
  for (const t of ["Search", "Log in", "Continue", "Checkout", "Add to cart", "Next", "Filter results", "Send me a code", "Save draft", "Open panel", "Finish", ""]) {
    assert.equal(commitsSomething(el(t)), null, t);
  }
  assert.equal(commitsSomething(null), null);
});

test("clicking into a text field is never held back by its label, but Enter in one still is", () => {
  const body = { tag: "div[textbox]", label: "Post body text field" };
  assert.equal(commitsSomething(body, "click"), null, "a click puts the caret in the box");
  assert.equal(commitsSomething({ tag: "textarea", label: "Post title" }, "click"), null);
  assert.equal(commitsSomething({ tag: "div", editable: true, label: "Send a reply" }, "click"), null);
  assert.ok(commitsSomething({ tag: "input:text", placeholder: "Send a message" }, "press_enter"), "Enter in a chat box sends");
  assert.ok(commitsSomething({ tag: "button", text: "Post" }, "click"), "the Post button itself still is");
  assert.ok(commitsSomething({ tag: "input:submit", text: "Post" }, "click"), "and so is a submit input");
});

test("a link that opens a reply box isn't a send, and the button that sends still is", () => {
  assert.equal(commitsSomething({ tag: "a", text: "reply" }, "click"), null);
  assert.equal(commitsSomething({ tag: "span[link]", text: "Post" }, "click"), null);
  assert.ok(commitsSomething({ tag: "button", text: "Reply" }, "click"), "the composer's own Reply sends");
  assert.ok(commitsSomething({ tag: "a", text: "Send" }, "click"), "a link wired to send stays held");
  assert.ok(commitsSomething({ tag: "a", text: "Delete" }, "click"));
  assert.ok(commitsSomething({ tag: "a", text: "Buy now" }, "click"));
});
