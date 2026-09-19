import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeBook, recipeKey, place, describe, findElement, maskValues, fillValues } from "../src/recipes.mjs";

test("a recipe key ignores query, fragment, case and value contents", () => {
  assert.equal(place("https://x.com/a/b/?q=1#top"), "https://x.com/a/b");
  assert.equal(recipeKey("Log  In", "https://x.com/login?next=/", { password: "a", email: "b" }), recipeKey("log in", "https://x.com/login", { email: "c", password: "d" }));
  assert.notEqual(recipeKey("Log in", "https://x.com/login"), recipeKey("Log in", "https://y.com/login"));
});

test("elements are found again by kind, name and surroundings, and ambiguity is no match", () => {
  const els = [
    { i: 0, tag: "button", text: "Delete", near: "walk the dog" },
    { i: 1, tag: "button", text: "Delete", near: "buy milk" },
    { i: 2, tag: "input:text", placeholder: "What needs to be done?" },
  ];
  assert.equal(findElement(describe(els[2]), els).i, 2);
  assert.equal(findElement(describe(els[1]), els).i, 1);
  assert.equal(findElement({ tag: "button", name: "Delete", near: "call mum" }, els), null);
  assert.equal(findElement({ tag: "button", name: "Save" }, els), null);
});

test("an element told apart from look-alikes is not taken for the one look-alike left", () => {
  const els = [{ i: 0, tag: "button", text: "Delete", near: "walk the dog" }, { i: 1, tag: "button", text: "Delete", near: "buy milk" }];
  const d = describe(els[1], els);
  assert.equal(d.alike, true);
  assert.equal(findElement(d, [els[0]]), null);
  assert.equal(findElement(d, [{ ...els[1], i: 5 }]).i, 5);
  assert.equal(findElement(describe(els[1], [els[1]]), [els[0]]).i, 0, "one that stood alone is found by its name");
});

test("value contents become their names in a step, and replay fills in the current ones", () => {
  const step = { tool: "click", at: "https://x.com/search/cats", target: { tag: "a", name: "Open cats", near: "Results for cats", href: "/r/cats" } };
  const masked = maskValues(step, { q: "cats", n: "1" });
  assert.deepEqual(masked, { tool: "click", at: "https://x.com/search/{q}", target: { tag: "a", name: "Open {q}", near: "Results for {q}", href: "/r/{q}" } });
  assert.deepEqual(fillValues(masked, { q: "dogs" }).target, { tag: "a", name: "Open dogs", near: "Results for dogs", href: "/r/dogs" });
  assert.equal(fillValues(masked, {}).target.name, "Open {q}");
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
