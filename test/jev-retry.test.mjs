// Offline: how the Jev client behaves when the service turns a request away. A local server stands
// in for TypeSafe; nothing leaves the machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

let server, hits = [], jev;
const ANSWER = JSON.stringify({ answers: { done: { noul: 0.2 } }, usage: { input_tokens: 10 } });
before(async () => {
  server = createServer((req, res) => {
    hits.push(Date.now());
    if (hits.length === 1) { res.writeHead(429, { "retry-after": "2", "content-type": "application/json" }); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(ANSWER);
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  process.env.JEV_API_URL = `http://127.0.0.1:${server.address().port}/`;
  process.env.TYPESAFE_API_KEY ||= "test-key";
  ({ jev } = await import("../src/jev.mjs"));
});
after(() => server.close());

test("a 429 that says when to come back is retried then, not sooner", async () => {
  const r = await jev({ page: {} }, { done: { type: "noul", instructions: "?" } });
  assert.equal(r.answers.done.noul, 0.2);
  assert.equal(hits.length, 2);
  assert.ok(hits[1] - hits[0] >= 1900, `came back after ${hits[1] - hits[0]} ms`);
});
