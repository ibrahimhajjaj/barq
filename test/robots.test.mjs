// Offline: reading robots.txt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, allowed } from "../src/robots.mjs";

const url = path => `https://shop.example${path}`;

test("the longest rule wins, and Allow wins a tie", () => {
  const r = parseRobots("User-agent: *\nDisallow: /cart\nAllow: /cart/public\nDisallow: /*.pdf$\n");
  assert.equal(allowed(r, url("/cart/42")), false);
  assert.equal(allowed(r, url("/cart/public/1")), true);
  assert.equal(allowed(r, url("/docs/a.pdf")), false);
  assert.equal(allowed(r, url("/docs/a.pdf?x=1")), true, "$ ends the rule");
  assert.equal(allowed(r, url("/")), true);
});

test("a group naming our agent replaces the one for everyone, with its crawl delay", () => {
  const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: barq\nUser-agent: other\nDisallow: /private\nCrawl-delay: 5\n");
  assert.equal(allowed(r, url("/products")), true);
  assert.equal(allowed(r, url("/private/x")), false);
  assert.equal(r.delay, 5);
});

test("an empty or missing file allows everything", () => {
  assert.equal(allowed(parseRobots(""), url("/anything")), true);
  assert.equal(allowed(parseRobots("User-agent: *\nDisallow:\n"), url("/anything")), true);
});
