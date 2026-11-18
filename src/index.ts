import {
  cli,
  defineAgent,
  inference,
  llm,
  voice,
  WorkerOptions,
  type JobContext,
  type JobProcess,
} from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import * as silero from "@livekit/agents-plugin-silero";
import { BackgroundVoiceCancellation } from "@livekit/noise-cancellation-node";
import { fileURLToPath } from "node:url";
import { PropleyAgent } from "./agent.js";
import { BrowserBridge } from "./browser-bridge.js";
import { previousConversation } from "./previous.js";
import { composeGreeting, type PipelineSnapshot } from "./greeting.js";
import { FILLER_LANGUAGES, pickFiller } from "./fillers.js";
import { FillerCache } from "./filler-cache.js";
import {
  assertConfigured,
  BACKGROUND_AUDIO_SAMPLE_RATE,
  bootstrapVertexCredentials,
  DEEPGRAM_EAGER_EOT,
  DEEPGRAM_EOT,
  DEEPGRAM_STT_MODEL,
  GEMINI_MODEL,
  ENDPOINTING_MAX_DELAY_MS,
  ENDPOINTING_MIN_DELAY_MS,
  FILLER_DELAY_MS,
  GREETING,
  IDLE_PROCESSES,
  DRAIN_TIMEOUT_MS,
  WORKER_PORT,
  INTERRUPTION_MIN_DURATION_MS,
  LLM_TEMPERATURE,
  INTERRUPTION_MIN_WORDS,
  SARVAM_STT_LANGUAGE,
  SARVAM_STT_MODE,
  SARVAM_STT_MODEL,
  STT_PROVIDER,
  TTS_MODEL,
  TTS_PACE,
  TTS_SAMPLE_RATE,
  TTS_SPEAKER,
  TTS_STREAMING,
  TTS_TEMPERATURE,
  VAD_ACTIVATION_THRESHOLD,
  VOICE_LANGUAGES,
  VAD_MIN_SPEECH_MS,
  VERTEX_FALLBACK_LOCATION,
  VERTEX_LOCATION,
  VERTEX_PROJECT,
} from "./config.js";
import { DEFAULT_TTS_LANGUAGE } from "./language.js";
import { silentAmbience } from "./silence.js";
import { TurnRecorder, questionBefore } from "./telemetry.js";

bootstrapVertexCredentials();
assertConfigured();

process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] unhandled rejection, call kept alive:", reason);
});

async function buildGreeting(bridge: BrowserBridge): Promise<string> {
  const advisor = await bridge.advisor();
  try {
    const summary = (await bridge.executeTool("dashboard_summary", {})) as PipelineSnapshot & {
      error?: string;
    };
    if (!summary || summary.error) return composeGreeting(null, advisor);
    return composeGreeting(summary, advisor);
  } catch {
    return composeGreeting(null, advisor);
  }
}

function buildStt(vocabulary: string[], domains: string[] = []) {
  if (STT_PROVIDER === "sarvam") {
    const hints = [
      vocabulary.length > 0 ? `Names and projects that may be spoken: ${vocabulary.join(", ")}.` : "",
      domains.length > 0 ? `Email domains that may be spoken: ${domains.join(", ")}.` : "",
    ].filter(Boolean);
    return new sarvam.STT({
      model: SARVAM_STT_MODEL,
      mode: SARVAM_STT_MODE,
      languageCode: SARVAM_STT_LANGUAGE,
      ...(hints.length > 0 ? { prompt: `${hints.join(" ")} Transcribe these exactly as written.` } : {}),
    });
  }

  return new inference.STT({
    model: DEEPGRAM_STT_MODEL,
    modelOptions: {
      eager_eot_threshold: DEEPGRAM_EAGER_EOT,
      eot_threshold: DEEPGRAM_EOT,
      ...(vocabulary.length > 0 ? { keyterm: vocabulary } : {}),
    },
  });
}

function buildLlm(): llm.LLM {
  const gemini = (location: string) =>
    new google.LLM({
      model: GEMINI_MODEL,
      vertexai: true,
      project: VERTEX_PROJECT,
      location,
      temperature: LLM_TEMPERATURE,
      thinkingConfig: { thinkingBudget: 0 },
    });
  if (!VERTEX_FALLBACK_LOCATION || VERTEX_FALLBACK_LOCATION === VERTEX_LOCATION) return gemini(VERTEX_LOCATION);

  // A 429 means the region's shared capacity is momentarily full; the other region has its own pool.
  // The SDK logs each switch ("failed, switching to next LLM") and recovery ("LLM recovered").
  return new llm.FallbackAdapter({
    llms: [gemini(VERTEX_LOCATION), gemini(VERTEX_FALLBACK_LOCATION)],
    attemptTimeout: 5,
  });
}

function buildTts(): sarvam.TTS {
  return new sarvam.TTS({
    model: TTS_MODEL,
    speaker: TTS_SPEAKER,
    targetLanguageCode: DEFAULT_TTS_LANGUAGE,
    temperature: TTS_TEMPERATURE,
    pace: TTS_PACE,
    sampleRate: TTS_SAMPLE_RATE,
    streaming: TTS_STREAMING,
  });
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load({
      activationThreshold: VAD_ACTIVATION_THRESHOLD,
      minSpeechDuration: VAD_MIN_SPEECH_MS,
    });

    const fillers = new FillerCache(buildTts(), BACKGROUND_AUDIO_SAMPLE_RATE, `${TTS_MODEL}/${TTS_SPEAKER}`);
    proc.userData.fillers = fillers;

    void fillers
      .warmAll([DEFAULT_TTS_LANGUAGE, ...FILLER_LANGUAGES])
      .then(() => console.log(`[filler] ${fillers.size} clips across ${fillers.languages} languages`))
      .catch((err) => console.warn("[filler] warm failed", err));
  },

  entry: async (ctx: JobContext) => {
    const t0 = Date.now();
    const since = () => `${Date.now() - t0}ms`;

    await ctx.connect();
    console.log(`[boot] room connected ${since()}`);

    const participant = await ctx.waitForParticipant();
    console.log(`[boot] participant joined ${since()}`);
    const bridge = new BrowserBridge(ctx.room, participant.identity);

    const [{ terms: vocabulary, domains }, previous] = await Promise.all([bridge.vocabulary(), bridge.history()]);
    console.log(
      `[boot] vocabulary: ${vocabulary.length} terms, ${domains.length} email domains; previous session: ${previous?.messages.length ?? 0} lines ${since()}`,
    );

    const tts = buildTts();

    console.log(
      `[config] tts=${TTS_MODEL}/${TTS_SPEAKER} streaming=${TTS_STREAMING} | stt=${STT_PROVIDER === "sarvam" ? SARVAM_STT_MODEL : DEEPGRAM_STT_MODEL} | llm=${GEMINI_MODEL}`,
    );

    const session = new voice.AgentSession({
      connOptions: {
        // The SDK ends the call after this many LLM failures with nothing spoken in between. One turn
        // can fail several calls at once (preemptive, main, language retry), so 3 (the default) would
        // hang up mid-outage; the recovery line resets the count whenever it is spoken.
        maxUnrecoverableErrors: 8,
        llmConnOptions: { maxRetry: 1, retryIntervalMs: 300, timeoutMs: 8000 },
        ttsConnOptions: { maxRetry: 1, retryIntervalMs: 300 },
      },
      turnHandling: {
        interruption: {
          enabled: true,
          mode: "vad",
          minDuration: INTERRUPTION_MIN_DURATION_MS,
          minWords: INTERRUPTION_MIN_WORDS,
          backchannelBoundary: null,
        },
        endpointing: {
          minDelay: ENDPOINTING_MIN_DELAY_MS,
          maxDelay: ENDPOINTING_MAX_DELAY_MS,
        },
        preemptiveGeneration: {
          enabled: true,
          preemptiveTts: true,
        },
      },
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: buildStt(vocabulary, domains),
      llm: buildLlm(),
      tts,
    });

    const turn = new TurnRecorder(ctx.room.name ?? "unknown", participant.identity);

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      turn.metric(ev.metrics as Record<string, unknown> & { type: string });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;

      agent.noteSpokenLanguage(ev.language, ev.transcript);
      turn.heard(ev.transcript, ev.language ?? null);
    });

    let greetingText: string | null = null; // set when the greeting is spoken; cleared once it is logged
    const greetingIds = new Set<string>(); // the logged greeting, skipped when matching later questions
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.type === "message" && ev.item.role === "assistant") {
        const text = ev.item.textContent ?? "";
        // The greeting (session.say) is stamped when it ends, after any message typed during it, so history
        // order can't tell it answered nothing. Its text (or the start of it, if cut off) gives it away.
        const isGreeting = greetingText !== null && text.trim() !== "" && greetingText.startsWith(text.trim());
        if (isGreeting) {
          greetingText = null;
          greetingIds.add(ev.item.id);
        }
        turn.said(
          text,
          agent.currentLanguage,
          ev.item.interrupted,
          isGreeting ? "" : questionBefore(session.history.items, ev.item.id, greetingIds),
        );
      }
    });

    session.on(voice.AgentSessionEventTypes.EotPrediction, (ev) => {
      turn.eotPrediction(ev.probability, ev.threshold);
    });

    bridge.onRpc = (timing) => turn.rpcDone(timing);

    const agent = new PropleyAgent(bridge, tts, vocabulary, VOICE_LANGUAGES, domains, previousConversation(previous));
    agent.onStep = (step) => turn.step(step);

    const fillerCache = ctx.proc.userData.fillers as FillerCache;

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
        // Typed chat (lk.chat): same as LiveKit's default, plus reading the language off the text.
        textInputCallback: (sess, ev) => {
          turn.heard(ev.text, agent.noteTypedLanguage(ev.text));
          // Typed in, typed out: no speech, so the reply arrives as text at once and isn't held back by
          // (or cut off during) audio nobody asked for. Speaking turns audio back on.
          sess.output.setAudioEnabled(false);
          sess.interrupt();
          sess.generateReply({ userInput: ev.text });
        },
      },
    });

    const backgroundAudio = new voice.BackgroundAudioPlayer({
      ambientSound: silentAmbience(BACKGROUND_AUDIO_SAMPLE_RATE),
    });
    await backgroundAudio.start({ room: ctx.room, agentSession: session });

    let fillerTimer: ReturnType<typeof setTimeout> | null = null;
    let fillerHandle: voice.PlayHandle | null = null;

    const cancelFiller = () => {
      if (fillerTimer) {
        clearTimeout(fillerTimer);
        fillerTimer = null;
      }
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      cancelFiller();
      if (ev.newState === "speaking" && !session.output.audioEnabled) session.output.setAudioEnabled(true);
      if (ev.oldState !== "speaking" || ev.newState === "speaking") return;
      bridge.prefetchPageContext();
      if (FILLER_DELAY_MS <= 0) return;

      fillerTimer = setTimeout(() => {
        fillerTimer = null;

        if (session.agentState !== "listening") return;

        const language = agent.currentLanguage;
        const filler = pickFiller(language);
        const frames = fillerCache.frameStream(language, filler);

        if (!frames) {
          void fillerCache.warm(language).catch(() => {});
          return;
        }

        console.log(`[filler] (${language}) ${filler}`);
        fillerHandle = backgroundAudio.play(frames);
        turn.fillerStarted();
      }, FILLER_DELAY_MS);
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState !== "speaking") return;
      turn.agentSpeaking(ev.createdAt);
      cancelFiller();

      fillerHandle?.stop();
      fillerHandle = null;
    });

    ctx.room.localParticipant?.registerRpcMethod("agent.interrupt", async () => {
      session.interrupt();
      return "{}";
    });

    console.log(`[boot] session started ${since()}`);

    const greeting = await buildGreeting(bridge);
    greetingText = greeting.trim();
    session.say(greeting, { allowInterruptions: true });
    console.log(`[ready] greeting speaking, already listening ${since()}`);

    console.log(`[filler] ${fillerCache.size} clips ready across ${fillerCache.languages} languages ${since()}`);
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    numIdleProcesses: IDLE_PROCESSES,

    drainTimeout: DRAIN_TIMEOUT_MS,
    port: WORKER_PORT,
  }),
);
