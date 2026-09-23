// Local pages for the head-to-head. Each task ends on a page showing a code that is new on every
// run and is only handed out once the task was really done (the server checks what was sent where
// it can), so a driver's answer is right or wrong with no judge in between.
import http from "node:http";
import { randomBytes } from "node:crypto";

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;max-width:900px;margin:24px auto;padding:0 16px} .overlay{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center} .card{background:#fff;padding:24px;border-radius:8px} table{border-collapse:collapse} td,th{border:1px solid #ccc;padding:4px 8px}</style></head><body>${body}</body></html>`;
const done = code => page("Done", `<h1>All set</h1><p>Confirmation code: <b id="code">${code}</b></p>`);
const form = req => new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(Object.fromEntries(new URLSearchParams(b)))); });

export const TASKS = [
  { id: "login", goal: "Log in with username 'ada' and password 'engine-1843'.", path: "/login" },
  { id: "signup", goal: "Sign up with first name Grace, last name Hopper, email grace@example.com, country Portugal, plan Team, accept the terms, and submit.", path: "/signup" },
  { id: "report", goal: "Start the sales report, wait for it to finish building, then open its summary.", path: "/report" },
  { id: "overlay", goal: "Show the discount code on this page.", path: "/overlay" },
  { id: "refund", goal: "Refund order #1043.", path: "/orders" },
  { id: "paging", goal: "Find the product 'Walnut desk' in the catalogue and open it.", path: "/catalogue?page=1" },
  { id: "iframe", goal: "Subscribe to the newsletter with the email ada@example.com.", path: "/newsletter" },
  { id: "bigpage", goal: "Open the Pricing page, linked in the footer.", path: "/big" },
];

// Real sites, big pages: no code to hand out, so the driver reports the address it ended on and
// that is checked.
export const LIVE = [
  { id: "wiki", url: "https://en.wikipedia.org/wiki/Coffee", goal: "In the article's text, open the link to Espresso.", check: u => /\/wiki\/Espresso$/.test(u) },
  { id: "github", url: "https://github.com/microsoft/playwright", goal: "Open the repository's Pull requests tab.", check: u => /github\.com\/microsoft\/playwright\/pulls/.test(u) },
  { id: "hn", url: "https://news.ycombinator.com/", goal: "Open the page of the newest submissions.", check: u => /news\.ycombinator\.com\/newest/.test(u) },
];

export function start(port = 0) {
  const codes = Object.fromEntries(TASKS.map(t => [t.id, randomBytes(4).toString("hex").toUpperCase()]));
  let reportStarted = 0;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), send = (html, status = 200) => { res.writeHead(status, { "content-type": "text/html" }); res.end(html); };
    const p = u.pathname;
    if (p === "/login" && req.method === "GET") return send(page("Sign in", `<h1>Sign in</h1><form method="post"><label>Username <input name="u"></label><br><label>Password <input type="password" name="p"></label><br><button>Sign in</button></form>`));
    if (p === "/login") { const f = await form(req); return f.u === "ada" && f.p === "engine-1843" ? send(done(codes.login)) : send(page("Sign in", `<p style="color:red">Wrong username or password</p><a href="/login">Try again</a>`), 401); }
    if (p === "/signup" && req.method === "GET") return send(page("Create account", `<h1>Create your account</h1><form method="post">
      <label>First name <input name="first" required></label><br><label>Last name <input name="last" required></label><br>
      <label>Email <input type="email" name="email" required></label><br>
      <label>Country <select name="country"><option value="">Choose…</option>${["Egypt", "Ireland", "Portugal", "Spain"].map(c => `<option>${c}</option>`).join("")}</select></label><br>
      <fieldset><legend>Plan</legend>${["Solo", "Team", "Business"].map(x => `<label><input type="radio" name="plan" value="${x}"> ${x}</label>`).join(" ")}</fieldset>
      <label><input type="checkbox" name="terms"> I accept the terms</label><br><button>Create account</button></form>`));
    if (p === "/signup") { const f = await form(req); const ok = f.first === "Grace" && f.last === "Hopper" && f.email === "grace@example.com" && f.country === "Portugal" && f.plan === "Team" && f.terms === "on"; return ok ? send(done(codes.signup)) : send(page("Create account", `<p style="color:red">Something is missing or wrong: ${JSON.stringify(f)}</p>`), 400); }
    if (p === "/report") return send(page("Reports", `<h1>Sales report</h1><button onclick="fetch('/report/start').then(()=>{document.getElementById('s').textContent='Building the report…';setTimeout(()=>{document.getElementById('s').innerHTML='Report ready. <a href=/report/summary>Open summary</a>'},8000)})">Start report</button><p id="s"></p>`));
    if (p === "/report/start") { reportStarted = Date.now(); return send("ok"); }
    if (p === "/report/summary") return reportStarted && Date.now() - reportStarted > 7000 ? send(done(codes.report)) : send(page("Not ready", "<p>The report isn't ready</p>"), 409);
    if (p === "/overlay") return send(page("Deals", `<h1>Deals</h1><p>Your discount is waiting.</p><button onclick="location.href='/overlay/code'">Show discount code</button>
      <div class="overlay" id="o"><div class="card"><h2>Join our newsletter?</h2><p>Get deals first.</p><button>Subscribe</button> <button onclick="document.getElementById('o').remove()" aria-label="Close">✕</button></div></div>`));
    if (p === "/overlay/code") return send(done(codes.overlay));
    if (p === "/orders" && req.method === "GET") return send(page("Orders", `<h1>Orders</h1><table><tr><th>Order</th><th>Customer</th><th>Total</th><th></th></tr>${Array.from({ length: 30 }, (_, k) => 1030 + k).map(n => `<tr><td>#${n}</td><td>Customer ${n % 7}</td><td>$${(n % 90) + 10}.00</td><td><form method="post"><input type="hidden" name="order" value="${n}"><button>Refund</button></form></td></tr>`).join("")}</table>`));
    if (p === "/orders") { const f = await form(req); return f.order === "1043" ? send(done(codes.refund)) : send(page("Refunded", `<p>Refunded order #${f.order}. That was the wrong one.</p>`)); }
    if (p === "/catalogue") { const n = +(u.searchParams.get("page") ?? 1); const items = { 1: ["Oak chair", "Pine shelf", "Steel lamp", "Linen sofa"], 2: ["Glass table", "Wool rug", "Bamboo stool", "Cedar bench"], 3: ["Walnut desk", "Maple bed", "Teak cabinet", "Birch stool"] }[n] ?? [];
      return send(page("Catalogue", `<h1>Catalogue, page ${n} of 3</h1><ul>${items.map(i => `<li><a href="/product/${i.toLowerCase().replace(/ /g, "-")}">${i}</a></li>`).join("")}</ul>${n < 3 ? `<a href="/catalogue?page=${n + 1}">Next page</a>` : ""}`)); }
    if (p.startsWith("/product/")) return p === "/product/walnut-desk" ? send(done(codes.paging)) : send(page("Product", `<h1>${p.slice(9)}</h1><p>Not the one.</p>`));
    if (p === "/newsletter") return send(page("Newsletter", `<h1>Newsletter</h1><iframe src="/newsletter/frame" style="width:100%;height:200px;border:1px solid #ccc"></iframe>`));
    if (p === "/newsletter/frame" && req.method === "GET") return send(page("", `<form method="post" target="_top"><label>Email <input type="email" name="email"></label> <button>Subscribe</button></form>`));
    if (p === "/newsletter/frame") { const f = await form(req); return f.email === "ada@example.com" ? send(done(codes.iframe)) : send(page("Hmm", `<p>Subscribed ${f.email}, not the address asked for.</p>`)); }
    if (p === "/big") return send(page("Everything", `<h1>Everything we sell</h1>${Array.from({ length: 1500 }, (_, k) => `<a href="/item/${k}">Item ${k}</a> `).join("")}<footer><a href="/about">About</a> <a href="/pricing">Pricing</a> <a href="/contact">Contact</a></footer>`));
    if (p === "/pricing") return send(done(codes.bigpage));
    return send(page("Not here", "<p>Nothing here</p>"), 404);
  });
  return new Promise(r => server.listen(port, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}`, codes })));
}
