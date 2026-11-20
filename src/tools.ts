import { llm } from "@livekit/agents";
import { AGENT_TOOLS, type AgentToolSpec } from "./shared/agent-tools";
import type { BrowserBridge } from "./browser-bridge.js";
import { asksForContact, asksForNote, dictatedAddressInstruction, readBack, spellOut, withoutContact } from "./contact.js";
import { isHypothetical } from "./intent.js";
import { similarity } from "./shared/phonetic-name-match";

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: string[];
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

export function toJsonSchema(spec: AgentToolSpec): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const [key, param] of Object.entries(spec.parameters)) {
    properties[key] = {
      type: param.type,
      description: param.description,
      ...(param.enum ? { enum: param.enum } : {}),
    };
  }
  return { type: "object", properties, required: spec.required ?? [] };
}

const CONTACT_BEARING = new Set(["get_client", "client_brief"]);

const DESTRUCTIVE = new Set([
  "cancel_presentation",
  "reschedule_presentation",
  "set_deal_stage",
  "rename_client",
  "confirm_action",
  "add_client_note",
  "send_email",
  "reply_to_email",
  "create_calendar_event",
]);

const MAX_CALLS_PER_TURN = 4;

/** Held for a yes by the browser, but saved at once here: internal, and a fix is one more call. */
const SAVE_AT_ONCE = new Set(["add_customer", "rename_client", "set_deal_stage"]);

/** Tools that hold a change for a spoken yes. Only one can wait at a time: a second would replace the first. */
const STAGING = new Set([
  "cancel_presentation",
  "reschedule_presentation",
  "set_deal_stage",
  "rename_client",
  "schedule_presentation",
  "add_customer",
  "send_email",
  "reply_to_email",
  "create_calendar_event",
]);

/** The advisor's own message holds an address: "x@y.in", "x at y dot in", "x एट y डॉट in". */
/** Devanagari and the other Indian scripts Sarvam transcribes into. */
const INDIC_SCRIPT_RE = /[\u0900-\u0DFF]/;

/** "Google Calendar", "गूगल कैलेंडर", "my own/personal calendar": which calendar they meant. */
const GOOGLE_RE = /google|गूगल|\b(own|personal) calendar\b/i;

const DICTATED_ADDRESS_RE = /@|\bat\b.{1,40}\bdot\b|एट.{1,40}डॉट/i;

export interface TurnBudget {
  reset(): void;
  seen: Set<string>;
  count: number;
  /** The change this turn already holds for a yes, if any. */
  staged: string | null;
}

export function newTurnBudget(): TurnBudget {
  const budget: TurnBudget = {
    seen: new Set<string>(),
    count: 0,
    staged: null,
    reset() {
      budget.seen.clear();
      budget.count = 0;
      budget.staged = null;
    },
  };
  return budget;
}

/** What the tool guards may know about the conversation so far. */
export interface TurnFacts {
  /** The agent's earlier replies in this conversation. */
  agentSaid: string;
  /** This turn was typed, not spoken (nothing to mishear). */
  typed: boolean;
  /** The advisor's last few messages, this one included. */
  userSaid?: string;
}

// "His email ID is …" once became an email nobody asked for, with a made-up body. A send needs one of these
// in their recent messages or in the agent's offer they answered ("want me to email him?").
const SEND_RE = /\b(send|sent|mail|write|drop|shoot|reply|forward)\b|\be-?mail (him|her|them|it|to|back)\b|भेज|bhej|likh|लिख|जवाब|jawab/i;

let callSeq = 0;

export function buildTools(
  bridge: BrowserBridge,
  lastUserText: () => string = () => "",
  budget: TurnBudget = newTurnBudget(),
  facts: () => TurnFacts = () => ({ agentSaid: "", typed: false }),
) {
  const entries = AGENT_TOOLS.map((spec) => {
    const run = async (args: unknown, token: string): Promise<unknown> => {
      console.log(`[tool] ${spec.name} ${JSON.stringify(args ?? {})}`);

      const signature = `${spec.name}:${JSON.stringify(args ?? {})}`;
      if (budget.seen.has(signature)) {
        console.warn(`[guard] refused a repeat of ${spec.name} in the same turn`);
        return {
          error:
            "You already called this with these exact arguments on this turn and have the result. Do NOT call it again. Answer them now, from what you already have.",
        };
      }
      if (budget.count >= MAX_CALLS_PER_TURN) {
        console.warn(`[guard] tool budget spent on this turn (${budget.count})`);
        return {
          error:
            "That is enough looking up for one turn. Answer them now with what you have, or ask them one short question.",
        };
      }
      // Checked before any await, so two calls made at once (a booking and a Google event) can't both stage.
      if (STAGING.has(spec.name)) {
        const holder = budget.staged?.split("@")[0];
        if (holder) {
          console.warn(`[guard] refused ${spec.name}: ${holder} already waits for a yes this turn`);
          return {
            error: `Nothing was done. One change at a time: ${holder} is already waiting for their yes. Ask about that one only. If you are not sure which of the two they meant, ask them instead.`,
          };
        }
        budget.staged = token;
      }
      budget.seen.add(signature);
      budget.count++;

      if (DESTRUCTIVE.has(spec.name) && isHypothetical(lastUserText())) {
        console.warn(`[guard] refused a write on a question: ${JSON.stringify(lastUserText())}`);
        return {
          error:
            "That was a question about the action, not an instruction to take it. Nothing has been changed. Answer their question in plain words instead.",
        };
      }

      // "Set an event" could be a Propley presentation or their Google Calendar: only Google once it was named,
      // by them or in the question they just answered ("add it to your Google Calendar too?" "yes").
      const lastAgentLine = facts().agentSaid.slice(-300);
      if (spec.name === "create_calendar_event" && !GOOGLE_RE.test(lastUserText()) && !GOOGLE_RE.test(lastAgentLine)) {
        console.warn(`[guard] create_calendar_event without Google named: ${JSON.stringify(lastUserText())}`);
        return {
          error:
            "Nothing was added. They have not said which calendar. Ask in one short question: a Propley presentation for a client, or an event on their Google Calendar?",
        };
      }

      // The name must be one they said: "Can you add a client?" once got a name pulled from memory.
      const newName = String((args as { name?: unknown; new_name?: unknown } | null)?.[spec.name === "rename_client" ? "new_name" : "name"] ?? "");
      const said = lastUserText().toLowerCase();
      const firstWord = newName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      // Sounds-like, not exact: speech hears "Tapasin" for Tapaswin (0.88), while unrelated words score near 0.
      const heardIt = said.split(/[^\p{L}\p{M}]+/u).some((w) => w.length > 1 && similarity(w, firstWord) >= 0.6);
      if ((spec.name === "add_customer" || spec.name === "rename_client") && firstWord && !facts().typed && !INDIC_SCRIPT_RE.test(said) && !heardIt) {
        console.warn(`[guard] ${spec.name} with a name they did not say: ${JSON.stringify(newName)}`);
        return {
          error: `Nothing was saved. "${newName}" is not in what they just said: ${JSON.stringify(lastUserText())}. If a name is in there, call ${spec.name} again with it exactly as written. If there is none, ask them for the name.`,
        };
      }

      if ((spec.name === "send_email" || spec.name === "reply_to_email") && !facts().typed && !SEND_RE.test(facts().userSaid ?? lastUserText()) && !SEND_RE.test(lastAgentLine)) {
        console.warn(`[guard] ${spec.name} nobody asked for: ${JSON.stringify(lastUserText())}`);
        return {
          error:
            "Nothing was sent. They did not ask you to send an email. If they gave a client's email address, phone or city, save it on that client with add_customer (their saved name plus the detail). Otherwise ask what they want.",
        };
      }

      const to = String((args as { to?: unknown; email?: unknown } | null)?.[spec.name === "add_customer" ? "email" : "to"] ?? "");
      if (spec.name === "send_email" && !to.includes("@") && DICTATED_ADDRESS_RE.test(lastUserText())) {
        console.warn(`[guard] address dictated but not used: ${JSON.stringify(lastUserText())}`);
        return { error: dictatedAddressInstruction(lastUserText()) };
      }
      if ((spec.name === "send_email" || spec.name === "add_customer") && to.includes("@") && !facts().typed && !readBack(to, facts().agentSaid)) {
        console.warn(`[guard] dictated address not read back yet: ${JSON.stringify(to)}`);
        return {
          error:
            `Read the address back to them now, in your own reply and in their language, keeping the letters as English letters: "${spellOut(to)}", and ask if it is right. Do not ask them to spell it. Call ${spec.name} again only after they say yes. (Internal: speech recognition often mishears spelled addresses; nothing is drafted yet. Don't mention either.)`,
        };
      }

      // The CRM's names are in English letters; one saved in Hindi script never matches a lookup again.
      if ((spec.name === "add_customer" || spec.name === "rename_client") && INDIC_SCRIPT_RE.test(newName)) {
        console.warn(`[guard] name not in English letters: ${JSON.stringify(newName)}`);
        return {
          error: `Write the name in English letters (for example तपस्विन → Tapaswin), then call ${spec.name} again with it. Nothing has been saved. Don't mention this.`,
        };
      }

      if (spec.name === "add_client_note" && !asksForNote(lastUserText())) {
        console.warn(`[guard] refused a note nobody asked for: ${JSON.stringify(lastUserText())}`);
        return {
          error:
            "The advisor did not ask for anything to be noted. Do NOT claim a note was saved. Ask them what they want recorded.",
        };
      }

      const raw = await bridge.executeTool(spec.name, (args ?? {}) as Record<string, unknown>);
      console.log(`[tool] ${spec.name} -> ${JSON.stringify(raw).slice(0, 120)}`);

      // CRM edits that stay inside Propley save at once and are said back: asking "add him?" before every one of
      // them was the engineer's main complaint (Nov 2026). Anything the client sees still waits for a yes. A new
      // name that sounds like an existing client (`similar`) still asks.
      const held = raw as { needsConfirmation?: unknown; similar?: unknown } | null;
      if (SAVE_AT_ONCE.has(spec.name) && held?.needsConfirmation === true && !held.similar) {
        const done = await bridge.executeTool("confirm_action", { confirm: true });
        console.log(`[tool] ${spec.name} saved at once -> ${JSON.stringify(done).slice(0, 120)}`);
        if ((done as { ok?: unknown } | null)?.ok !== true) return done;
        return {
          ...(done as object),
          note: "Already saved; do not ask for a yes. Say in one line what was saved, the name exactly as saved. If they say it is wrong, fix it with another call.",
        };
      }

      if (CONTACT_BEARING.has(spec.name) && !asksForContact(lastUserText())) {
        return withoutContact(raw);
      }
      return raw;
    };

    const fn = llm.tool({
      description: spec.description,
      parameters: toJsonSchema(spec),
      execute: async (args: unknown) => {
        const token = `${spec.name}@${++callSeq}`;
        const result = await run(args, token);
        // Release the slot unless this call really holds a change for a yes (a guard error, a lookup).
        if (budget.staged === token && (result as { needsConfirmation?: unknown } | null)?.needsConfirmation !== true) {
          budget.staged = null;
        }
        return result;
      },
    });
    return [spec.name, fn] as const;
  });

  return Object.fromEntries(entries);
}
