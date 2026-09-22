# ⚡ Barq: TypeSafe Jev AI browser automation

Barq is fast AI browser automation for coding agents, powered by TypeSafe Jev and Playwright.
You name the outcome, Jev picks each click in about 300 ms, and your agent never reads page dumps.

```
browser_do("Log in", { username: "autofill", password: "autofill" })
  → { status: "done", url: "https://portal.example.com/home", actions: [...] }
```

It works inside the Chrome or Edge you already use, logged in as you, or in a clean Chromium it
starts itself. Not affiliated with TypeSafe; it calls their API with your key.

barq is Arabic for lightning (برق).

## Install

Node 20.3+, and a key from console.typesafe.ai.

In Claude Code:

```
/plugin marketplace add ibrahimhajjaj/barq
/plugin install barq@barq
```

It asks for the key (kept in the system keychain), which browser to use, and where its tabs go.
For its own browser, fetch Chromium once: `npx playwright install chromium`.

Any other MCP client:

```bash
claude mcp add barq -e TYPESAFE_API_KEY=your-key -- npx -y barq-mcp
```

The key can live in the macOS keychain instead:
`security add-generic-password -s typesafe-api-key -a "$USER" -w`.

## Writing steps

One call, one outcome you could point at on the screen:

```
browser_open("https://shop.example.com/")
browser_do("Add the blue mug to the cart")
browser_do("Go to checkout")
browser_read("What does the order total come to?")  → "Total £24.00", p=0.98
browser_check("Does the cart show one blue mug?")   → 0.97
```

"Add two mugs, then check out" is two calls. Open-ended goals need a finish line: "scroll until at
least 3 new results are shown". Everything to type goes in `values` with a name Jev can match to a
field; Jev can't write text, it only chooses.

To find out what a page says, `browser_read` with a question beats everything else here: one Jev
call, the whole page rather than the part on screen, and you get back the passages that answer it
instead of the page. `browser_check` is for a yes/no you can act on, one thing per question, and on
a page that keeps its own history (a chat thread, a build log) it can answer "is it running now?"
from an older entry, so read the page there instead.

Statuses you get back: `done`, `likely_done` (verify it), `needs_confirmation` (the next click
pays, sends or deletes: ask the user, then call again with `allow_irreversible`), `needs_login`,
`error`, `ambiguous`, `stuck`, `max_actions`, `blocked` (captcha), `timeout`.

## Your own browser

1. Open `chrome://inspect/#remote-debugging` (Edge: `edge://inspect/#remote-debugging`) and tick
   **Allow remote debugging for this browser instance**.
2. Set the browser to `edge` or `chrome` (plugin setting, or `BARQ_ATTACH=edge`).
3. The browser asks **Allow remote debugging?** once. Ticking the box in step 1 starts the
   browser's debugging server; it doesn't let anyone in, so each new connection is still announced.
   A small relay process keeps that one approved connection and shares it with every agent session,
   so you are asked once per browser run and not on each restart. It waits as long as you take to
   click, and holds the connection for eight idle hours (`BARQ_RELAY_IDLE_MIN`) because the browser
   only shows its "controlled by automated test software" bar while it is open, which is cheaper
   than finding the prompt again. While it runs, a program running as you that reads its token file
   (your account only) can drive the browser, as any approved debugging connection can;
   `BARQ_RELAY=0` turns the relay off and the prompt comes back every time.
4. Optional: load the `extension/` folder unpacked (Extensions → Developer mode → Load unpacked).
   Then barq's tabs live in one collapsed group named after your project instead of a separate
   window. Tabs it opens close when it is done, and your tab stays in front.

Your own tabs stay out of its sight: barq sees only the tabs it opened itself, so it can't read
yours, can't answer a dialog in one, and a tab the browser has put to sleep can't stall it.

### A browser of its own

`BARQ_ATTACH=own` uses a browser barq starts and keeps to itself, on a profile nothing else has
open. That browser never asks to be allowed, so there is no prompt and no relay to lose. It starts
with no logins, so sign in inside it once and they stay; it stays open between sessions, and the
next one finds it. `BARQ_BROWSER_PATH` picks which browser to start (Chrome, then Edge, then Brave,
then Chromium, then the driver's own), `BARQ_OWN_PROFILE` where to keep it.

## Logins

Never put a password in `values`. Pass a reference instead; it is read at the moment of typing and
never reaches Jev, the result or the trace:

| value | what happens |
|---|---|
| `"autofill"` | your password manager fills the field |
| `"autofill:work"` | picks the saved login whose name or username contains "work" |
| `"keychain:service[/account]"` | macOS keychain item |
| `"bw:item[/username\|/totp]"` | Bitwarden CLI (unlocked, `BW_SESSION` set) |
| `"env:NAME"` | environment variable of the server |

With several saved logins and none named, the step stops and lists them rather than guessing, even
if the browser pre-filled one. For Bitwarden's in-page menu, turn on "Show autofill suggestions on
form fields"; barq brings its tab to the front for the second the pick takes, then hands yours
back, and refuses any menu whose logins belong to another site.

## Reading a lot of pages

When you already know the URLs, skip the decision model entirely:

```bash
npx barq scan urls.txt --js "document.querySelector('h1').innerText" --out titles.jsonl
BARQ_ATTACH=edge npx barq scan jobs.json --selector li --click-until-gone "View more" --tabs 3
```

One JSON line per page, a rerun skips what is done, one retry per page, and everything stops if a
site answers with a captcha or "unusual traffic" page. Agents get the same through `browser_scan`,
which runs in the background and hands back counts and a sample, not the pages. A 1,600-page run in
a real browser took about 2 s a page and no model tokens per page.

## From Node

```js
import { Barq, scan, openBrowser } from "barq";

const b = await Barq.launch({ headed: true });
await b.open("https://www.saucedemo.com");
await b.do("Log in", { values: { username: "standard_user", password: "env:SAUCE_PASSWORD" } });
await b.do("Put the Sauce Labs Backpack in the cart");
console.log(await b.check("Does the cart badge show 1 item?"));   // 0..1
await b.close();

const browser = await openBrowser();                    // or { kind: "attach", spec: "edge" }
await scan(browser, urls, { tabs: 3, js: "document.title", checkpoint: "out.jsonl" });
await browser.dispose();
```

CLI: `npx barq do <url> "Log in" username=... password=env:PW`, and `npx barq run flow.json`.

## Where it is strong, where it is not

Good at: forms, dropdowns (including thousands of options), checkboxes and radios, dynamic pages,
modals, dialogs, drag and drop, uploads, iframes, shadow DOM, new tabs, pages with 2,000 elements,
and non-English interfaces.

Not good at: judging many values at once ("is this table sorted?") comes back `likely_done` or
`stuck`, never a false `done`. A page whose own components are named for a state ("processing") can
also talk a check round, since that name is evidence too; `browser_read` answers from the words
instead, and tells you which headings a passage sat under. Counting works, because code counts rather than Jev. Captchas are
reported, never solved. Sites that serve nothing to automated browsers need your own browser.

On the 41-task benchmark: 41/41 correct in the best run, 0 false "done" in every run, about 4.5 s
a task, 300 to 400 ms a Jev call. [RESULTS.md](RESULTS.md) has the runs and the failures,
[NOTES.md](NOTES.md) how it works and why.

## Development

```bash
git clone https://github.com/ibrahimhajjaj/barq && cd barq && npm install
npm test                                  # offline: fixtures and a local browser, no key
npm run test:e2e                          # the MCP server end to end (network + key)
node bench/run.mjs --set base,hard,guard  # the benchmark (network + key, about 4 minutes)
ln -s "$PWD" ~/.claude/skills/barq        # use this checkout as the Claude Code plugin
```

MIT licensed.
