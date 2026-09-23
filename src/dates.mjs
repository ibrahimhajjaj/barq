// "Which event is next", "the order from yesterday": questions about time that a page answers only in
// dates. Jev reads a date as text and can't count days, so for a goal about time each full date on
// the page gets how far it is from today written after it: "October 20, 2026 (in 27 days)".

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const FORMS = [
  [new RegExp(`\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b`, "g"), m => [+m[1], +m[2] - 1, +m[3]]],
  [new RegExp(`\\b${MONTH} (\\d{1,2})(?:st|nd|rd|th)?,? (20\\d{2})\\b`, "gi"), m => [+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]]],
  [new RegExp(`\\b(\\d{1,2}) ${MONTH},? (20\\d{2})\\b`, "gi"), m => [+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1]]],
];

export const ABOUT_TIME = /\b(next|upcoming|soonest|earliest|latest|most recent|newest|oldest|today|tonight|tomorrow|yesterday|this (week|month|weekend)|last (week|month)|ago|within \d+|in \d+ (days?|weeks?)|past|overdue|due|expir\w*|deadline)\b/i;

const dayNumber = (y, m, d) => Date.UTC(y, m, d) / 86_400_000;

function relative(days) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export function annotateDates(text, now = new Date()) {
  if (!text) return text;
  const today = dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
  let out = text;
  for (const [re, parts] of FORMS) {
    out = out.replace(re, (whole, ...rest) => {
      const [y, m, d] = parts([whole, ...rest]);
      const probe = new Date(Date.UTC(y, m, d));
      if (m < 0 || probe.getUTCMonth() !== m || probe.getUTCDate() !== d) return whole;
      const after = rest.at(-1).slice(rest.at(-2) + whole.length, rest.at(-2) + whole.length + 3);
      if (after.startsWith(" (")) return whole;   // already said
      return `${whole} (${relative(dayNumber(y, m, d) - today)})`;
    });
  }
  return out;
}
