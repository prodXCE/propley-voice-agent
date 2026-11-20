const ASKED_RE = /\b(phone|number|mobile|cell|contact|e-?mail|reach (him|her|them)|call (him|her|them))\b/i;

const ASKED_INDIC_RE = /(फ़ोन|फोन|नंबर|ईमेल|मोबाइल|संपर्क)/;

const CONTACT_FIELDS = ["phone", "email", "mobile"];

export function asksForContact(userText: string): boolean {
  return ASKED_RE.test(userText) || ASKED_INDIC_RE.test(userText);
}

const NOTE_RE = /\b(note|noted|jot|log|record|write (this |that )?down|remember|make a note|add a note|mention)\b/i;
const NOTE_INDIC_RE = /(नोट|लिख|याद)/;

export function asksForNote(userText: string): boolean {
  return NOTE_RE.test(userText) || NOTE_INDIC_RE.test(userText);
}

export function withoutContact(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;

  if (Array.isArray(result)) return result.map(withoutContact);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (CONTACT_FIELDS.includes(key)) continue;
    out[key] = typeof value === "object" && value !== null ? withoutContact(value) : value;
  }
  return out;
}

/** "r-o-h-a-n dot m, at kestrel dot in" / "R O H A N.M@kestrel.in" -> "rohan.m@kestrel.in" (spoken or typed). */
export function spokenAddress(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+(dot|डॉट)\s+/g, ".")
    .replace(/\s+(at|एट)\s+/g, "@")
    .replace(/[\s,\-–—'"]/g, "");
}

/**
 * Whether the agent already read this address back in the conversation. Spelled addresses are what speech
 * recognition gets wrong most ("q u v a" -> "kuva"), so a dictated address must be read back before it is used.
 */
export function readBack(address: string, agentSaid: string): boolean {
  const want = spokenAddress(address);
  return want.includes("@") && spokenAddress(agentSaid).includes(want);
}

const WELL_KNOWN_DOMAINS = new Set(["gmail", "yahoo", "outlook", "hotmail", "rediffmail", "icloud"]);

/** "rohan.m@kestrel.in" -> "r-o-h-a-n dot m at k-e-s-t-r-e-l dot in": domains that sound alike get spelled too. */
export function spellOut(address: string): string {
  const [local = "", domain = ""] = address.toLowerCase().split("@");
  const letters = (part: string) => part.split(".").map((w) => w.split("").join("-")).join(" dot ");
  const [name = "", ...rest] = domain.split(".");
  const host = WELL_KNOWN_DOMAINS.has(name) ? name : name.split("").join("-");
  return `${letters(local)} at ${[host, ...rest].join(" dot ")}`;
}
