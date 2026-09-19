// Offline tests: secrets stay out of Jev's view, out of results, and are resolved only when typed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { isSecret, forJev, resolveValue } from "../src/secrets.mjs";
import { JevBrowser } from "../src/session.mjs";
import { formatPage } from "../src/page-model.mjs";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(() => browser.close());

test("secret names and references are recognised; ordinary values are not", () => {
  for (const [k, v] of [["password", "x"], ["new_pwd", "x"], ["pin", "1234"], ["otp", "1"], ["api_token", "x"], ["card_number", "x"], ["email", "keychain:mail"], ["user", "autofill"]]) assert.ok(isSecret(k, v), k);
  for (const [k, v] of [["email", "a@b.com"], ["shipping_city", "Cairo"], ["todo", "walk the dog"], ["query", "flaky screenshot"]]) assert.ok(!isSecret(k, v), k);
  assert.deepEqual(forJev({ email: "a@b.com", password: "hunter22", site: "bw:github.com" }), { email: "a@b.com", password: "(a secret value, hidden)", site: "(a secret value, hidden)" });
});

test("references resolve at the last moment: env, keychain, Bitwarden, with clear errors", async () => {
  assert.equal(await resolveValue("plain text"), "plain text");
  assert.equal(await resolveValue("env:JEV_TEST_SECRET", { env: { JEV_TEST_SECRET: "s3" } }), "s3");
  await assert.rejects(resolveValue("env:NOPE", { env: {} }), /not set/);
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return cmd === "security" ? "kc-secret\n" : "bw-secret\n"; };
  assert.equal(await resolveValue("keychain:github/me", { run }), "kc-secret");
  assert.equal(await resolveValue("bw:github.com", { run }), "bw-secret");
  assert.equal(await resolveValue("bw:work/github.com/totp", { run }), "bw-secret");
  assert.deepEqual(calls, ["security find-generic-password -s github -a me -w", "bw get password github.com", "bw get totp work/github.com"]);
  await assert.rejects(resolveValue("keychain:missing", { run: async () => { throw new Error("44"); } }), /has no item/);
  await assert.rejects(resolveValue("bw:x", { run: async () => { throw Object.assign(new Error("spawn bw ENOENT"), { code: "ENOENT" }); } }), /isn't installed/);
});

test("what is typed into a password field never comes back from the page, only that it is filled", async () => {
  const b = await JevBrowser.launch({ browser });   // shares the one Chromium
  await b.page.setContent(`<label>Email <input id=e name=email></label><label>Password <input id=p type=password name=pw></label>
    <label>One-time code <input id=o autocomplete=one-time-code></label><label>Shipping <input id=s name=shipping_pin_code></label>`);
  await b.page.fill("#e", "a@b.com"); await b.page.fill("#p", "hunter22"); await b.page.fill("#o", "123456"); await b.page.fill("#s", "11511");
  const snap = await b.snapshot();
  const text = JSON.stringify(snap) + formatPage(snap);
  assert.doesNotMatch(text, /hunter22|123456/);
  assert.equal(snap.elements.find(e => e.label === "Password").filled, true);
  assert.equal(snap.elements.find(e => e.label === "Email").value, "a@b.com");
  await b.close();
});

test("Jev sees value names, the field gets the real value, and results carry names only", async () => {
  const b = await JevBrowser.launch({ browser });   // shares the one Chromium
  await b.page.setContent(`<label>Password <input id=p type=password></label>`);
  const i = (await b.snapshot()).elements[0].i;
  // stands in for the Jev API: records every request, answers "type the password", then "done"
  const sent = [];
  b.call = async (state, questions) => {   // stands in for Jev
    sent.push(JSON.stringify({ state, questions }));
    const typed = (state.task?.history ?? []).some(h => h.action === "type");
    const answers = {};
    for (const name of Object.keys(questions)) { const q = questions[name];
      if (q.type === "noul") answers[name] = { noul: /^(done|done_change|complete)$/.test(name) ? (typed ? 0.95 : 0.01) : 0 };
      else if (name === "tool") answers[name] = { choice: typed ? "none" : "type", probabilities: { type: typed ? 0 : 1, none: typed ? 1 : 0 } };
      else if (name === "target") answers[name] = { choice: String(i), probabilities: { [i]: 1 } };
      else if (name === "value") answers[name] = { choice: "password", probabilities: { password: 1 } };
    }
    return { answers };
  };
  process.env.JEV_TEST_PW = "s3cret-Pass!";
  const r = await b.do("Enter the password", { values: { password: "env:JEV_TEST_PW" } });
  assert.equal(r.status, "done", r.info);
  assert.equal(await b.page.inputValue("#p"), "s3cret-Pass!");
  assert.ok(sent.some(x => x.includes("(a secret value, hidden)")), "Jev was told a secret exists");
  assert.doesNotMatch(sent.join(""), /s3cret|JEV_TEST_PW/, "but never its value or where it came from");
  assert.doesNotMatch(JSON.stringify(r), /s3cret/);
  assert.equal(r.actions[0].value, "password");
  await b.close();
});

test("autofill waits for the browser to fill the field, and says so when it doesn't", async () => {
  const b = await JevBrowser.launch({ browser });   // shares the one Chromium
  // stands in for a password manager that fills on user input
  await b.page.setContent(`<input id=u onfocus="setTimeout(() => this.value = 'filled-by-manager', 300)"><input id=v>`);
  const [u, v] = (await b.snapshot()).elements.map(e => e.i);
  await b.act({ tool: "type", target: u, value: "autofill" });
  assert.equal(await b.page.inputValue("#u"), "filled-by-manager");
  await assert.rejects(b.act({ tool: "type", target: v, value: "autofill" }), /didn't fill this field/);
  await b.close();
});
