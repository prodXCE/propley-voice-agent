import type { RpcTiming } from "./browser-bridge.js";

export interface TurnMetrics {
  endpointingMs?: number;
  sttLagMs?: number;
  llmTtftMs?: number;
  ttsTtfbMs?: number;
}

interface LlmCall {
  ttftMs?: number;
  durationMs?: number;
  promptTokens?: number;
  cachedTokens?: number;
  cancelled?: boolean;
}

const round = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;

const since = (start: number | undefined, end: number | undefined): number | undefined =>
  start && end && end >= start ? end - start : undefined;

/**
 * One JSON line per agent reply (`evt: "turn"`). A turn collects everything after the previous
 * reply (filler, prefetch, transcripts, metrics) and closes when the agent's reply is added.
 */
export class TurnRecorder {
  private metrics: TurnMetrics = {};
  private transcript = "";
  private heardLanguage: string | null = null;
  private index = 0;

  private userStoppedAt?: number;
  private eot?: { probability: number; threshold: number };
  private llm: LlmCall[] = [];
  private rpc: RpcTiming[] = [];
  private steps: string[] = [];
  private fillerAt?: number;
  private speakingAt?: number;

  constructor(
    private readonly room: string,
    private readonly advisor: string,
  ) {}

  private reset(): void {
    this.metrics = {};
    this.transcript = "";
    this.userStoppedAt = undefined;
    this.eot = undefined;
    this.llm = [];
    this.rpc = [];
    this.steps = [];
    this.fillerAt = undefined;
    this.speakingAt = undefined;
  }

  heard(transcript: string, language: string | null): void {
    // A long utterance can arrive as several finals; keep them in one turn.
    this.transcript = this.transcript ? `${this.transcript} ${transcript}` : transcript;
    this.heardLanguage = language;
  }

  metric(m: Record<string, unknown> & { type: string }): void {
    if (m.type === "eou_metrics") {
      this.metrics.endpointingMs = round(m.endOfUtteranceDelayMs);
      this.metrics.sttLagMs = round(m.transcriptionDelayMs);
      const stoppedAt = round(m.lastSpeakingTimeMs);
      if (stoppedAt) this.userStoppedAt = stoppedAt;
    } else if (m.type === "llm_metrics") {
      this.metrics.llmTtftMs ??= round(m.ttftMs);
      this.llm.push({
        ttftMs: round(m.ttftMs),
        durationMs: round(m.durationMs),
        promptTokens: round(m.promptTokens),
        cachedTokens: round(m.promptCachedTokens),
        ...(m.cancelled ? { cancelled: true } : {}),
      });
    } else if (m.type === "tts_metrics") {
      this.metrics.ttsTtfbMs ??= round(m.ttfbMs);
    }
  }

  eotPrediction(probability: number, threshold: number): void {
    this.eot = { probability: Math.round(probability * 1000) / 1000, threshold };
  }

  rpcDone(timing: RpcTiming): void {
    this.rpc.push(timing);
  }

  step(name: string): void {
    this.steps.push(name);
  }

  fillerStarted(): void {
    this.fillerAt ??= Date.now();
  }

  agentSpeaking(at: number): void {
    this.speakingAt ??= at;
  }

  /** Legacy estimate, kept so new logs stay comparable with older ones. */
  private timeToFirstSound(): number | undefined {
    const { endpointingMs, sttLagMs, llmTtftMs, ttsTtfbMs } = this.metrics;
    if (llmTtftMs === undefined || ttsTtfbMs === undefined) return undefined;

    const thinking = (sttLagMs ?? 0) + llmTtftMs;
    return Math.round(Math.max(endpointingMs ?? 0, thinking) + ttsTtfbMs);
  }

  said(reply: string, replyLanguage: string | null, interrupted = false): void {
    if (!reply.trim()) return;

    console.log(
      JSON.stringify({
        evt: "turn",
        ts: new Date().toISOString(),
        room: this.room,
        advisor: this.advisor,
        n: ++this.index,
        heard: this.transcript,
        heardLang: this.heardLanguage,
        said: reply,
        saidLang: replyLanguage,
        ...(interrupted ? { interrupted: true } : {}),
        // Measured: user stopped speaking -> first agent audio frame / first filler clip.
        e2eMs: since(this.userStoppedAt, this.speakingAt),
        fillerMs: since(this.userStoppedAt, this.fillerAt),
        firstSoundMs: this.timeToFirstSound(),
        ...this.metrics,
        eotProb: this.eot?.probability,
        eotThreshold: this.eot?.threshold,
        llmCalls: this.llm.length,
        llm: this.llm,
        rpc: this.rpc,
        steps: this.steps,
      }),
    );
    this.reset();
  }
}
