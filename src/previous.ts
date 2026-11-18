import type { PreviousSession } from "./browser-bridge.js";

const MAX_CHARS = 4000;

/** Your own "I have no record of that" from last time: left out, or it gets repeated instead of searched again. */
const NOTHING_FOUND_RE = /\b(no record|don'?t have (that|a record|any)|couldn'?t find|can'?t (find|tell)|not sure|nothing (on|found))\b/i;

/**
 * The advisor's last session with the assistant, as a block for the instructions, so "what were we discussing
 * last time?" can be answered. Keeps the most recent lines when it is long. Empty when there was none.
 */
export function previousConversation(session: PreviousSession | null, timeZone = process.env.ADVISOR_TIMEZONE || "Asia/Kolkata"): string {
  if (!session?.messages.length) return "";
  const lines = session.messages
    .filter((m) => m.role === "advisor" || !NOTHING_FOUND_RE.test(m.text))
    .map((m) => `${m.role === "advisor" ? "Advisor" : "You"}: ${m.text.replace(/\s+/g, " ").trim()}`);
  // The newest lines that fit in MAX_CHARS.
  let from = lines.length;
  for (let size = 0; from > 0 && size + lines[from - 1].length < MAX_CHARS; from--) size += lines[from - 1].length + 1;
  const when = new Date(session.endedAt);
  const day = Number.isNaN(when.getTime())
    ? "earlier"
    : when.toLocaleString("en-IN", { timeZone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  return [
    `## Your previous conversation with this advisor (${day})`,
    "This is what was said the LAST time they used you — not this conversation. Use it when they ask about last time or earlier.",
    "Only the ADVISOR's lines there are facts they gave you. Your own lines are not evidence: if you said then that you had no record of something or couldn't find it, that was then — look it up again now (search_knowledge) instead of repeating it.",
    "That session is OVER. Anything you put on their screen then (a draft, a card, a summary) is gone now, and you cannot see what they did with it. Speak of it in the past tense: \"Last time I put the draft on your screen — I can't see whether you sent it.\" Never say it is on their screen now, and never say it was sent.",
    ...(from > 0 ? ["(earlier lines left out)"] : []),
    ...lines.slice(from),
  ].join("\n");
}
