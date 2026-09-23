---
name: barq
description: Drive a web browser fast through the barq MCP tools (browser_open, browser_do, browser_read, browser_check...), where Jev, a small decision model, does each click. Use for any task that needs a real browser: going to a site, logging in, filling forms, clicking through a flow, reading or checking what a page says, or testing a web app. Prefer it over screenshot-driven browsing for multi-step flows.
---

# barq

You plan; a small decision model (Jev) does each click and keystroke in about 300 ms. You never
need to read page dumps unless a step hands control back to you.

## The loop

1. `browser_open` the URL. If the result lists `site_tools`, the site offers its own tools
   (WebMCP): look at them with `browser_site_tools` and prefer `browser_call_site_tool` for what
   they cover. It is one request instead of a series of clicks.
2. `browser_do` one observable outcome per call: "Log in", "Open the Pull requests tab",
   "Add the blue mug to the cart". Split "do A, then B, then C" into separate calls.
3. Put every string to type, option to pick or file to upload in `values`, with a meaningful key
   (`{ "email": "...", "postal_code": "..." }`). The decision model can't write text; it only
   picks which value goes where.
4. Get information with `browser_read` and a `question`: it returns just the passages that answer
   it, from the whole page. Without a question it returns the page text a page at a time.
5. Confirm side effects with `browser_check` (a yes/no probability) before moving on. When the
   question isn't yes or no but which of a few things is true ("is the order pending, shipped or
   delivered?"), `browser_choose` takes the options and answers with one of them and a probability
   for each. It can't invent an option, so give every one you would accept. One thing per
   question: "is X on, and does Y say Z" lands near 0.5 even when both halves are true, so ask it as
   two checks. ≥0.85 is a reliable yes, ≤0.15 a reliable no, and the middle means look for yourself.
   On a page that keeps its own history (a chat thread, an activity feed, a build log) ask
   `browser_read` instead: a check about what is happening *now* can be answered from an older entry.
   The same goes for a page whose own components are named for a state: an element called
   something like `job-processing-card` reads as progress even when the text around it says the
   work finished, because a name is evidence too.
   `browser_read` answers from the words on the page, which is what you want in both cases, and it
   labels each passage with the headings above it, so an answer lifted from a search engine's
   generated summary ("AI Overview > ...") is distinguishable from one taken off a real result.

## Many pages

When you already know the URLs (dated listings, search result pages, product pages) and only
need to read them, use `browser_scan` instead of opening them one by one: it reads them in a few
background tabs, one JSON line per page into a file, with no model tokens per page. It returns at
once; follow it with `browser_scan_status`, then read the file. Pass `js` (an expression run in
the page) or `selector`, and `click_until_gone` for a "load more" button. If it reports
`blocked`, a site showed a captcha or "unusual traffic" page: tell the user and stop. If it was
blocked by a site answering 429 or 503 (too many requests), barq has already waited and tried
again; the pages not read stay to do, so run the same scan later with more jitter or fewer tabs.
Every record carries the page's HTTP `status`, so a 404 or 500 can be told from real content.
Pass `robots: true` to skip pages the site's robots.txt disallows (recorded with `skipped`) and to
keep to its Crawl-delay.

## Statuses from browser_do

- `done`: move on.
- `likely_done`: probably done, but verify with `browser_check` or `browser_read` first.
- `needs_confirmation`: the next action pays, sends, posts or deletes. Ask the user. Only re-call
  with `allow_irreversible: true` if they say yes, with the same goal and values: the step goes on
  from where it stopped.
  With `pending.already_done_at`, that action was already taken in this session: a retry would
  do it twice. Check the page instead; repeat it only on the user's word, with `browser_act`.
- `needs_login`: a sign-in wall and no credentials given. Pass credentials (see secrets) or ask
  the user to log in in their browser.
- `error`: the page shows an error; read `page_text`.
- `ambiguous`, `stuck`, `max_actions`: take over. `browser_snapshot` lists numbered elements,
  and `browser_act` acts on one directly. Take the snapshot first: the numbers belong to the page
  it listed, and `browser_act` refuses a number this session never saw listed rather than act on
  whatever now sits at it. Then go back to `browser_do`.
- `blocked`: captcha or access denied, or (with `allowed_sites`) the page tried to leave the sites
  the session was kept to. Tell the user.
- `timeout`: the step ran out of time (`timeout_s`, default 90). `actions` shows what was done.

For work on pages you don't trust, pass `allowed_sites` to `browser_open`: the session then stays on
those sites, and a link that would take it elsewhere is stopped.

A result with `page_errors` lists what the site's own code reported during the step: uncaught
errors, console errors, requests the server refused. Read it when a step stalls or a click
"did nothing".

## Secrets

Never put a password, one-time code or card number in `values` as plain text, and never ask the
user to paste one into the chat. Pass a reference instead; it is resolved only when typed and is
never shown to the decision model or returned:

- `"keychain:<service>"` or `"keychain:<service>/<account>"`: macOS keychain item.
- `"bw:<item>"`, `"bw:<item>/username"`, `"bw:<item>/totp"`: Bitwarden CLI (the user must have
  run `bw unlock` and given the tool BW_SESSION).
- `"env:<NAME>"`: an environment variable of the MCP server.
- `"autofill"`: click the field and let the browser's password manager fill it (works in the
  user's own browser, where their passwords are saved). When the site has several saved logins,
  pass `"autofill:<account>"` with part of the login's name or username. Without it, when the manager
  offers several (even if the browser already filled one in), the step stops with `needs_login`
  and `accounts` lists them: ask the user which one, never guess.

## Sessions

Every tool takes an optional `session` name. Each session is its own tab. Calls on different
sessions run in parallel, calls on one session run in order. Use separate sessions for
independent tasks; `browser_sessions` lists them, `browser_close` with a `session` closes that
one, and `browser_close` with `all: true` closes every session and lets go of the browser.

## In the user's own browser

When the server is set to attach (`BARQ_ATTACH`, or the plugin's browser option), the
agent works inside the user's running Chrome or Edge with their logins. Its tabs sit in a
collapsed tab group named after the project (with the helper extension) or in a separate window, and never take
over the user's tab. The browser asks the user to "Allow" remote debugging once per browser run
(the connection is kept and shared between sessions): tell them to click it if a call waits. The
prompt stays on screen and the waiting connection stays with it, so answering it a few minutes
later still works, and a call that returned before they clicked succeeds on the next try. If they
would rather never be asked, `BARQ_ATTACH=own` works in a browser barq keeps to itself, which
starts with none of their logins.

## When something goes wrong

`browser_screenshot` gives you the page as a picture (the viewport, or `full_page`), for showing
the user what you are looking at or for a layout problem the text can't carry. It is not how you
read a page: `browser_read` and `browser_snapshot` are.

Each `browser_do` result has a `trace` path: a JSON file with every round's decision and
probabilities. Read it to see why a step went the way it did. `explain: true` puts the rounds in
the result directly.
