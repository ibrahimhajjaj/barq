// Offline: what a step's result carries back to the MCP caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepEnvelope } from "../src/envelope.mjs";

test("the site's own errors reach the caller", () => {
  const out = stepEnvelope({ status: "stuck", actions: [], page_errors: [{ kind: "error", text: "addItem failed" }] });
  assert.deepEqual(out.page_errors, [{ kind: "error", text: "addItem failed" }]);
});
