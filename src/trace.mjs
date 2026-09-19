// Per-step records on disk. When a step goes wrong, the round-by-round probabilities are the only
// way to see why, and they are gone once the tool result has been read. One JSON file per step,
// grouped by day, old days removed. Values that look secret never reach the file.
import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRET_KEY = /pass|pwd|pin|otp|2fa|mfa|token|secret|card|cvv|cvc|ssn|iban|security.?code/i;

export function traceDir(env = process.env, platform = process.platform) {
  if (env.JEV_BROWSER_TRACES === "0") return null;
  if (env.JEV_BROWSER_TRACES) return env.JEV_BROWSER_TRACES;
  if (platform === "darwin") return join(homedir(), "Library", "Logs", "jev-browser");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "jev-browser", "traces");
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "jev-browser", "traces");
}

// Replaces every occurrence of a secret value (by key name) anywhere in the record.
export function redact(record, values = {}) {
  const secrets = Object.entries(values).filter(([k, v]) => SECRET_KEY.test(k) && typeof v === "string" && v.length >= 3).map(([, v]) => v);
  if (!secrets.length) return record;
  let json = JSON.stringify(record);
  for (const s of secrets) json = json.split(JSON.stringify(s).slice(1, -1)).join("[redacted]");
  return JSON.parse(json);
}

export class TraceLog {
  constructor({ dir = traceDir(), keepDays = 14 } = {}) {
    this.dir = dir;
    if (dir) this.prune(keepDays);
  }

  // Writes the record and returns its path, or null when tracing is off or the disk refused.
  write(kind, record, { session = "main", values } = {}) {
    if (!this.dir) return null;
    try {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const slug = String(record.goal ?? kind).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || kind;
      const file = join(this.dir, day, `${now.toISOString().slice(11, 23).replace(/[:.]/g, "")}-${session}-${slug}.json`);
      mkdirSync(join(this.dir, day), { recursive: true });
      writeFileSync(file, JSON.stringify(redact({ kind, session, at: now.toISOString(), ...record }, values), null, 1));
      return file;
    } catch { return null; }
  }

  prune(keepDays) {
    try {
      const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
      for (const d of readdirSync(this.dir)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) rmSync(join(this.dir, d), { recursive: true, force: true });
    } catch {}
  }
}
