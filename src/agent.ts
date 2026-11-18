import { voice, type ChatContext, type ChatChunk, type FlushSentinel, type stt, type ToolContext } from "@livekit/agents";
import type * as sarvam from "@livekit/agents-plugin-sarvam";
import type { AudioFrame } from "@livekit/rtc-node";
import type { BrowserBridge } from "./browser-bridge.js";
import { DEFAULT_TTS_LANGUAGE, languageName, speaksLanguage, ttsLanguageForText, typedLanguage } from "./language.js";
import { LanguagePolicy } from "./language-policy.js";
import { clockLine, SYSTEM_PROMPT } from "./prompt.js";
import { isMeaningfulUtterance } from "./utterance.js";
import { stripSelfEcho } from "./echo.js";
import { stripGrovel, stripPlumbing } from "./grovel.js";
import { introducesName, snapEmailDomains, snapToVocabulary } from "./vocab.js";
import { buildTools, newTurnBudget, type TurnBudget } from "./tools.js";
import {
  isDataQuestion,
  isUngrounded,
  RETRY_INSTRUCTION,
  SAFE_FALLBACK,
  type ConversationEvidence,
  claimsDone,
  ACTION_RETRY_INSTRUCTION,
  NOT_DONE_FALLBACK,
} from "./grounding.js";

const RECOVERY_LINE = "Sorry, I lost that — say it again?";

const LANGUAGE_TAG_RE = /\s*\[reply-language:[^\]]*\]\s*/gi;
const stripLanguageTag = (text: string) => text.replace(LANGUAGE_TAG_RE, "");

type ModelSettings = Parameters<voice.Agent["llmNode"]>[2];

function textToStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

type Chunk = ChatChunk | string | FlushSentinel;

interface Collected {
  chunks: Chunk[];
  text: string;
  calledTool: boolean;
}

async function collectStream(stream: ReadableStream<Chunk>): Promise<Collected> {
  const chunks: Chunk[] = [];
  let text = "";
  let calledTool = false;

  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);

      if (typeof value === "string") {
        text += value;
        continue;
      }
      const delta = (value as ChatChunk)?.delta;
      if (!delta) continue;
      if (delta.content) text += delta.content;
      if (delta.toolCalls && delta.toolCalls.length > 0) calledTool = true;
    }
  } finally {
    reader.releaseLock();
  }

  return { chunks, text: text.trim(), calledTool };
}

function replay(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const HEAD_CHARS = 220;
const SENTENCE_END = /[.!?](\s|$)/;

/**
 * `onClaim`: when the reply opens by saying something was done but nothing succeeded this turn, it is called
 * instead of speaking that; it returns the replacement (a retried reply, possibly a tool call) or null.
 */
function guardOpening(
  stream: ReadableStream<Chunk>,
  onRecover: () => void,
  onClaim?: () => Promise<Collected | null>,
): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>({
    async start(controller) {
      const reader = stream.getReader();
      const buffered: Chunk[] = [];
      let head = "";
      let sawTool = false;
      let sent = false;

      // The LLM failed (e.g. every region returned 429) or said nothing: never leave the advisor in silence.
      const recover = (why: string) => {
        console.warn(`[llm] ${why}, speaking recovery line`);
        onRecover();
        controller.enqueue(RECOVERY_LINE);
        controller.close();
      };

      try {
        while (head.length < HEAD_CHARS && !sawTool && !SENTENCE_END.test(head)) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered.push(value);

          if (typeof value === "string") {
            head += value;
            continue;
          }
          const delta = (value as ChatChunk)?.delta;
          if (!delta) continue;
          if (delta.toolCalls && delta.toolCalls.length > 0) sawTool = true;
          if (delta.content) head += delta.content;
        }

        if (!head.trim() && !sawTool) return recover("empty reply");

        if (onClaim && !sawTool && claimsDone(head)) {
          console.warn(`[claim] said done without doing it: ${JSON.stringify(head.slice(0, 80))}`);
          await reader.cancel().catch(() => {});
          const retried = await onClaim().catch(() => null);
          sent = true;
          if (retried && (retried.calledTool || (retried.text && !claimsDone(retried.text)))) {
            for (const chunk of retried.chunks) controller.enqueue(chunk);
          } else {
            controller.enqueue(NOT_DONE_FALLBACK);
          }
          controller.close();
          return;
        }

        sent = true;
        const cleaned = sawTool ? head : stripPlumbing(stripGrovel(head));

        if (cleaned === head) {
          for (const chunk of buffered) controller.enqueue(chunk);
        } else {
          console.log(`[clean] ${JSON.stringify(head.slice(0, 56))} -> ${JSON.stringify(cleaned.slice(0, 56))}`);
          controller.enqueue(cleaned);
        }

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        if (!sent) return recover(`reply failed: ${String(err).slice(0, 120)}`);
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

/** A tool ran since the advisor's last message and did not fail: replies may then say it was done. */
function actionSucceeded(chatCtx: ChatContext): boolean {
  const items = chatCtx.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "message" && item.role === "user") return false;
    if (item.type === "function_call_output" && !/"error"\s*:/.test(String(item.output ?? ""))) return true;
  }
  return false;
}

function hasFreshToolOutput(chatCtx: ChatContext): boolean {
  const items = chatCtx.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "message" && item.role === "user") return false;
    if (item.type === "function_call_output") return true;
  }
  return false;
}

/** Everything the conversation already holds, for the grounding check: see grounding.supported(). */
function conversationEvidence(chatCtx: ChatContext, previous = ""): ConversationEvidence {
  const said: string[] = previous ? [previous] : [];
  const heard: string[] = [];
  for (const item of chatCtx.items) {
    if (item.id === INSTRUCTIONS_ID) continue;
    if (item.type === "message" && item.role === "user") heard.push(item.textContent ?? "");
    else if (item.type === "message" && item.role === "assistant") said.push(item.textContent ?? "");
    else if (item.type === "function_call_output") said.push(String(item.output ?? ""));
  }
  return { said: said.join("\n"), heard: heard.join("\n") };
}

/** The agent's own earlier replies, for the read-back guard on dictated addresses. */
function agentReplies(chatCtx: ChatContext): string {
  return chatCtx.items
    .filter((i) => i.type === "message" && i.role === "assistant")
    .map((i) => (i.type === "message" ? (i.textContent ?? "") : ""))
    .join("\n");
}

/** The last few exchanges as plain lines, for a retry that cannot carry the history itself. */
function recentTranscript(chatCtx: ChatContext, messages = 8): string {
  const lines: string[] = [];
  for (const item of chatCtx.items) {
    if (item.type !== "message" || item.id === INSTRUCTIONS_ID) continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text = (item.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) lines.push(`${item.role === "user" ? "Advisor" : "You"}: ${text.slice(0, 240)}`);
  }
  return lines.slice(-messages).join("\n");
}

export function lastUserText(chatCtx: ChatContext): string {
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i];
    if (item.type === "message" && item.role === "user") {
      return item.textContent ?? "";
    }
  }
  return "";
}

function lastAgentText(chatCtx: ChatContext): string | null {
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i];
    if (item.type === "message" && item.role === "assistant") {
      return item.textContent ?? null;
    }
  }
  return null;
}

function languageDirective(spoken: string): string {
  const name = languageName(spoken);
  return [
    `#### LANGUAGE OF THIS TURN: ${name.toUpperCase()}. THIS OVERRIDES EVERYTHING BELOW. ####`,
    `The advisor just spoke ${name}. Your ENTIRE reply must be in ${name}, in ${name}'s own script.`,
    `Earlier turns may have been in another language. That is IRRELEVANT — do not carry it forward.`,
    spoken === DEFAULT_TTS_LANGUAGE
      ? `They are speaking English. Answer in plain English, in Latin letters — no Devanagari, no Odia, no Indic script of any kind, not even one word.`
      : `They are speaking ${name}. Answer in ${name} — informally, the way a colleague speaks it, with English words mixed in wherever people actually use them ("Rahul अभी offer stage में हैं।"). Not in English alone, and never in stiff, formal, textbook ${name}.`,
  ].join("\n");
}

function currentTurnOnly(chatCtx: ChatContext): ChatContext {
  const trimmed = chatCtx.copy();
  const items = trimmed.items;

  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "message" && item.role === "user") {
      start = i;
      break;
    }
  }

  const instructions = items.find((item) => item.id === INSTRUCTIONS_ID);
  const turn = items.slice(start);

  trimmed.items = instructions && !turn.includes(instructions) ? [instructions, ...turn] : turn;
  return trimmed;
}

const INSTRUCTIONS_ID = "lk.agent_task.instructions";

/** How much of what the agent has said aloud is kept for the read-back guard. */
const SPOKEN_MEMORY_CHARS = 8000;

function applyInstructions(chatCtx: ChatContext, instructions: string): boolean {
  const index = chatCtx.indexById(INSTRUCTIONS_ID);
  if (index === undefined) return false;

  const item = chatCtx.items[index];
  if (item.type !== "message") return false;

  item.content = [instructions];
  return true;
}

function replaceLastUserText(chatCtx: ChatContext, text: string): void {
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i];
    if (item.type === "message" && item.role === "user") {
      item.content = [text];
      return;
    }
  }
}

export class PropleyAgent extends voice.Agent {
  private ttsLanguage: string | null = null;
  private lastContext: string | null = null;
  private readonly turn: { text: string; agentSaid: string; spoken: string; typed: boolean };
  private readonly budget: TurnBudget;
  private readonly language: LanguagePolicy;

  private confidence = 1;
  private answeredIn: string = DEFAULT_TTS_LANGUAGE;
  /** Records how each reply was produced (turn telemetry). */
  onStep: (step: string) => void = () => {};
  private readonly recovered = () => this.onStep("recovery-line");

  constructor(
    private readonly bridge: BrowserBridge,
    private readonly sarvamTts: sarvam.TTS,
    private readonly vocabulary: string[] = [],
    languages: string[] = [],
    private readonly emailDomains: string[] = [],
    /** The advisor's previous session (previous.ts), or "". */
    private readonly previous: string = "",
  ) {
    const turn = { text: "", agentSaid: "", spoken: "", typed: false };
    const budget = newTurnBudget();
    super({
      instructions: SYSTEM_PROMPT,
      allowInterruptions: true,
      tools: buildTools(bridge, () => turn.text, budget, () => ({ agentSaid: `${turn.agentSaid}\n${turn.spoken}`, typed: turn.typed })),
    });
    this.turn = turn;
    this.budget = budget;
    this.language = new LanguagePolicy(DEFAULT_TTS_LANGUAGE, languages);
  }

  get currentLanguage(): string {
    return this.language.language;
  }

  noteSpokenLanguage(code: string | null | undefined, transcript = ""): void {
    this.turn.typed = false;
    const decision = this.language.observe({
      detected: code,
      transcript,
      confidence: this.confidence,
    });

    if (decision.switched) {
      console.log(`[lang] switched to ${decision.language}`);
    } else if (decision.reason) {
      console.log(`[lang] stayed in ${decision.language}: ${decision.reason}`);
    }
  }

  /**
   * A typed message never reaches the speech recognizer, so its language is read from the text. Indian scripts and
   * clear Hindi-in-English-letters switch at once; anything that reads as English goes through the usual checks, so a
   * short "ok thanks" does not flip a Hindi conversation.
   */
  noteTypedLanguage(text: string): string {
    this.turn.typed = true;
    const typed = typedLanguage(text);
    const decision = typed
      ? this.language.force(typed)
      : this.language.observe({ detected: null, transcript: text, confidence: 1 });
    if (decision.switched) console.log(`[lang] typed message switched to ${decision.language}`);
    else if (decision.reason) console.log(`[lang] stayed in ${decision.language}: ${decision.reason}`);
    return decision.language;
  }

  async sttNode(
    audio: Parameters<voice.Agent["sttNode"]>[0],
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
    const source = await super.sttNode(audio, modelSettings);
    if (!source) return null;

    const capture = (event: stt.SpeechEvent | string) => {
      if (typeof event === "string") return;
      const alternative = event.alternatives?.[0];
      if (alternative && typeof alternative.confidence === "number") {
        this.confidence = alternative.confidence;
      }
    };

    const reader = source.getReader();
    return new ReadableStream<stt.SpeechEvent | string>({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        capture(value);
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
  }

  async llmNode(
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null> {
    const heard = stripLanguageTag(lastUserText(chatCtx)).trim();
    const deEchoed = stripSelfEcho(heard, lastAgentText(chatCtx)).trim();

    if (!deEchoed && heard) {
      console.log(`[echo] dropped self-echo: ${JSON.stringify(heard)}`);
      return null;
    }

    // Snapping fixes speech-recognition mishearings. Typed text is exactly what they meant, and a name being
    // introduced or corrected must not be pulled onto an existing client (Tapaswin -> Tapaswan).
    const userText =
      this.turn.typed || introducesName(deEchoed)
        ? deEchoed
        : snapEmailDomains(snapToVocabulary(deEchoed, this.vocabulary), this.emailDomains).trim();

    if (userText !== heard) {
      console.log(`[heard] ${JSON.stringify(heard)} -> ${JSON.stringify(userText)}`);
      replaceLastUserText(chatCtx, userText);
    }

    this.turn.text = userText;
    this.turn.agentSaid = agentReplies(chatCtx);
    this.budget.reset();

    if (!isMeaningfulUtterance(userText)) {
      console.log(`[skip] ignoring non-utterance: ${JSON.stringify(userText)}`);
      return null;
    }

    const spoken = this.language.language;

    const pageContext = await this.bridge.pageContext();
    const instructions = [languageDirective(spoken), SYSTEM_PROMPT, this.previous, pageContext, clockLine()]
      .filter(Boolean)
      .join("\n\n");

    const applied = applyInstructions(chatCtx, instructions);

    if (instructions !== this.lastContext) {
      this.lastContext = instructions;
      await this.updateInstructions(instructions);
    }
    console.log(`[lang] ${spoken}${applied ? "" : " (WARNING: not applied to this turn)"}`);
    if (process.env.DEBUG_LANG) {
      const idx = chatCtx.indexById(INSTRUCTIONS_ID);
      const item = idx !== undefined ? chatCtx.items[idx] : undefined;
      const seen = item && item.type === "message" ? (item.textContent ?? "") : "<none>";
      console.log(`[lang-probe] system tail: ${JSON.stringify(seen.slice(-160))}`);
      console.log(`[lang-probe] history: ${chatCtx.items.filter((i) => i.type === "message").length} messages`);
    }

    return this.groundedTurn(chatCtx, toolCtx, modelSettings, userText, pageContext, spoken);
  }

  private async groundedTurn(
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
    userText: string,
    screen: string | null,
    spoken: string,
  ): Promise<ReadableStream<ChatChunk | string | FlushSentinel> | null> {
    const hasToolOutput = hasFreshToolOutput(chatCtx);

    const needsGrounding = isDataQuestion(userText) && !hasToolOutput;

    const switched = spoken !== this.answeredIn;

    // A switch turn is held back for a language check anyway, so start the corrective call now
    // rather than after the check fails (it would add a full LLM round trip). Unused if not needed.
    const languageRetry = switched ? this.languageRetry(chatCtx, toolCtx, modelSettings, spoken) : null;

    let stream: ReadableStream<ChatChunk | string | FlushSentinel> | null;
    try {
      stream = await super.llmNode(chatCtx, toolCtx, modelSettings);
    } catch (err) {
      console.error("[llm] failed", err);
      this.onStep("llm-error");
      return textToStream(RECOVERY_LINE);
    }
    if (!stream) {
      this.onStep("llm-empty");
      return textToStream(RECOVERY_LINE);
    }

    // Nothing succeeded this turn, so the reply may not say anything was done.
    const onClaim = actionSucceeded(chatCtx) ? undefined : () => this.claimRetry(chatCtx, toolCtx, modelSettings);

    if (!needsGrounding && !switched) {
      this.onStep("stream");
      return guardOpening(stream, this.recovered, onClaim);
    }

    let collected: Collected;
    try {
      collected = await collectStream(stream);
    } catch (err) {
      console.warn(`[llm] reply failed: ${String(err).slice(0, 120)}, speaking recovery line`);
      this.recovered();
      return textToStream(RECOVERY_LINE);
    }

    if (collected.calledTool) {
      this.onStep("tool");
      return guardOpening(replay(collected.chunks), this.recovered);
    }

    this.onStep(needsGrounding ? "checked" : "checked-lang");
    const grounded = await this.groundOrRetry(
      collected,
      { chatCtx, toolCtx, modelSettings, userText, screen, hasToolOutput, evidence: conversationEvidence(chatCtx, this.previous) },
    );
    if (grounded === null) {
      this.onStep("refused");
      return textToStream(SAFE_FALLBACK);
    }

    const spokenOut = await this.enforceLanguage(grounded, chatCtx, toolCtx, modelSettings, spoken, languageRetry);
    this.answeredIn = spoken;
    return guardOpening(replay(spokenOut.chunks), this.recovered, onClaim);
  }

  /** The turn again, told that nothing was done: it must act (call the tool) or say plainly it hasn't. */
  private async claimRetry(chatCtx: ChatContext, toolCtx: ToolContext, modelSettings: ModelSettings): Promise<Collected | null> {
    this.onStep("claim-retry");
    const retryCtx = chatCtx.copy();
    retryCtx.addMessage({ role: "system", content: ACTION_RETRY_INSTRUCTION });
    try {
      const stream = await super.llmNode(retryCtx, toolCtx, modelSettings);
      return stream ? await collectStream(stream) : null;
    } catch (err) {
      console.error("[claim] retry failed", err);
      return null;
    }
  }

  private async groundOrRetry(
    collected: Collected,
    ctx: {
      chatCtx: ChatContext;
      toolCtx: ToolContext;
      modelSettings: ModelSettings;
      userText: string;
      screen: string | null;
      hasToolOutput: boolean;
      evidence: ConversationEvidence;
    },
  ): Promise<Collected | null> {
    const { chatCtx, toolCtx, modelSettings, userText, screen, hasToolOutput, evidence } = ctx;

    if (
      !isUngrounded({
        userText,
        replyText: collected.text,
        calledTool: collected.calledTool,
        hasToolOutput,
        screen,
        evidence,
      })
    ) {
      return collected;
    }

    console.warn(`[grounding] ungrounded answer blocked: ${JSON.stringify(collected.text)}`);
    this.onStep("grounding-retry");

    const retryCtx = chatCtx.copy();
    retryCtx.addMessage({ role: "system", content: RETRY_INSTRUCTION });

    let retryStream: ReadableStream<ChatChunk | string | FlushSentinel> | null = null;
    try {
      retryStream = await super.llmNode(retryCtx, toolCtx, modelSettings);
    } catch (err) {
      console.error("[grounding] retry failed", err);
    }
    if (!retryStream) return null;

    let retried: Collected;
    try {
      retried = await collectStream(retryStream);
    } catch (err) {
      console.error("[grounding] retry failed", err);
      return null;
    }

    if (
      isUngrounded({
        userText,
        replyText: retried.text,
        calledTool: retried.calledTool,
        hasToolOutput,
        screen,
        evidence,
      })
    ) {
      console.warn("[grounding] retry still ungrounded — refusing to guess");
      return null;
    }

    console.log(`[grounding] recovered${retried.calledTool ? " via tool call" : ""}`);
    return retried;
  }

  private async enforceLanguage(
    out: Collected,
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
    spoken: string,
    prepared: Promise<Collected | null> | null = null,
  ): Promise<Collected> {
    if (out.calledTool || !out.text) return out;
    if (speaksLanguage(out.text, spoken)) return out;

    console.warn(`[lang] wrong language out (wanted ${spoken}): ${JSON.stringify(out.text.slice(0, 40))}`);
    this.onStep(prepared ? "lang-retry-early" : "lang-retry");

    const retried = await (prepared ?? this.languageRetry(chatCtx, toolCtx, modelSettings, spoken));
    if (retried?.text && speaksLanguage(retried.text, spoken)) {
      console.log(`[lang] recovered in ${spoken}`);
      return retried;
    }
    return out;
  }

  /** The same turn re-asked with only the current exchange and a hard language order. */
  private async languageRetry(
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
    spoken: string,
  ): Promise<Collected | null> {
    const name = languageName(spoken);
    const retryCtx = currentTurnOnly(chatCtx);
    applyInstructions(
      retryCtx,
      [
        `#### ANSWER ONLY IN ${name.toUpperCase()}. ####`,
        `The advisor spoke ${name}. Every single word of your reply must be in ${name}, in ${name}'s own script. Not one word of any other language.`,
        `Do not apologise. Do not mention the language. Do not repeat this instruction — it is not something the advisor said.`,
        this.lastContext ?? SYSTEM_PROMPT,
        // This retry drops the history (so the old language can't carry over); keep its facts as plain lines.
        `The conversation so far, for its facts only (names, addresses, times, what was agreed), not its language:\n${recentTranscript(chatCtx)}`,
      ].join("\n\n"),
    );

    try {
      const retryStream = await super.llmNode(retryCtx, toolCtx, modelSettings);
      return retryStream ? await collectStream(retryStream) : null;
    } catch (err) {
      console.error("[lang] retry failed", err);
      return null;
    }
  }

  private applyLanguage(text: string): void {
    const spoken = this.language.language;
    const language = speaksLanguage(text, spoken) ? spoken : ttsLanguageForText(text);
    if (language === this.ttsLanguage) return;
    this.ttsLanguage = language;
    this.sarvamTts.updateOptions({ targetLanguageCode: language });
  }

  async ttsNode(
    text: ReadableStream<string> | AsyncIterable<string>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<AudioFrame> | null> {
    const iterator = (text as AsyncIterable<string>)[Symbol.asyncIterator]();
    const buffered: string[] = [];

    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      buffered.push(value);
      if (value && value.trim()) {
        this.applyLanguage(value);
        break;
      }
    }

    // Everything spoken is noted as it is spoken: a reply that fails halfway (Vertex 429) is never saved to the
    // history, but the advisor heard it, and the read-back guard must count it (or it loops on "read it back").
    const turn = this.turn;
    const note = (chunk: string) => {
      turn.spoken = `${turn.spoken}${chunk}`.slice(-SPOKEN_MEMORY_CHARS);
    };
    const replayed = (async function* () {
      for (const chunk of buffered) {
        note(chunk);
        yield chunk;
      }
      while (true) {
        const { value, done } = await iterator.next();
        if (done) return;
        note(value);
        yield value;
      }
    })();

    return super.ttsNode(replayed, modelSettings);
  }
}
