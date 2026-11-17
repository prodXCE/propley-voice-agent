#!/usr/bin/env node
/**
 * Synthetic caller: joins a LiveKit room as a fake advisor, speaks pre-recorded utterances,
 * answers the worker's browser RPCs with fixed data, and measures client-side latency
 * (end of our speech -> first audible agent audio / filler).
 *
 * Usage (from voice-agent/):
 *   npm run bench:worker                      # terminal 1: local worker, explicit dispatch only
 *   node scripts/bench.mjs [--rounds 3] [--agent propley-bench] [--out file.json]
 *   node scripts/bench.mjs --auto             # no dispatch: whatever auto-dispatched worker joins (prod)
 *
 * Worker-side numbers: run scripts/turn-report.py over the worker's log.
 */
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";
import { config as loadEnv } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(ROOT, ".env"), quiet: true });

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ROUNDS = Number(arg("rounds", "3"));
const AUTO = process.argv.includes("--auto");
const AGENT_NAME = arg("agent", "propley-bench");
const OUT = arg("out", null);

const RATE = 16000;
const FRAME = RATE / 100; // 10 ms
const CACHE = resolve(ROOT, ".bench-cache");
const STATE_ATTR = "lk.agent.state";
const LEVEL = 500; // int16 RMS that counts as audible

// Read-only questions only: nothing here may stage a change.
const UTTERANCES = [
  { lang: "en-IN", text: "How many live presentations do I have right now?" },
  { lang: "en-IN", text: "Who is my next presentation with?" },
  { lang: "en-IN", text: "Tell me about Rohan Kapoor." },
  { lang: "en-IN", text: "Which clients are in negotiation?" },
  { lang: "en-IN", text: "Who is number three on this list?" },
  { lang: "en-IN", text: "What's a good way to follow up with a client who has gone quiet?" },
  { lang: "hi-IN", text: "आज मेरी कितनी presentations हैं?" },
  { lang: "hi-IN", text: "रोहन कपूर का deal stage क्या है?" },
  { lang: "en-IN", text: "Okay, thanks. How many clients do I have in total?" },
];

// ---- fake browser -------------------------------------------------------------------------
const CLIENTS = [
  { id: "c1", name: "Rohan Kapoor", city: "Mumbai", dealStage: "negotiation", status: "active", project: "Ivory Heights", lastContact: "2026-11-12" },
  { id: "c2", name: "Meera Iyer", city: "Pune", dealStage: "offer", status: "active", project: "Lakeview Residences", lastContact: "2026-11-15" },
  { id: "c3", name: "Arjun Malhotra", city: "Mumbai", dealStage: "site-visit", status: "active", project: "Ivory Heights", lastContact: "2026-11-02" },
  { id: "c4", name: "Kavya Nair", city: "Bengaluru", dealStage: "negotiation", status: "active", project: "Palm Grove", lastContact: "2026-10-28" },
  { id: "c5", name: "Vikram Shah", city: "Thane", dealStage: "lead", status: "new", project: "Lakeview Residences", lastContact: "2026-11-16" },
];
const MEETINGS = [
  { client: "Meera Iyer", property: "Lakeview Residences", date: "2026-11-18", time: "16:30", salesMember: "Dev Advisor", status: "live" },
  { client: "Rohan Kapoor", property: "Ivory Heights", date: "2026-11-19", time: "11:00", salesMember: "Dev Advisor", status: "scheduled" },
  { client: "Kavya Nair", property: "Palm Grove", date: "2026-11-20", time: "15:00", salesMember: "Dev Advisor", status: "scheduled" },
  { client: "Arjun Malhotra", property: "Ivory Heights", date: "2026-11-21", time: "12:00", salesMember: "Dev Advisor", status: "scheduled" },
];
const PAGE = {
  path: "/meetings",
  page: "Presentations",
  advisor: "Dev Advisor",
  wizard: null,
  onScreen: [
    "Presentations listed on screen, in order:\n" +
      MEETINGS.map((m, i) => `${i + 1}. ${m.client} — ${m.property} on ${m.date} at ${m.time}, advisor ${m.salesMember} (${m.status})`).join("\n"),
  ],
};
const VOCABULARY = [...CLIENTS.map((c) => c.name), "Ivory Heights", "Lakeview Residences", "Palm Grove"];

function toolResult(name, args) {
  const q = String(args?.name ?? args?.query ?? args?.client ?? "").toLowerCase();
  const client = CLIENTS.find((c) => q && c.name.toLowerCase().includes(q.split(" ")[0])) ?? CLIENTS[0];
  switch (name) {
    case "dashboard_summary":
      return { activeMeetings: 1, totalMeetings: MEETINGS.length, totalClients: CLIENTS.length, upcomingToday: 1, byStage: { lead: 1, "site-visit": 1, negotiation: 2, offer: 1 } };
    case "list_meetings":
    case "filter_meetings":
      return { total: MEETINGS.length, meetings: MEETINGS };
    case "list_clients":
      return { total: CLIENTS.length, clients: args?.stage ? CLIENTS.filter((c) => c.dealStage === args.stage) : CLIENTS };
    case "get_client":
    case "client_brief":
      return { ...client, email: "client@example.com", phone: "+91 90000 00000", notes: ["Prefers sea-facing units", "Budget around 4 crore"] };
    case "navigate":
      return { page: String(args?.page ?? "Presentations"), counts: { total: MEETINGS.length } };
    default:
      return { ok: true };
  }
}

// ---- audio --------------------------------------------------------------------------------
async function utteranceAudio({ lang, text }) {
  mkdirSync(CACHE, { recursive: true });
  const file = resolve(CACHE, `${createHash("sha1").update(`${lang}|${text}`).digest("hex").slice(0, 16)}.pcm`);
  if (existsSync(file)) return new Int16Array(new Uint8Array(readFileSync(file)).buffer);

  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": process.env.SARVAM_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ text, target_language_code: lang, speaker: "aditya", model: "bulbul:v3", speech_sample_rate: String(RATE), output_audio_codec: "wav" }),
  });
  if (!res.ok) throw new Error(`sarvam tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const wav = Buffer.from((await res.json()).audios[0], "base64");
  const data = wav.indexOf("data");
  if (wav.readUInt32LE(24) !== RATE || data < 0) throw new Error("unexpected wav from sarvam");
  let pcm = new Int16Array(new Uint8Array(wav.subarray(data + 8)).buffer);
  let end = pcm.length;
  while (end > 0 && Math.abs(pcm[end - 1]) < 300) end--; // trim trailing silence
  pcm = pcm.slice(0, end);
  writeFileSync(file, Buffer.from(pcm.buffer));
  return pcm;
}

const rms = (frame) => {
  let sum = 0;
  for (const s of frame.data) sum += s * s;
  return Math.sqrt(sum / frame.data.length);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))] : "-";
};

// ---- one call -----------------------------------------------------------------------------
async function runCall(round, clips) {
  const roomName = `propley-bench-${randomBytes(4).toString("hex")}`;
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: "bench-advisor", name: "Dev Advisor" });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  const room = new Room();
  const agents = new Map(); // identity -> state
  const heardAt = { roomio_audio: 0, background_audio: 0 };
  let armed = Infinity;

  room.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
    if (STATE_ATTR in changed) agents.set(p.identity, changed[STATE_ATTR]);
  });
  room.on(RoomEvent.TrackSubscribed, async (track, pub) => {
    if (!(pub.name in heardAt)) return;
    for await (const frame of new AudioStream(track, RATE, 1)) {
      const now = Date.now();
      if (now > armed && !heardAt[pub.name] && rms(frame) > LEVEL) heardAt[pub.name] = now;
    }
  });

  await room.connect(process.env.LIVEKIT_URL, await at.toJwt(), { autoSubscribe: true, dynacast: false });
  const local = room.localParticipant;
  local.registerRpcMethod("context.get", async () => JSON.stringify(PAGE));
  local.registerRpcMethod("vocabulary.get", async () => JSON.stringify({ terms: VOCABULARY }));
  local.registerRpcMethod("tool.execute", async (d) => {
    const { name, args } = JSON.parse(d.payload);
    return JSON.stringify({ ok: true, result: toolResult(name, args) });
  });
  local.registerRpcMethod("wizard.input", async () => JSON.stringify({ prompt: "Okay.", done: true }));

  const source = new AudioSource(RATE, 1);
  const track = LocalAudioTrack.createAudioTrack("mic", source);
  await local.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

  // Continuous mic: silence between utterances, like a real open microphone.
  let queue = new Int16Array(0);
  let speechEndsAt = 0;
  let pumping = true;
  const pump = (async () => {
    const t0 = Date.now();
    let sent = 0;
    while (pumping) {
      while (sent * 10 < Date.now() - t0 + 60) {
        const chunk = new Int16Array(FRAME);
        if (queue.length) {
          chunk.set(queue.subarray(0, FRAME));
          queue = queue.subarray(Math.min(FRAME, queue.length));
          if (!queue.length) speechEndsAt = t0 + (sent + 1) * 10;
        }
        await source.captureFrame(new AudioFrame(chunk, RATE, 1, FRAME));
        sent++;
      }
      await sleep(5);
    }
  })();

  if (!AUTO) await new AgentDispatchClient(process.env.LIVEKIT_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET).createDispatch(roomName, AGENT_NAME);

  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await sleep(20);
    }
    return false;
  };
  const state = () => [...agents.values()][0];

  try {
    if (!(await waitFor(() => agents.size > 0, 30_000))) throw new Error("no agent joined (is the worker running with LIVEKIT_AGENT_NAME?)");
    await sleep(1500);
    if (agents.size > 1) throw new Error(`${agents.size} agents joined the bench room; results would be mixed`);
    // Greeting: wait for it to start and finish.
    await waitFor(() => state() === "speaking", 15_000);
    await waitFor(() => state() === "listening", 30_000);

    const results = [];
    for (const [i, u] of UTTERANCES.entries()) {
      await sleep(1200);
      heardAt.roomio_audio = 0;
      heardAt.background_audio = 0;
      speechEndsAt = 0;
      queue = clips[i];
      await waitFor(() => speechEndsAt > 0, 20_000);
      armed = speechEndsAt;

      const spoke = await waitFor(() => state() === "speaking", 20_000);
      await waitFor(() => state() === "listening", 40_000);
      await waitFor(() => heardAt.roomio_audio > 0, 1500);

      const r = {
        round,
        n: i + 1,
        lang: u.lang,
        text: u.text,
        replyMs: heardAt.roomio_audio ? heardAt.roomio_audio - speechEndsAt : null,
        fillerMs: heardAt.background_audio ? heardAt.background_audio - speechEndsAt : null,
        ...(spoke ? {} : { noReply: true }),
      };
      results.push(r);
      console.log(`  [${round}.${r.n}] reply ${r.replyMs ?? "-"} ms  filler ${r.fillerMs ?? "-"} ms  ${u.text}`);
    }
    return results;
  } finally {
    pumping = false;
    await pump.catch(() => {});
    await room.disconnect();
  }
}

// ---- main ---------------------------------------------------------------------------------
const clips = [];
for (const u of UTTERANCES) clips.push(await utteranceAudio(u));
console.log(`bench: ${UTTERANCES.length} utterances x ${ROUNDS} rounds, ${AUTO ? "auto-dispatch" : `explicit dispatch to "${AGENT_NAME}"`}`);

const all = [];
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`call ${round}:`);
  all.push(...(await runCall(round, clips)));
}

const replies = all.map((r) => r.replyMs).filter((v) => v !== null);
const fillers = all.map((r) => r.fillerMs).filter((v) => v !== null);
console.log(`\nclient-side, ms   n   p50   p75   p90   max`);
console.log(`reply audio     ${String(replies.length).padStart(3)} ${[50, 75, 90, 100].map((p) => String(pct(replies, p)).padStart(5)).join(" ")}`);
console.log(`filler audio    ${String(fillers.length).padStart(3)} ${[50, 75, 90, 100].map((p) => String(pct(fillers, p)).padStart(5)).join(" ")}`);
console.log(`no reply: ${all.filter((r) => r.noReply).length}`);
if (OUT) writeFileSync(OUT, JSON.stringify(all, null, 2));
process.exit(0);
