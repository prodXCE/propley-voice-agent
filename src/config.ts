import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env") });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`voice-agent: ${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`voice-agent: ${name} must be true or false, got ${JSON.stringify(raw)}`);
}

export type SttProvider = "deepgram" | "sarvam";

export const STT_PROVIDER: SttProvider =
  process.env.STT_PROVIDER === "deepgram" ? "deepgram" : "sarvam";

export const DEEPGRAM_STT_MODEL = process.env.DEEPGRAM_STT_MODEL ?? "deepgram/flux-general-multi";
export const DEEPGRAM_EAGER_EOT = num("DEEPGRAM_EAGER_EOT", 0.5);
export const DEEPGRAM_EOT = num("DEEPGRAM_EOT", 0.7);

export const SARVAM_STT_MODEL = "saaras:v3";
export const SARVAM_STT_MODE = "transcribe";
export const SARVAM_STT_LANGUAGE = "unknown";

export const INTERRUPTION_MIN_DURATION_MS = num("INTERRUPTION_MIN_DURATION_MS", 250);
export const INTERRUPTION_MIN_WORDS = num("INTERRUPTION_MIN_WORDS", 0);

export const VAD_ACTIVATION_THRESHOLD = num("VAD_ACTIVATION_THRESHOLD", 0.6);
export const VAD_MIN_SPEECH_MS = num("VAD_MIN_SPEECH_MS", 150);
/** Silence before the VAD calls end of speech (Silero's default is 550). It starts the filler, the STT flush
 * and the endpointing clock, so it bounds how fast anything can answer. */
export const VAD_MIN_SILENCE_MS = num("VAD_MIN_SILENCE_MS", 250);

/** Silence before Sarvam is told to finalize. Not at the VAD's 250 ms: that split "Okay, thanks. How many…" at
 * the comma and lost the rest. Sarvam's own silence detection takes ~750 ms. */
export const STT_FLUSH_SILENCE_MS = num("STT_FLUSH_SILENCE_MS", 500);

/** After the VAD's end of speech, before the turn may be committed: 250 + 700 = 950 ms of silence, as before
 * (550 + 400). Committing sooner bought nothing — the answer is gated by the LLM, which already starts at the
 * flushed transcript (~650 ms) via preemptive generation — and at 750 ms "Sorry, … rename Tapaswin" was cut
 * at the comma. Mid-sentence pauses up to ~900 ms are common. */
export const ENDPOINTING_MIN_DELAY_MS = num("ENDPOINTING_MIN_DELAY_MS", 700);
export const ENDPOINTING_MAX_DELAY_MS = num("ENDPOINTING_MAX_DELAY_MS", 1600);

export const GREETING =
  process.env.GREETING ?? "Hi, I'm your Propley assistant. What can I do for you?";

export const TTS_MODEL = "bulbul:v3" as const;
export const TTS_SPEAKER = process.env.TTS_SPEAKER ?? "shubh";
export const TTS_TEMPERATURE = num("TTS_TEMPERATURE", 0.85);
export const TTS_PACE = num("TTS_PACE", 1.0);
export const TTS_SAMPLE_RATE = num("TTS_SAMPLE_RATE", 24000);

export const BACKGROUND_AUDIO_SAMPLE_RATE = 48000;

export const TTS_STREAMING = bool("TTS_STREAMING", true);

export const GEMINI_MODEL = process.env.VERTEX_MODEL ?? "gemini-2.5-flash";

export const LLM_TEMPERATURE = num("LLM_TEMPERATURE", 0.5);
/** Advisors' clock, for "today" / "tomorrow" (IANA zone). */
export const ADVISOR_TIMEZONE = process.env.ADVISOR_TIMEZONE?.trim() || "Asia/Kolkata";
export const VERTEX_PROJECT = process.env.VERTEX_PROJECT?.trim() ?? "";
export const VERTEX_LOCATION = process.env.VERTEX_LOCATION?.trim() ?? "us-central1";
/** Second region used when the primary fails (e.g. a 429 from shared capacity). Empty disables it. */
export const VERTEX_FALLBACK_LOCATION = (process.env.VERTEX_FALLBACK_LOCATION ?? "asia-southeast1").trim();

export const RPC_TIMEOUT_MS = num("RPC_TIMEOUT_MS", 10_000);

export const IDLE_PROCESSES = num("IDLE_PROCESSES", 3);

export const DRAIN_TIMEOUT_MS = num("DRAIN_TIMEOUT_MS", 30_000);

export const WORKER_PORT = num("PORT", 8081);

export const FILLER_CACHE_DIR =
  process.env.FILLER_CACHE_DIR ?? resolve(tmpdir(), "propley-voice", "fillers");

export const VOICE_LANGUAGES = (process.env.VOICE_LANGUAGES ?? "")
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean);

/** After the VAD's end of speech: VAD_MIN_SILENCE_MS + this ≈ when the advisor first hears the agent (aim: 200-500 ms). */
export const FILLER_DELAY_MS = num("FILLER_DELAY_MS", 30);
/** Fillers at most this often, so pauses inside one sentence don't get an "Mm-hmm" each. */
export const FILLER_MIN_GAP_MS = num("FILLER_MIN_GAP_MS", 2500);
/** A tool still running after this, with nothing said, gets a "one moment". */
export const SLOW_TOOL_MS = num("SLOW_TOOL_MS", 1500);

/** Start the backup region when the primary has no first token by now (about its p90 TTFT). */
export const LLM_HEDGE_MS = num("LLM_HEDGE_MS", 1100);
/** No first token from either region by now: fail the call (recovery line) instead of hanging the turn. */
export const LLM_DEADLINE_MS = num("LLM_DEADLINE_MS", 6000);
/** After this much of a turn, skip the grounding / language / claim retries and answer with what there is. */
export const TURN_RETRY_BUDGET_MS = num("TURN_RETRY_BUDGET_MS", 3500);

export function bootstrapVertexCredentials(): void {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;

  let raw = process.env.VERTEX_CREDENTIAL?.trim();
  if (!raw) return;

  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    raw = raw.slice(1, -1);
  }

  try {
    JSON.parse(raw);
  } catch {
    throw new Error(
      "voice-agent: VERTEX_CREDENTIAL is not valid JSON. Prefer mounting the service account as a file and setting GOOGLE_APPLICATION_CREDENTIALS.",
    );
  }

  const dir = resolve(tmpdir(), "propley-voice");
  const file = resolve(dir, "vertex-sa.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, raw, { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
}

export function assertConfigured(): void {
  const missing: string[] = [];
  if (!process.env.LIVEKIT_URL) missing.push("LIVEKIT_URL");
  if (!process.env.LIVEKIT_API_KEY) missing.push("LIVEKIT_API_KEY");
  if (!process.env.LIVEKIT_API_SECRET) missing.push("LIVEKIT_API_SECRET");

  if (!process.env.SARVAM_API_KEY) missing.push("SARVAM_API_KEY");
  if (!VERTEX_PROJECT) missing.push("VERTEX_PROJECT");
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) missing.push("VERTEX_CREDENTIAL");

  if (missing.length > 0) {
    throw new Error(`voice-agent is missing required env: ${missing.join(", ")}`);
  }
}
