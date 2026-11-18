import { llm } from "@livekit/agents";
import { AGENT_TOOLS, type AgentToolSpec } from "./shared/agent-tools";
import type { BrowserBridge } from "./browser-bridge.js";
import { asksForContact, asksForNote, dictatedAddressInstruction, readBack, spellOut, withoutContact } from "./contact.js";
import { isHypothetical } from "./intent.js";

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

/** The advisor's own message holds an address: "x@y.in", "x at y dot in", "x एट y डॉट in". */
/** Devanagari and the other Indian scripts Sarvam transcribes into. */
const INDIC_SCRIPT_RE = /[\u0900-\u0DFF]/;

const DICTATED_ADDRESS_RE = /@|\bat\b.{1,40}\bdot\b|एट.{1,40}डॉट/i;

export interface TurnBudget {
  reset(): void;
  seen: Set<string>;
  count: number;
}

export function newTurnBudget(): TurnBudget {
  const budget: TurnBudget = {
    seen: new Set<string>(),
    count: 0,
    reset() {
      budget.seen.clear();
      budget.count = 0;
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
}

export function buildTools(
  bridge: BrowserBridge,
  lastUserText: () => string = () => "",
  budget: TurnBudget = newTurnBudget(),
  facts: () => TurnFacts = () => ({ agentSaid: "", typed: false }),
) {
  const entries = AGENT_TOOLS.map((spec) => {
    const fn = llm.tool({
      description: spec.description,
      parameters: toJsonSchema(spec),
      execute: async (args: unknown) => {
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
        budget.seen.add(signature);
        budget.count++;

        if (DESTRUCTIVE.has(spec.name) && isHypothetical(lastUserText())) {
          console.warn(`[guard] refused a write on a question: ${JSON.stringify(lastUserText())}`);
          return {
            error:
              "That was a question about the action, not an instruction to take it. Nothing has been changed. Answer their question in plain words instead.",
          };
        }

        const to = String((args as { to?: unknown } | null)?.to ?? "");
        if (spec.name === "send_email" && !to.includes("@") && DICTATED_ADDRESS_RE.test(lastUserText())) {
          console.warn(`[guard] address dictated but not used: ${JSON.stringify(lastUserText())}`);
          return { error: dictatedAddressInstruction(lastUserText()) };
        }
        if (spec.name === "send_email" && to.includes("@") && !facts().typed && !readBack(to, facts().agentSaid)) {
          console.warn(`[guard] dictated address not read back yet: ${JSON.stringify(to)}`);
          return {
            error:
              `Read the address back to them now, in your own reply and in their language, keeping the letters as English letters: "${spellOut(to)}", and ask if it is right. Do not ask them to spell it. Call send_email again only after they say yes. (Internal: speech recognition often mishears spelled addresses; nothing is drafted yet. Don't mention either.)`,
          };
        }

        // The CRM's names are in English letters; one saved in Hindi script never matches a lookup again.
        const newName = String((args as { name?: unknown; new_name?: unknown } | null)?.[spec.name === "rename_client" ? "new_name" : "name"] ?? "");
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

        if (CONTACT_BEARING.has(spec.name) && !asksForContact(lastUserText())) {
          return withoutContact(raw);
        }
        return raw;
      },
    });
    return [spec.name, fn] as const;
  });

  return Object.fromEntries(entries);
}
