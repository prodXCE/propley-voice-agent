import type { Room } from "@livekit/rtc-node";
import { SLOW_TOOL_MS, RPC_TIMEOUT_MS } from "./config.js";
import { getToolSpec } from "./shared/agent-tools.js";

/** How long a fetched screen snapshot may be reused without a fresh round trip. */
const CONTEXT_REUSE_MS = 5_000;

export interface ToolEnvelope {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface WizardTurn {
  prompt: string;
  done: boolean;
}

export interface HandoffResult {
  wizard: true;
  prompt: string;
  done: boolean;
}

export function isHandoffResult(value: unknown): value is HandoffResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { wizard?: unknown }).wizard === true &&
    typeof (value as { prompt?: unknown }).prompt === "string"
  );
}

export interface RpcTiming {
  method: string;
  tool?: string;
  ms: number;
  ok: boolean;
}

export interface PreviousSession {
  endedAt: string;
  messages: { role: "advisor" | "assistant"; text: string }[];
}

export class BrowserBridge {
  /** Called after every RPC round trip to the browser (turn telemetry). */
  onRpc: ((timing: RpcTiming) => void) | null = null;
  /** Called once when a tool has been running SLOW_TOOL_MS (the agent says "one moment"). */
  onSlowTool: (() => void) | null = null;

  constructor(
    private readonly room: Room,
    private readonly identity: string,
  ) {}

  private async call(method: string, payload: unknown): Promise<string> {
    const local = this.room.localParticipant;
    if (!local) throw new Error("agent is not connected to the room");
    const started = Date.now();
    let ok = false;
    try {
      const response = await local.performRpc({
        destinationIdentity: this.identity,
        method,
        payload: JSON.stringify(payload),
        responseTimeout: RPC_TIMEOUT_MS,
      });
      ok = true;
      return response;
    } finally {
      const tool = (payload as { name?: unknown } | null)?.name;
      this.onRpc?.({ method, ...(typeof tool === "string" ? { tool } : {}), ms: Date.now() - started, ok });
    }
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // Read tools never change the page; anything else may, so the next LLM call must look again.
    if (getToolSpec(name)?.kind !== "read") this.screen = null;
    const slow = setTimeout(() => this.onSlowTool?.(), SLOW_TOOL_MS);
    try {
      const raw = await this.call("tool.execute", { name, args });
      const envelope = JSON.parse(raw) as ToolEnvelope;
      if (!envelope.ok) return { error: envelope.error ?? `tool ${name} failed` };
      return envelope.result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(slow);
    }
  }

  private screen: { at: number; value: Promise<string | null> } | null = null;

  /** Start fetching the screen now (the user just stopped talking), so the LLM call doesn't wait on it. */
  prefetchPageContext(): void {
    this.screen = { at: Date.now(), value: this.fetchPageContext() };
  }

  pageContext(): Promise<string | null> {
    if (!this.screen || Date.now() - this.screen.at > CONTEXT_REUSE_MS) this.prefetchPageContext();
    return this.screen!.value;
  }

  private async fetchPageContext(): Promise<string | null> {
    try {
      const raw = await this.call("context.get", {});
      const ctx = JSON.parse(raw) as {
        path?: string;
        page?: string;
        onScreen?: string[];
        wizard?: string | null;
        advisor?: string | null;
      };
      if (!ctx.page) return null;

      const lines = [
        "WHAT YOU CAN SEE ON THEIR SCREEN RIGHT NOW.",
        "This is your view of their screen. Answer questions about it directly from this — never say you cannot see the screen. But do not narrate or announce it unless they ask.",
        `- current page: ${ctx.page} (${ctx.path ?? "/"})`,
      ];
      if (ctx.advisor) {
        lines.push(
          `- you are assisting ${ctx.advisor}. Use their first name sparingly and naturally, the way an assistant would — not in every reply.`,
        );
      }
      for (const item of ctx.onScreen ?? []) lines.push(`- ${item}`);
      if (ctx.wizard) lines.push(`- guided flow active: ${ctx.wizard}`);
      return lines.join("\n");
    } catch {
      return null;
    }
  }

  async advisor(): Promise<string | null> {
    try {
      const raw = await this.call("context.get", {});
      const ctx = JSON.parse(raw) as { advisor?: string | null };
      return ctx.advisor?.trim() ? ctx.advisor.trim() : null;
    } catch {
      return null;
    }
  }

  /** Words speech recognition should know: client and project names, and email domains of known contacts. */
  async vocabulary(): Promise<{ terms: string[]; domains: string[] }> {
    const strings = (list: unknown) =>
      Array.isArray(list) ? list.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
    try {
      const parsed = JSON.parse(await this.call("vocabulary.get", {})) as { terms?: unknown; domains?: unknown };
      return { terms: strings(parsed.terms), domains: strings(parsed.domains) };
    } catch {
      return { terms: [], domains: [] };
    }
  }

  /** The advisor's previous assistant session, oldest line first, or null (first session, or the browser can't say). */
  async history(): Promise<PreviousSession | null> {
    try {
      const { session } = JSON.parse(await this.call("history.get", {})) as { session?: PreviousSession | null };
      return session && Array.isArray(session.messages) && session.messages.length > 0 ? session : null;
    } catch {
      return null;
    }
  }

  async wizardInput(text: string): Promise<WizardTurn> {
    this.screen = null;
    try {
      const raw = await this.call("wizard.input", { text });
      const turn = JSON.parse(raw) as WizardTurn;
      if (typeof turn.prompt !== "string") throw new Error("malformed wizard response");
      return turn;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { prompt: `Sorry, that flow failed: ${message}. Let's start over.`, done: true };
    }
  }
}
