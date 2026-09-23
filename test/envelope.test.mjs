// Offline: what a step's result carries back to the MCP caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepEnvelope } from "../src/envelope.mjs";

test("the site's own errors reach the caller", () => {
  const out = stepEnvelope({ status: "stuck", actions: [], page_errors: [{ kind: "error", text: "addItem failed" }] });
  assert.deepEqual(out.page_errors, [{ kind: "error", text: "addItem failed" }]);
});

test("a step says what it cost in Jev tokens and dollars", () => {
  const out = stepEnvelope({ status: "done", actions: [], jev_calls: 3, jev_tokens: 9000, jev_cost_usd: 0.000378 });
  assert.equal(out.jev_tokens, 9000);
  assert.equal(out.jev_cost_usd, 0.000378);
});
