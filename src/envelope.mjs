// One shape for a step's result, whether the step finished or a caller's deadline cut it short.
export function stepEnvelope(r, { trace, explain, name } = {}) {
  const actions = (r.actions ?? []).map(h => h.event ? `(event) ${h.event}`
    : `${h.action}${h.key ? ` ${h.key}` : ""} ${h.element ?? ""}${h.value ? ` <- values.${h.value}` : ""}${h.option ? ` <- "${h.option}"` : ""}${h.destination ? ` -> ${h.destination}` : ""}${h.error ? `  ERROR: ${h.error}` : ""}`.trim());
  const { status, url, title, done_score, jev_calls, jev_tokens, jev_cost_usd, ms } = r; const out = { status, url, title, actions, done_score, jev_calls, jev_tokens, jev_cost_usd, ms };
  for (const k of ["info", "pending", "accounts", "recipe", "page_text", "candidates", "page_errors"]) if (r[k]) out[k] = r[k];
  if (explain && r.rounds) out.rounds = r.rounds.map(({ candidates, ...x }) => x);
  if (trace) out.trace = trace;
  if (name && name !== "main") out.session = name;
  return out;
}
