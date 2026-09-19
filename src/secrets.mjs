// Values the caller hands over for typing. Secrets among them are typed into the page but never
// shown to Jev, never returned, and never written to traces. A value can also be a reference that
// is looked up only at the moment it is typed, so the secret never passes through the caller:
//
//   keychain:<service>[/<account>]           the macOS login keychain
//   bw:<item>[/password|/username|/totp]     the Bitwarden CLI (needs an unlocked vault, BW_SESSION)
//   env:<NAME>                               an environment variable of this process
//   autofill                                 let the browser's password manager fill the field
import { execFile } from "node:child_process";

export const AUTOFILL = "autofill";
const REFERENCE = /^(keychain|bw|env):(.+)$/s;
const SECRET_NAME = /pass|pwd|(^|[^a-z])pin([^a-z]|$)|otp|2fa|mfa|token|secret|card|cvv|cvc|security.?code|ssn|iban/i;

export function isSecret(name, value) {
  return SECRET_NAME.test(name) || REFERENCE.test(String(value)) || value === AUTOFILL;
}

// What Jev may see of the values: every name, and the contents of the ones that aren't secret.
// The name is what matches a value to a field ("password" to the Password box), so hiding the
// contents costs nothing.
export function forJev(values) {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, isSecret(k, v) ? "(a secret value, hidden)" : String(v).slice(0, 200)]));
}

function runFile(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr); reject(err); } else resolve(String(stdout));
    });
  });
}

// The text to type for a value: the value itself, or what its reference points to.
export async function resolveValue(value, { run = runFile, env = process.env } = {}) {
  const m = String(value).match(REFERENCE);
  if (!m) return String(value);
  const [, kind, ref] = m;
  if (kind === "env") {
    if (env[ref] == null) throw new Error(`env:${ref} is not set in this process's environment`);
    return env[ref];
  }
  if (kind === "keychain") {
    const [service, account] = ref.split("/");
    try {
      return (await run("security", ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"])).replace(/\n$/, "");
    } catch { throw new Error(`the keychain has no item for keychain:${ref} (add one with: security add-generic-password -s ${service}${account ? ` -a ${account}` : ""} -w)`); }
  }
  // bw: the last path segment names the field only when it is one of these
  const tail = ref.match(/^(.+)\/(password|username|totp)$/);
  const [item, field] = tail ? [tail[1], tail[2]] : [ref, "password"];
  try {
    return (await run("bw", ["get", field, item])).trim();
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("the Bitwarden CLI (bw) isn't installed: install it, then bw login and bw unlock, and give this process BW_SESSION");
    throw new Error(`Bitwarden couldn't give ${field} for "${item}": ${String(e.stderr || e.message).split("\n")[0].slice(0, 120)} (is the vault unlocked and BW_SESSION set?)`);
  }
}
