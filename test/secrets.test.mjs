// Offline tests: secrets stay out of Jev's view, out of results, and are resolved only when typed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { isSecret, forJev, resolveValue } from "../src/secrets.mjs";
import { Barq, siteOf } from "../src/session.mjs";
import { formatPage } from "../src/page-model.mjs";
import { RecipeBook } from "../src/recipes.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); await isolated?.close(); });

test("secret names and references are recognised; ordinary values are not", () => {
  for (const [k, v] of [["password", "x"], ["new_pwd", "x"], ["pin", "1234"], ["otp", "1"], ["api_token", "x"], ["card_number", "x"], ["email", "keychain:mail"], ["user", "autofill"], ["login", "autofill:bob"]]) assert.ok(isSecret(k, v), k);
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
  const b = await Barq.launch({ browser });
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
  const b = await Barq.launch({ browser });
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
  const b = await Barq.launch({ browser });
  // stands in for a password manager that fills on user input
  await b.page.setContent(`<input id=u onfocus="setTimeout(() => this.value = 'filled-by-manager', 300)"><input id=v>`);
  const [u, v] = (await b.snapshot()).elements.map(e => e.i);
  await b.act({ tool: "type", target: u, value: "autofill" });
  assert.equal(await b.page.inputValue("#u"), "filled-by-manager");
  await assert.rejects(b.act({ tool: "type", target: v, value: "autofill" }), /didn't fill this field/);
  await b.close();
});

// Stands in for a manager that lists saved logins in its own cross-origin frame under the password
// field, with the rows inside a closed shadow root that page scripts can't enter.
const MENU = `<body><script>
  const logins = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  const host = document.body.appendChild(document.createElement("div")), root = host.attachShadow({ mode: "closed" });
  const ul = root.appendChild(document.createElement("ul"));
  setTimeout(() => { for (const l of logins) {
    const li = ul.appendChild(document.createElement("li")), row = li.appendChild(document.createElement("div"));
    const fill = row.appendChild(document.createElement("button"));
    fill.className = "fill-cipher-button"; fill.setAttribute("aria-label", "Fill credentials for " + l.name); fill.setAttribute("aria-description", "username: " + l.user);
    fill.innerHTML = '<span class="cipher-icon"></span><span class="cipher-details"><span class="cipher-name"></span><span class="cipher-subtitle"></span></span>';
    if (l.site) fill.querySelector(".cipher-icon").style.backgroundImage = "url(https://icons.example/" + l.site + "/icon.png)";
    fill.querySelector(".cipher-name").textContent = l.name; fill.querySelector(".cipher-subtitle").textContent = l.user;
    fill.style.cssText = "display:block;width:200px;height:40px";
    fill.onclick = () => parent.postMessage(l, "*");
    row.appendChild(document.createElement("button")).className = "view-cipher-button";
  } }, 200);
</script>`;
const LOGIN = logins => `<form><input id=u name=username><input id=p type=password name=password><button type=button id=go onclick="document.title = 'as ' + u.value">Log in</button></form><script>
  p.addEventListener("click", () => {
    if (document.querySelector("iframe")) return;
    const f = document.createElement("iframe");
    f.src = "http://127.0.0.1:" + location.port + "/overlay/menu-list.html#" + encodeURIComponent(${JSON.stringify(JSON.stringify(logins))});
    f.style.cssText = "position:absolute;left:10px;top:60px;width:240px;height:" + (48 * ${logins.length} + 20) + "px;border:0";
    document.body.appendChild(f);
  });
  addEventListener("message", e => { u.value = e.data.user; p.value = "pw-" + e.data.user; document.querySelector("iframe")?.remove(); });
</script>`;

// A browser that keeps cross-origin frames in their own process, as extension frames always are.
let isolated;
async function menuPage(t, logins) {
  isolated ??= await chromium.launch({ args: ["--site-per-process"] });
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(req.url.startsWith("/overlay/") ? MENU : LOGIN(logins)); });
  await new Promise(r => server.listen(0, r));
  const b = await Barq.launch({ browser: isolated });
  t.after(async () => { await b.close(); server.closeAllConnections(); server.close(); });
  b.passwordMenu = /\/overlay\/menu-list\.html/;
  await b.open(`http://localhost:${server.address().port}/`);
  const [u] = (await b.snapshot()).elements.map(e => e.i);
  return { b, u };
}

const TWO = [{ name: "Uni", user: "alice" }, { name: "Uni", user: "bob" }];

test("autofill:<account> picks that login from the manager's menu", async t => {
  const { b, u } = await menuPage(t, TWO);
  await b.act({ tool: "type", target: u, value: "autofill:bob" });
  assert.equal(await b.page.inputValue("#u"), "bob");
  assert.equal(await b.page.inputValue("#p"), "pw-bob");
});

test("a named account replaces a login the browser filled in on load", async t => {
  const { b, u } = await menuPage(t, TWO);
  await b.page.fill("#u", "alice"); await b.page.fill("#p", "pw-alice");
  await b.act({ tool: "type", target: u, value: "autofill:bob" });
  assert.equal(await b.page.inputValue("#u"), "bob");
  assert.equal(await b.page.inputValue("#p"), "pw-bob");
});

// Stands in for Jev on a form the browser already filled: it goes straight for the button.
function submitter(b) {
  b.call = async (state, questions) => {   // stands in for Jev
    const clicked = (state.task?.history ?? []).some(h => h.action === "click");
    const go = b.lastPage.elements.find(e => e.text === "Log in").i, answers = {};
    for (const name of Object.keys(questions)) { const q = questions[name];
      if (q.type === "noul") answers[name] = { noul: /^(done|done_change|complete)$/.test(name) ? (clicked ? 0.95 : 0.01) : 0 };
      else if (name === "tool") answers[name] = { choice: clicked ? "none" : "click", probabilities: { click: clicked ? 0 : 1, none: clicked ? 1 : 0 } };
      else if (name === "target") answers[name] = { choice: String(go), probabilities: { [go]: 1 } };
      else answers[name] = { choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]]: 1 } };
    }
    return { answers };
  };
}

test("a named account is picked before a pre-filled form is submitted", async t => {
  const { b } = await menuPage(t, TWO);
  await b.page.fill("#u", "alice"); await b.page.fill("#p", "pw-alice");
  submitter(b);
  const r = await b.do("Log in", { values: { username: "autofill:bob", password: "autofill" } });
  assert.equal(r.status, "done", r.info);
  assert.equal(await b.page.title(), "as bob");
  assert.equal(r.actions[0].action, "type");
  const none = await b.do("Log in", { values: { username: "autofill:carol", password: "autofill" } });
  assert.equal(none.status, "needs_login");
  assert.deepEqual(none.accounts, ["Uni (alice)", "Uni (bob)"]);
});

test("a replayed login picks the named account before it submits", async t => {
  const { b } = await menuPage(t, TWO);
  const dir = mkdtempSync(join(tmpdir(), "jev-recipes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  b.recipes = new RecipeBook({ file: join(dir, "recipes.json") });
  submitter(b);
  const values = { username: "autofill:bob", password: "autofill" };
  assert.equal((await b.do("Log in", { values })).recipe, "recorded");
  await b.page.reload();
  await b.page.fill("#u", "alice"); await b.page.fill("#p", "pw-alice");
  const r = await b.do("Log in", { values });
  assert.equal(r.recipe, "replayed");
  assert.equal(await b.page.title(), "as bob");
  assert.deepEqual(r.actions.map(h => h.action), ["type", "click"]);
});

test("with several saved logins and none named, autofill lists them instead of guessing", async t => {
  const { b, u } = await menuPage(t, TWO);
  await assert.rejects(b.act({ tool: "type", target: u, value: "autofill" }), e => e.code === "AUTOFILL_WHICH" && e.accounts.join() === "Uni (alice),Uni (bob)");
  assert.equal(await b.page.inputValue("#u"), "");
  await assert.rejects(b.act({ tool: "type", target: u, value: "autofill:carol" }), /no single saved login matches "carol"/);
});

test("sites follow the public suffix list: tenants of one host are different sites", () => {
  assert.equal(siteOf("mail.google.com"), siteOf("accounts.google.com"));
  assert.equal(siteOf("portal.example.edu.ps"), "example.edu.ps");
  assert.notEqual(siteOf("alice.github.io"), siteOf("evil.github.io"));
  assert.equal(siteOf("localhost"), "localhost");
});

test("a menu listing another site's logins is never picked from", async t => {
  const { b, u } = await menuPage(t, [{ name: "Mail", user: "me@example.com", site: "mail.example.com" }]);
  await assert.rejects(b.act({ tool: "type", target: u, value: "autofill" }), e => e.code === "AUTOFILL_BACKGROUND" && /mail\.example\.com/.test(e.message));
  assert.equal(await b.page.inputValue("#u"), "");
});

test("a background tab is brought forward for the pick and the user's tab given back", async t => {
  const { b, u } = await menuPage(t, [{ name: "Uni", user: "alice", site: "localhost" }]);
  const shown = v => b.page.evaluate(v => Object.defineProperty(document, "visibilityState", { get: () => v, configurable: true }), v);
  await shown("hidden");
  const calls = [];
  b.front = async () => { calls.push("front"); await shown("visible"); return async () => { calls.push("back"); await shown("hidden"); }; };
  await b.act({ tool: "type", target: u, value: "autofill" });
  assert.equal(await b.page.inputValue("#u"), "alice");
  assert.deepEqual(calls, ["front", "back"]);
  // and without a way to bring it forward, a background tab's menu isn't trusted
  b.front = null; await b.page.fill("#u", ""); await b.page.fill("#p", "");
  await assert.rejects(b.act({ tool: "type", target: u, value: "autofill" }), e => e.code === "AUTOFILL_BACKGROUND");
});

test("a single saved login is picked without naming it", async t => {
  const { b, u } = await menuPage(t, TWO.slice(0, 1));
  await b.act({ tool: "type", target: u, value: "autofill" });
  assert.equal(await b.page.inputValue("#u"), "alice");
});
