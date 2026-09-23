// A rule in code for actions that are hard to undo, next to Jev's own "irreversible" judgment.
// Jev's judgment is a probability; this is the floor that holds when the probability is wrong.
// It looks only at what the control says (its label, text and nearby words), so it is cheap enough
// to run on every action, including the ones the caller performs directly.

// Words on a control that commit money, messages, public posts or deletions. English plus the
// languages most likely on the pages this is used on; extend rather than replace.
const COMMIT = [
  // money
  /\b(pay|payment|buy|purchase|place (your )?order|confirm (and )?(order|purchase|payment|booking)|complete (order|purchase|booking)|book now|reserve now|subscribe|upgrade|donate|transfer|send money|top ?up)\b/i,
  // messages and publishing
  /\b(send|post|publish|tweet|reply|share now|submit (application|review|payment)|go live)\b/i,
  // deleting, cancelling, leaving
  /\b(delete|remove (account|permanently)|erase|destroy|cancel (my )?(subscription|order|account|plan|membership)|close (my )?account|deactivate|unsubscribe|revoke|leave (group|team|organi[sz]ation))\b/i,
  // Arabic: pay, buy, send, publish/post, delete, confirm order, subscribe, transfer, cancel subscription
  /(ادفع|دفع|اشتر|شراء|أرسل|ارسل|إرسال|نشر|انشر|حذف|احذف|تأكيد الطلب|اشترك|تحويل|إلغاء الاشتراك)/,
];

// Controls that look like commits but aren't: search boxes, filters, "send me a code".
const BENIGN = /\b(search|filter|sort|preview|draft|save draft|send (me )?(a |the )?(code|link|otp)|resend|add to (cart|bag|basket|list|wishlist))\b/i;

// Only the control's own wording counts. What was typed into a field is the user's content:
// Enter in a todo box holding "buy milk" is not a purchase.
// A place to type. Clicking into one or typing in it commits nothing, whatever its label says ("Post
// body text field"); pressing Enter in one can send, so keys are still judged by the words.
const TEXT_FIELD = /^(input:(text|email|search|url|tel|number|password)|textarea)|\[(textbox|searchbox)\]/;

const LINK = /^a$|\[link\]/;
const OPENS_A_COMPOSER = /^(reply|post|tweet|comment)$/i;

export function commitsSomething(el, tool) {
  if (!el) return null;
  if ((tool === "click" || tool === "type") && (el.editable || TEXT_FIELD.test(el.tag ?? ""))) return null;
  const words = [el.label, el.text, el.placeholder, el.name].filter(Boolean).join(" ").slice(0, 200);
  if (!words.trim() || BENIGN.test(words)) return null;
  const hit = COMMIT.map(re => words.match(re)).find(Boolean);
  // A link named "reply", "post" or "tweet" opens a place to write it; the send is a button inside
  // what it opens, and that button is judged on its own. Money, deletion and "send" stay held on a
  // link too, since pages do wire those to links that act.
  if (hit && LINK.test(el.tag ?? "") && OPENS_A_COMPOSER.test(hit[0].trim())) return null;
  return hit ? hit[0].trim() : null;
}

// Tools whose effect depends on the target's wording (a click on "Pay", Enter in a chat box).
export const COMMITTING_TOOLS = new Set(["click", "press_enter", "press_key", "select", "drag"]);
