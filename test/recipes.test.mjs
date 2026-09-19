import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeBook, recipeKey, place, describe, findElement, fingerprint, matches } from "../src/recipes.mjs";

test("a recipe key ignores case, value contents, parameter order and tracking, not the query or fragment", () => {
  assert.equal(place("https://x.com/a/b/?q=1#top"), "https://x.com/a/b?q=1#top");
  assert.equal(place("https://x.com/item?utm_source=news&id=A&fbclid=z&gclid=y&mc_eid=1"), "https://x.com/item?id=A");
  assert.equal(place("https://x.com/s?q=buy+milk&b=2&a=1"), "https://x.com/s?a=1&b=2&q=buy milk");
  assert.equal(recipeKey("Log  In", "https://x.com/login", { password: "a", email: "b" }), recipeKey("log in", "https://x.com/login", { email: "c", password: "d" }));
  assert.notEqual(recipeKey("Log in", "https://x.com/login"), recipeKey("Log in", "https://y.com/login"));
  assert.notEqual(recipeKey("Open it", "https://x.com/item?id=A"), recipeKey("Open it", "https://x.com/item?id=B"));
  assert.notEqual(recipeKey("Open it", "https://x.com/app#tenant=A"), recipeKey("Open it", "https://x.com/app#tenant=B"));
  assert.equal(recipeKey("Open it", "https://x.com/item?id=A&lang=en"), recipeKey("Open it", "https://x.com/item?utm_source=x&lang=en&id=A"));
});

test("elements are found again by kind, name and surroundings, and ambiguity is no match", () => {
  const els = [
    { i: 0, tag: "button", text: "Delete", near: "walk the dog" },
    { i: 1, tag: "button", text: "Delete", near: "buy milk" },
    { i: 2, tag: "input:text", placeholder: "What needs to be done?" },
  ];
  assert.equal(findElement(describe(els[2]), els).i, 2);
  assert.equal(findElement(describe(els[1]), els).i, 1);
  assert.equal(findElement({ tag: "button", name: fingerprint("Delete"), near: fingerprint("call mum") }, els), null);
  assert.equal(findElement({ tag: "button", name: fingerprint("Save") }, els), null);
});

test("an element told apart from look-alikes is not taken for the one look-alike left", () => {
  const els = [{ i: 0, tag: "button", text: "Delete", near: "walk the dog" }, { i: 1, tag: "button", text: "Delete", near: "buy milk" }];
  const d = describe(els[1], els);
  assert.equal(d.alike, true);
  assert.equal(findElement(d, [els[0]]), null);
  assert.equal(findElement(d, [{ ...els[1], i: 5 }]).i, 5);
  assert.equal(findElement(describe(els[1], [els[1]]), [els[0]]).i, 0, "one that stood alone is found by its name");
});

test("descriptions hold fingerprints, and value contents are masked by name before they are taken", () => {
  const link = { i: 0, tag: "a", text: "Open cats", near: "Results for cats", href: "/r/cats" };
  const d = describe(link, [link], { q: "cats", n: "1" });
  assert.doesNotMatch(JSON.stringify(d), /Open|Results|cats|\/r\//);
  assert.deepEqual(d, { tag: "a", name: fingerprint("Open {q}"), near: fingerprint("Results for {q}"), href: fingerprint("/r/{q}") });
  // replayed with another value, the element for that value matches, and the one for the old doesn't
  const now = [{ ...link, i: 1 }, { i: 2, tag: "a", text: "Open dogs", near: "Results for dogs", href: "/r/dogs" }];
  assert.equal(findElement(d, now, { q: "dogs" }).i, 2);
  // text that happens to equal a value still matches as it reads
  assert.ok(matches("Search", fingerprint("Search"), { q: "Search" }));
  assert.equal(fingerprint(" Pay  now "), fingerprint("Pay now"));
  assert.match(fingerprint("Pay now"), /^[0-9a-f]{16}$/);
});

test("a recipe file in an older form is dropped, not used and not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "barq-recipes-"));
  const file = join(dir, "recipes.json");
  writeFileSync(file, JSON.stringify({
    "https://x.com/login :: log in :: email": { steps: [{ tool: "click", at: "https://x.com/login", target: { tag: "button", name: "Log in" } }], saved: "2026-01-01T00:00:00.000Z", replays: 0, misses: 0 },
    // fingerprinted, but from when a page's query and fragment weren't part of which page it is
    [recipeKey("open it", "https://x.com/item")]: { v: 2, steps: [{ tool: "click", at: fingerprint("https://x.com/item"), target: { tag: "button", name: fingerprint("Open") } }], saved: "2026-01-01T00:00:00.000Z", replays: 0, misses: 0 },
  }));
  const book = new RecipeBook({ file });
  assert.equal(book.get("https://x.com/login :: log in :: email"), null);
  assert.equal(book.get(recipeKey("open it", "https://x.com/item")), null);
  assert.doesNotMatch(readFileSync(file, "utf8"), /Log in|x\.com|"v": 2/);
  for (const junk of ["[1, 2]", "null", "not json"]) { writeFileSync(file, junk); assert.equal(new RecipeBook({ file }).get("k"), null); }
  rmSync(dir, { recursive: true, force: true });
});

test("the book persists, merges with other writers, and drops recipes that keep missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-recipes-"));
  const file = join(dir, "recipes.json");
  const a = new RecipeBook({ file }), b = new RecipeBook({ file });
  a.put("k1", [{ tool: "click", target: { tag: "button", name: "Go" } }]);
  b.put("k2", [{ tool: "click", target: { tag: "button", name: "Stop" } }]);
  assert.ok(new RecipeBook({ file }).get("k1") && new RecipeBook({ file }).get("k2"), "neither writer lost the other's recipe");
  for (let n = 0; n < 3; n++) a.note("k1", { missed: true });
  assert.equal(a.get("k1"), null);
  assert.equal(new RecipeBook({ file: null }).get("k2"), null);
  rmSync(dir, { recursive: true, force: true });
});
