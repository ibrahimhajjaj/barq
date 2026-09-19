---
name: jev-browser
description: Drive a web browser fast through the jev-browser MCP tools (browser_open, browser_do, browser_read, browser_check...). Use for any task that needs a real browser: going to a site, logging in, filling forms, clicking through a flow, reading or checking what a page says, or testing a web app. Prefer it over screenshot-driven browsing for multi-step flows.
---

# jev-browser

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
5. Confirm side effects with `browser_check` (a yes/no probability) before moving on.

## Statuses from browser_do

- `done`: move on.
- `likely_done`: probably done, but verify with `browser_check` or `browser_read` first.
- `needs_confirmation`: the next action pays, sends, posts or deletes. Ask the user. Only re-call
  with `allow_irreversible: true` if they say yes.
- `needs_login`: a sign-in wall and no credentials given. Pass credentials (see secrets) or ask
  the user to log in in their browser.
- `error`: the page shows an error; read `page_text`.
- `ambiguous`, `stuck`, `max_actions`: take over. `browser_snapshot` lists numbered elements,
  and `browser_act` acts on one directly. Then go back to `browser_do`.
- `blocked`: captcha or access denied. Tell the user.
- `timeout`: the step ran out of time (`timeout_s`, default 90). `actions` shows what was done.

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
  pass `"autofill:<account>"` with part of the login's name or username. Without it, a login the
  browser already filled in on load is kept; otherwise the step stops with `needs_login` and
  `accounts` lists them: ask the user which one, never guess.

## Sessions

Every tool takes an optional `session` name. Each session is its own tab. Calls on different
sessions run in parallel, calls on one session run in order. Use separate sessions for
independent tasks; `browser_sessions` lists them and `browser_close` closes one (or `all`).

## In the user's own browser

When the server is set to attach (`JEV_BROWSER_ATTACH`, or the plugin's browser option), the
agent works inside the user's running Chrome or Edge with their logins. Its tabs sit in a
collapsed "Agent" tab group (with the helper extension) or in a separate window, and never take
over the user's tab. The browser asks the user to "Allow" remote debugging once per browser run
(the connection is kept and shared between sessions): tell them to click it if a call waits.

## When something goes wrong

Each `browser_do` result has a `trace` path: a JSON file with every round's decision and
probabilities. Read it to see why a step went the way it did. `explain: true` puts the rounds in
the result directly.
