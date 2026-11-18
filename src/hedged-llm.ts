import { APIConnectionError, llm } from "@livekit/agents";
import { HedgeError, raceFirst, type Candidate } from "./hedge.js";

type ChatOptions = Parameters<llm.LLM["chat"]>[0];

/**
 * Two Vertex regions as one LLM, hedged (hedge.ts): the backup starts when the primary is slow to its first
 * token (or fails), the first to answer wins, and no first token by the deadline fails the call fast instead
 * of hanging the turn. Replaces the FallbackAdapter, which waited out a 5 s timeout before even trying the
 * backup and then ran a full-prompt "recovery" call in the background.
 */
export class HedgedLLM extends llm.LLM {
  constructor(
    readonly primary: llm.LLM,
    readonly backup: llm.LLM | null,
    readonly opts: { hedgeMs: number; deadlineMs: number; streamTimeoutMs: number },
  ) {
    super();
    for (const inner of [primary, backup]) {
      if (!inner) continue;
      inner.on("metrics_collected", (m) => this.emit("metrics_collected", m));
      // Inner failures surface here as an empty stream (the race moves on); this stream's own error is what
      // the session sees. Without a listener, an inner "error" event would throw.
      inner.on("error", () => {});
    }
  }

  get model(): string {
    return this.primary.model;
  }

  label(): string {
    return "HedgedLLM";
  }

  chat(opts: ChatOptions): llm.LLMStream {
    return new HedgedStream(this, opts);
  }

  /** One tiny request per region: auth token, TLS and HTTP/2 set up before the advisor's first question. */
  async warm(): Promise<void> {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: "user", content: "Reply with one word: ok" });
    await Promise.all(
      [this.primary, this.backup].filter((l): l is llm.LLM => l !== null).map(async (l) => {
        const s = l.chat({ chatCtx: ctx, connOptions: { maxRetry: 0, timeoutMs: 10_000, retryIntervalMs: 0 } });
        try {
          for await (const _ of s) break;
        } finally {
          s.close();
        }
      }),
    );
  }
}

class HedgedStream extends llm.LLMStream {
  constructor(
    private readonly hedged: HedgedLLM,
    private readonly opts: ChatOptions,
  ) {
    super(hedged, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      // The hedge is the retry: a second full attempt would double the worst case.
      connOptions: { ...(opts.connOptions ?? { timeoutMs: 10_000, retryIntervalMs: 0 }), maxRetry: 0 },
    });
  }

  protected async run(): Promise<void> {
    const { primary, backup, opts } = this.hedged;
    const start = (inner: llm.LLM, label: string): Candidate<llm.ChatChunk> => {
      const stream = inner.chat({
        ...this.opts,
        chatCtx: this.chatCtx,
        toolCtx: this.toolCtx,
        connOptions: { maxRetry: 0, timeoutMs: opts.streamTimeoutMs, retryIntervalMs: 0 },
      });
      return { label, iterator: stream[Symbol.asyncIterator](), close: () => stream.close() };
    };

    let result;
    try {
      result = await raceFirst(
        () => start(primary, "primary"),
        backup ? () => start(backup, "backup") : null,
        { hedgeMs: opts.hedgeMs, deadlineMs: opts.deadlineMs, signal: this.abortController.signal },
      );
    } catch (err) {
      if (err instanceof HedgeError && err.message === "aborted") return;
      throw new APIConnectionError({ message: `LLM: ${err instanceof Error ? err.message : String(err)}`, options: { retryable: false } });
    }
    if (result.hedged) console.warn(`[llm] hedged: ${result.winner.label} answered first`);

    try {
      if (result.first !== undefined) this.queue.put(result.first);
      for (;;) {
        const r = await result.winner.iterator.next();
        if (r.done || this.abortController.signal.aborted) break;
        this.queue.put(r.value);
      }
    } finally {
      result.winner.close();
    }
  }
}
