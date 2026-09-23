// Offline tests: the checks an answer from Jev passes before anything acts on it. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { malformed } from "../src/jev.mjs";

const questions = {
  done: { type: "noul", instructions: "?" },
  tool: { type: "choice", instructions: "?", criteria: { click: "…", type: "…", none: "…" } },
  target: { type: "choice", instructions: "?", criteria: { 3: null, 7: null } },
};
const good = { done: { noul: 0.12 }, tool: { choice: "click", probabilities: { click: 0.9, none: 0.1 } }, target: { choice: "7", probabilities: { 3: 0.2, 7: 0.8 } } };

test("a well-formed answer passes", () => {
  assert.equal(malformed(good, questions), null);
});

test("an answer out of shape is caught before anything acts on it", () => {
  assert.match(malformed({ ...good, done: undefined }, questions), /no answer to done/);
  assert.match(malformed({ ...good, done: { noul: 1.7 } }, questions), /done is not a probability/);
  assert.match(malformed({ ...good, done: { noul: NaN } }, questions), /done is not a probability/);
  assert.match(malformed({ ...good, tool: { choice: "drag", probabilities: { drag: 1 } } }, questions), /tool chose drag, which was not offered/);
  assert.match(malformed({ ...good, target: { choice: "7", probabilities: { 7: 0.8, 99: 0.2 } } }, questions), /target has probabilities for options that were not offered/);
});
