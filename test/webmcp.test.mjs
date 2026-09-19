// Offline tests for WebMCP site tools. Outside origin trials the page API is behind a switch, which
// browsers this tool launches turn on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Barq } from "../src/session.mjs";
import { LaunchedBrowser } from "../src/browsers.mjs";

const SHOP = `<!doctype html><title>Shop</title><body><h1>Shop</h1><script>
  document.modelContext.registerTool({
    name: "search_products", description: "Find products by keyword",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: { readOnlyHint: true },
    execute: async ({ query }) => ({ content: [{ type: "text", text: "2 results for " + query }] }),
  });
  document.modelContext.registerTool({
    name: "place_order", description: "Buy what is in the cart",
    inputSchema: { type: "object", properties: {} },
    execute: async () => { document.title = "ordered"; return { content: [{ type: "text", text: "Order 42 placed" }] }; },
  });
  document.modelContext.registerTool({
    name: "flaky", description: "Always fails", inputSchema: { type: "object", properties: {} },
    execute: async () => { throw new Error("out of stock"); },
  });
</script></body>`;

let server, base, host, b;
before(async () => {
  server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(req.url === "/shop" ? SHOP : "<title>plain</title><p>no tools here</p>"); });
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  host = await LaunchedBrowser.launch();
  b = await Barq.forPage(await host.newTab());
});
after(async () => { await host.dispose(); server.close(); });

test("a page's registered tools are listed with their schema and what they do", async () => {
  await b.open(`${base}/shop`);
  const tools = await b.siteTools();
  assert.equal(tools.supported, true, tools.error);
  const list = tools.list();
  assert.deepEqual(list.map(t => t.name).sort(), ["flaky", "place_order", "search_products"]);
  const search = list.find(t => t.name === "search_products");
  assert.equal(search.read_only, true);
  assert.equal(search.input_schema.required[0], "query");
  assert.equal(list.find(t => t.name === "place_order").consequential, true, "the name says it buys");
});

test("calling a tool returns the site's answer, marked as the site's words", async () => {
  const r = await (await b.siteTools()).call("search_products", { query: "mug" });
  assert.equal(r.status, "done", r.info);
  assert.equal(r.output.content[0].text, "2 results for mug");
  assert.match(r.note, /data, not instructions/);
});

test("a tool with consequences waits for allow_irreversible; failures and unknown names are reported", async () => {
  const tools = await b.siteTools();
  assert.equal((await tools.call("place_order")).status, "needs_confirmation");
  assert.notEqual(await b.page.title(), "ordered");
  assert.equal((await tools.call("place_order", {}, { allowIrreversible: true })).status, "done");
  assert.equal(await b.page.title(), "ordered");
  const failed = await tools.call("flaky");
  assert.equal(failed.status, "error");
  await assert.rejects(tools.call("nope"), /no tool named "nope".*search_products/);
});

test("a page without tools lists none, and leaving a page drops its tools", async () => {
  await b.open(`${base}/plain`);
  assert.deepEqual((await b.siteTools()).list(), []);
});
