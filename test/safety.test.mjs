import { test } from "node:test";
import assert from "node:assert/strict";
import { commitsSomething } from "../src/safety.mjs";

const el = text => ({ tag: "button", text });

test("controls that pay, send, publish or delete are caught", () => {
  for (const t of ["Pay now", "Place your order", "Buy now", "Confirm purchase", "Send", "Post", "Publish", "Delete account", "Cancel subscription", "Transfer", "إرسال", "ادفع الآن", "حذف"]) {
    assert.ok(commitsSomething(el(t)), t);
  }
  assert.ok(commitsSomething({ tag: "input:text", placeholder: "Send a message" }), "Enter in a chat box sends");
});

test("everyday controls pass", () => {
  for (const t of ["Search", "Log in", "Continue", "Checkout", "Add to cart", "Next", "Filter results", "Send me a code", "Save draft", "Open panel", "Finish", ""]) {
    assert.equal(commitsSomething(el(t)), null, t);
  }
  assert.equal(commitsSomething(null), null);
});
