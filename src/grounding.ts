const DATA_QUESTION_RE = new RegExp(
  [
    "how many|how much|how's|how is|how am i|how are we",
    "what stage|which stage|what's the stage",
    "what number|phone|email|contact",
    "when is|when's|what time|what date",
    "who is|who's|which client|which customer",
    "list|show me|tell me about|brief me",
    "revenue|pipeline|deals|closed|conversion|funnel",
    "presentations|meetings|clients|customers|leads",
    "मेरे कितने|कितनी|कौन सा|कौन है|स्टेज",
  ].join("|"),
  "i",
);

const CONCRETE_FACT_RE = new RegExp(
  [
    "\\b\\d",
    "\\b(inquiry|enquiry|negotiation|offer|closed won|closed lost|vsv)\\b",
    "\\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b",
    "\\b(january|february|march|april|may|june|july|august|september|october|november|december)\\b",
    "@",
  ].join("|"),
  "i",
);

const HEDGE_RE =
  /\b(i don'?t (have|know)|i can'?t (see|find|look)|not sure|no (presentations|clients|meetings)|nothing|couldn'?t find|let me (check|look)|मुझे नहीं|पता नहीं)\b/i;

/** "Spell it back", "repeat that", "what did I say", "confirm": answered from the conversation, not a lookup. */
const RECALL_RE = new RegExp(
  [
    "\\b(repeat|spell)",
    "\\bread (it |that |them |those |the \\w+ )?back",
    "\\bsay (it|that) again",
    "\\bconfirm (back|what|that you (got|have|received|heard))",
    "\\bwhat did (i|you) (just )?(say|tell|give|spell)",
    "\\b(i|you) just (said|told|gave|spelled|spelt)",
    "\\b(last time|previous(ly)?|earlier)\\b.*\\b(discuss|talk|ask|said|told|spoke|chat|convers)",
    "\\b(discuss|talk|ask|said|told|spoke|chat|convers)\\w*\\b.*\\b(last time|previously|earlier|yesterday)",
    "पिछली बार|पिछली दफ़ा|पिछली दफा",
    "फिर से|दोबारा|दोहरा",
  ].join("|"),
  "i",
);

export function asksToRecall(text: string): boolean {
  return RECALL_RE.test(text);
}

/** What the conversation already holds: `said` = the agent's earlier replies and tool results; `heard` = the advisor's words. */
export interface ConversationEvidence {
  said: string;
  heard: string;
}

export function isDataQuestion(text: string): boolean {
  return DATA_QUESTION_RE.test(text);
}

export function statesConcreteFact(text: string): boolean {
  if (!text.trim()) return false;
  if (HEDGE_RE.test(text)) return false;
  return CONCRETE_FACT_RE.test(text);
}

const NOT_A_CLAIM = new Set([
  "i", "you", "your", "yours", "we", "our", "us", "he", "she", "it", "its", "they",
  "them", "their", "his", "her", "hers", "the", "that", "this", "these", "those",
  "there", "here", "and", "but", "so", "or", "if", "as", "at", "on", "in", "for",
  "ah", "oh", "well", "right", "sure", "okay", "ok", "yes", "no", "not", "nothing",
  "none", "nope", "want", "let", "got", "course", "sorry", "mm", "hmm",
  "what", "when", "who", "whom", "how", "why", "where", "which", "shall", "should",
  "both", "all", "each", "every", "any", "some", "many", "much", "more", "most",
  "next", "last", "first", "second", "third", "still", "then", "than", "also", "just",
  "only", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "everything", "everyone", "anything", "nobody", "looks", "seems", "sounds", "done",
  "great", "good", "perfect", "maybe", "actually", "currently", "live", "scheduled",
  "completed", "canceled", "cancelled", "active", "pending", "today", "tomorrow",
  "yesterday", "now", "soon", "later", "before", "after", "up", "down", "back",
]);

const STAGE_WORDS = /\b(inquiry|enquiry|negotiation|offer|closed won|closed lost|vsv)\b/gi;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** The checkable facts in a reply: numbers apart, because the advisor's own numbers are not evidence. */
function claims(replyText: string): { numbers: string[]; words: string[] } {
  const emails = replyText.match(EMAIL_RE) ?? [];
  const rest = replyText.replace(EMAIL_RE, " ");
  const numbers = rest.match(/\d+/g) ?? [];
  const words: string[] = [...emails];

  for (const word of rest.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) {
    if (!NOT_A_CLAIM.has(word.toLowerCase())) words.push(word);
  }

  for (const stage of rest.match(STAGE_WORDS) ?? []) words.push(stage);

  return { numbers, words };
}

const MONTHS =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g;

const canonical = (text: string) => text.toLowerCase().replace(MONTHS, (month) => month.slice(0, 3));

/**
 * Every fact in the reply is already on screen or in the conversation. Names and email addresses may come from
 * what the advisor said (they dictated them); numbers must come from the screen, a tool or the agent's own earlier
 * replies — "THE ADVISOR IS NOT A SOURCE" of figures about their data.
 */
export function supported(replyText: string, screen: string | null, evidence?: ConversationEvidence): boolean {
  const { numbers, words } = claims(replyText);
  if (numbers.length === 0 && words.length === 0) return false;

  const trusted = canonical([screen ?? "", evidence?.said ?? ""].join("\n"));
  const withAdvisor = canonical([screen ?? "", evidence?.said ?? "", evidence?.heard ?? ""].join("\n"));
  return (
    numbers.every((n) => trusted.includes(n)) && words.every((w) => withAdvisor.includes(canonical(w)))
  );
}

export function isUngrounded(params: {
  userText: string;
  replyText: string;
  calledTool: boolean;
  hasToolOutput: boolean;
  screen?: string | null;
  evidence?: ConversationEvidence;
}): boolean {
  if (params.calledTool || params.hasToolOutput) return false;
  if (asksToRecall(params.userText)) return false;
  if (!isDataQuestion(params.userText)) return false;
  if (!statesConcreteFact(params.replyText)) return false;
  return !supported(params.replyText, params.screen ?? null, params.evidence);
}

export const RETRY_INSTRUCTION =
  "STOP. You just answered with specific facts about the advisor's data without looking anything up, and you do not know those facts. Call the correct tool now to get the real answer. If no tool can answer it, say plainly that you do not have it — never guess a number, a stage, a date or a contact detail.";

export const SAFE_FALLBACK = "I don't have that to hand — let me pull it up for you.";

/**
 * A reply saying a change was made ("I've scheduled it", "it's been sent", "कर दिया"). Only true after a tool
 * did it; said without one, it is a false claim the advisor will act on.
 */
const DONE_RE = new RegExp(
  [
    "\\b(i'?ve|i have|it'?s|it has|that'?s|that has|has been|have been|is now|are now|all)\\s+(been\\s+)?(scheduled|booked|sent|added|updated|saved|moved|rescheduled|cancell?ed|created|changed|renamed|deleted|noted)\\b",
    // Not "you sent it" / "they booked it": that is the advisor or the client, not you.
    "(?<!\\b(you|they|he|she)\\s)\\b(scheduled|booked|sent|added|updated|saved|rescheduled|cancell?ed|renamed)\\s+(it|that|them|the (visit|meeting|presentation|email|note|client))\\b",
    "कर दिया|कर दी|कर दिए|भेज दिया|भेज दी|बुक कर दिया|अपडेट कर दिया|सेव कर दिया",
  ].join("|"),
  "i",
);

/** "I can't see whether it was sent", "did you send it?": an open question, not a claim. */
const OPEN_CLAUSE_RE = /\b(whether|if|did you|have you)\b[^.?!,;—]*/gi;

export function claimsDone(text: string): boolean {
  return DONE_RE.test(text.replace(OPEN_CLAUSE_RE, ""));
}

export const ACTION_RETRY_INSTRUCTION =
  "STOP. Your reply says something was done, but you did not call any tool this turn, so nothing was done. Either call the right tool now, or tell them plainly it has not been done yet and offer to do it.";

export const NOT_DONE_FALLBACK = "I haven't done that yet. Want me to go ahead?";
