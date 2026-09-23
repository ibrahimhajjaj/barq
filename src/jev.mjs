// The client for TypeSafe's System One API, where Jev runs.
// Jev answers questions about a state object with typed answers, and writes no text at all.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";

export const API_URL = process.env.JEV_API_URL || DEFAULT_API_URL;
// A pinned version: the thresholds in session.mjs were tuned against it, and "jev-latest" moves.
export const MODEL = process.env.JEV_MODEL || "jev-1.13.0";
export const KEYCHAIN_SERVICE = process.env.JEV_KEYCHAIN_SERVICE || "typesafe-api-key";

const ENV_VAR = "TYPESAFE_API_KEY";
const DOT_ENV_LINE = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\s]+)"?/;
const pause = ms => new Promise(done => setTimeout(done, ms));
// a little longer each time, so a rate limit has a chance to clear
const backoffMs = attempt => 800 * (attempt + 1);

// GUI apps on macOS don't inherit variables exported in shell profiles, so an MCP server they
// spawn can't count on the environment. The login keychain works for both, and keeps the key
// out of config files.
function keychainKey() {
  if (process.platform !== "darwin") return null;
  try {
    const found = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return found.trim() || null;
  } catch { return null; }
}

function environmentKey() {
  const value = process.env[ENV_VAR];
  // an unset plugin setting can arrive as its literal "${...}" placeholder
  return value && !value.startsWith("${") ? value : null;
}

function dotEnvKey() {
  for (const file of [resolve(process.cwd(), ".env"), resolve(packageRoot, ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const named = line.match(DOT_ENV_LINE);
      if (named?.[1] === ENV_VAR) return named[2];
    }
  }
  return null;
}

let cachedKey = null;
export function apiKey() {
  if (cachedKey) return cachedKey;   // looked up once per process
  for (const source of [environmentKey, keychainKey, dotEnvKey]) {
    const key = source();
    if (key) return (cachedKey = key);
  }
  throw new Error(`No TypeSafe API key: set ${ENV_VAR}, store it in the macOS keychain (security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w), or put it in .env`);
}

const deadline = (signal, timeout) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout));
const worthRetrying = status => status === 429 || status >= 500;

// Page text is cut to size in many places, and a cut can land inside an emoji, leaving half of it.
// The API refuses the whole request over that, so every string goes out whole, with any stray half
// replaced by the replacement character.
export const requestBody = (state, questions) =>
  JSON.stringify({ state, model: MODEL, questions }, (key, value) => typeof value === "string" ? value.toWellFormed() : value);

// questions map a name to { type: "noul" | "choice" | "score", instructions, criteria? }
// signal: cancels the request and any retries (a caller's deadline); timeout bounds each attempt.
export async function jev(state, questions, { retries = 2, timeout = 60_000, signal } = {}) {
  const key = apiKey();
  const payload = requestBody(state, questions);

  for (let attempt = 0; true; attempt++) {
    const startedAt = performance.now();
    let res, body;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: payload,
        signal: deadline(signal, timeout),
      });
      body = await res.json().catch(e => { if (signal?.aborted) throw e; return null; });
    } catch (e) {
      // the caller's own deadline is final; anything else is worth one more go
      if (signal?.aborted) throw signal.reason ?? e;
      if (attempt >= retries) throw e;
      await pause(backoffMs(attempt));
      continue;
    }

    const ms = Math.round(performance.now() - startedAt);
    if (res.ok && body?.answers) return { answers: body.answers, ms, tokens: body.usage?.input_tokens ?? 0, model: body.model ?? MODEL };
    if (res.ok) throw new Error("Jev returned a response without answers");
    if (attempt < retries && worthRetrying(res.status)) {
      await pause(backoffMs(attempt));
      continue;
    }

    const said = JSON.stringify(body ?? {});
    const hint = /unknown model/i.test(said) ? " (set JEV_MODEL to a model TypeSafe lists, such as jev-latest)" : "";
    throw new Error(`Jev ${res.status}: ${said.slice(0, 300)}${hint}`);
  }
}
