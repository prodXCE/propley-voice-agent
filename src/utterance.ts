const FILLERS = new Set([
  "so",
  "and",
  "but",
  "then",
  "well",
  "like",
  "anyway",
  "actually",
  "hmm",
  "hm",
  "mmm",
  "mm",
  "uh",
  "um",
  "uhh",
  "umm",
  "ah",
  "aah",
  "oh",
  "ohh",
  "eh",
  "huh",
  "hmmm",
  "aa",
  "ay",
  "haan",
  "haa",
  "ha",
  "हम्म",
  "हम",
  "अरे",
  "अच्छा",
  "हाँ",
  "हां",
  "हा",
  "अं",
  "उम",
  "okay",
  "ok",
  "alright",
  "right",
  "cool",
  "nice",
  "sure",
  "thanks",
  "thank you",
  "ठीक",
  "ठीक है",
  "अच्छा है",
]);

const MIN_LETTERS = 2;

/** Pure hesitation: never a reply, even to a question. The rest of FILLERS ("haan", "ok", "ठीक है") answers one. */
const HESITATIONS = new Set(["hmm", "hm", "mmm", "mm", "hmmm", "uh", "um", "uhh", "umm", "ah", "aah", "oh", "ohh", "eh", "huh", "aa", "ay", "हम्म", "हम", "अं", "उम"]);

function stripPunctuation(text: string): string {
  return text.replace(/[.,!?;:'"()\[\]{}…।॥\-–—\s]+/g, " ").trim();
}

const FILLER_PHRASES = new Set([
  "thank you",
  "thanks a lot",
  "ठीक है",
  "अच्छा है",
  "समझ गया",
]);

/**
 * False for noise and backchannel ("hmm", "ok", "हाँ") that should not get a reply. When the agent's last line
 * was a question, an acknowledgement is the answer ("हाँ" to "शेड्यूल कर दूँ?"), so only hesitations are dropped.
 */
export function isMeaningfulUtterance(raw: string, afterQuestion = false): boolean {
  const text = stripPunctuation(raw ?? "").toLowerCase();
  if (!text) return false;

  // Vowel signs are marks (\p{M}), not letters: without them "हाँ" counts as one letter.
  const letters = text.replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  if (letters.length < MIN_LETTERS) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (afterQuestion) return !words.every((w) => HESITATIONS.has(w));

  if (FILLER_PHRASES.has(text)) return false;
  if (words.every((w) => FILLERS.has(w))) return false;

  return true;
}

/** The agent's last line ends in a question mark. */
export function endsWithQuestion(agentSaid: string): boolean {
  return /[?？]\s*$/.test(agentSaid.trim().split("\n").at(-1) ?? "");
}
