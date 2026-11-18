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
 *   node scripts/bench.mjs --scenario email --log <worker log>
 *                                             # dictated email addresses through real STT: is the address heard,
 *                                             # remembered, corrected and spelled back right? (local worker only)
 *   node scripts/bench.mjs --scenario names --log <worker log>
 *                                             # spoken new names and renames: is "Tapaswin" kept apart from an
 *                                             # existing "Tapaswan", and fixed with rename_client? (local worker only)
 *   node scripts/bench.mjs --scenario memory --log <worker log>
 *                                             # a previous session served by history.get: is it recalled, and
 *                                             # is nothing in it claimed as done? (local worker only)
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
const SCENARIO = arg("scenario", null);
const WORKER_LOG = arg("log", null);

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

// Dictation conversations (--scenario email): one call each. `expect` = the address that turn must produce,
// either spelled back by the agent or passed to send_email. Only reaches the fake browser: nothing is sent.
const EMAIL_CONVERSATIONS = [
  [
    { lang: "en-IN", text: "Can you send an email to a new contact for me?" },
    { lang: "en-IN", text: "Their email is rohan dot mehra at kestrel dot in. Tell them the site visit is on Saturday at eleven.", expect: "rohan.mehra@kestrel.in" },
    { lang: "en-IN", text: "Yes, that's right.", expect: "rohan.mehra@kestrel.in" },
    { lang: "en-IN", text: "Actually, change it. It's r o h a n m, at kestrel dot in.", expect: "rohanm@kestrel.in" },
    { lang: "en-IN", text: "Yes.", expect: "rohanm@kestrel.in" },
  ],
  [
    { lang: "en-IN", text: "Email Sneha the Palm Grove brochure. Her address is s n e h a dot k at q u v a dot in.", expect: "sneha.k@quva.in" },
    { lang: "en-IN", text: "No, the domain is q u v a. Q as in queen. quva dot in.", expect: "sneha.k@quva.in" },
    { lang: "en-IN", text: "Yes, that's it.", expect: "sneha.k@quva.in" },
  ],
  [
    { lang: "hi-IN", text: "Vikram ko email bhejna hai. Uska email hai vikram dot shah at kestrel dot in. Bolo ki Monday ko call karenge.", expect: "vikram.shah@kestrel.in" },
    { lang: "hi-IN", text: "Haan, sahi hai.", expect: "vikram.shah@kestrel.in" },
  ],
];

// Memory across sessions (--scenario memory): the fake browser serves a previous session through history.get;
// `expect` = words the reply must contain, `never` = words it must not.
const PREVIOUS_SESSION = {
  sessionId: "propley-voice-bench-previous",
  endedAt: "2026-11-17T11:40:00Z",
  messages: [
    { role: "advisor", text: "Tell me about Vikram Shah.", at: "2026-11-17T11:31:00Z" },
    { role: "assistant", text: "Vikram Shah is a new lead from Thane, interested in Lakeview Residences.", at: "2026-11-17T11:31:05Z" },
    { role: "advisor", text: "He wants a three BHK under two crore. Email him the Lakeview brochure.", at: "2026-11-17T11:32:00Z" },
    { role: "assistant", text: "The draft is on your screen. Check it and tap Send.", at: "2026-11-17T11:32:08Z" },
  ],
};
const MEMORY_CONVERSATION = [
  { lang: "en-IN", text: "What were we discussing last time?", expect: ["vikram"] },
  { lang: "en-IN", text: "What budget did I mention for him?", expect: ["two crore|2 crore"] },
  { lang: "en-IN", text: "Did the brochure email go out?", never: ["^(yes|it went|it was sent|it has been sent)\\b", "\\bwent out\\b(?! or)", "haven't done that", "\\b(is|'s) (still )?on your screen"] },
];

// Spoken names (--scenario names): a new name must not be pulled onto the existing "Tapaswan", and a misheard
// one is fixed with rename_client. `check` gets that turn's tool calls; the fake CRM changes nothing.
// Saved as said (not the existing Tapaswan) and in English letters: a name saved in Hindi script never matches again.
const notTapaswan = (calls) => {
  const saved = calls.filter((c) => c.name === "add_customer").map((c) => String(c.args?.name ?? "")).at(-1);
  return saved !== undefined && !/tapaswan/i.test(saved) && /^[A-Za-z .'-]+$/.test(saved);
};
const NAME_CONVERSATIONS = [
  [
    { lang: "en-IN", text: "Add a new client named Tapaswin.", check: notTapaswan, what: "add_customer, not as Tapaswan" },
    { lang: "en-IN", text: "Yes, go ahead.", check: (calls) => calls.some((c) => c.name === "confirm_action"), what: "confirm_action" },
    {
      lang: "en-IN",
      text: "Sorry, I got the name wrong. Please rename Tapaswin to Tapasvi.",
      check: (calls) => calls.some((c) => c.name === "rename_client" && /tapas[vw]i\b/i.test(String(c.args?.new_name ?? ""))),
      what: "rename_client to Tapasvi",
    },
    { lang: "en-IN", text: "Yes.", check: (calls) => calls.some((c) => c.name === "confirm_action"), what: "confirm_action" },
  ],
  [
    { lang: "hi-IN", text: "एक नया क्लाइंट जोड़ो, नाम है Tapaswin.", check: notTapaswan, what: "add_customer, not as Tapaswan" },
    { lang: "hi-IN", text: "हाँ, कर दो।", check: (calls) => calls.some((c) => c.name === "confirm_action"), what: "confirm_action" },
  ],
];

/** "r-o-h-a-n dot m at kestrel dot in" / "R O H A N.M@kestrel.in" -> "rohan.m@kestrel.in" */
function normalizeAddress(text) {
  return String(text)
    .toLowerCase()
    .replace(/\s+(dot|डॉट)\s+/g, ".")
    .replace(/\s+(at|एट)\s+/g, "@")
    .replace(/[\s,\-–—'"]/g, "");
}

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
// --scenario names: the CRM already has "Tapaswan", the name the engineer's "Tapaswin" was merged into.
const VOCABULARY = [...CLIENTS.map((c) => c.name), ...(SCENARIO === "names" ? ["Tapaswan"] : []), "Ivory Heights", "Lakeview Residences", "Palm Grove"];

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
    case "add_customer":
      return { staged: true, needsConfirmation: true, summary: `Add ${args?.name} as a new client?` };
    case "rename_client":
      return { staged: true, needsConfirmation: true, summary: `Rename ${args?.client} to ${args?.new_name}?` };
    case "confirm_action":
      return args?.confirm === false ? { ok: true, message: "Cancelled." } : { ok: true, message: "Done." };
    case "send_email":
      return { awaitingApproval: true, note: "The draft is on their screen with Send and Cancel buttons. Tell them in one short line to check it and tap Send. It has NOT happened yet." };
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
async function runCall(round, clips, utterances = UTTERANCES) {
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
  // Email domains of the fake CRM's contacts, as the real browser sends them (the dictation scenario's
  // addresses are at these known domains).
  local.registerRpcMethod("vocabulary.get", async () => JSON.stringify({ terms: VOCABULARY, domains: ["kestrel.in", "quva.in"] }));
  const toolCalls = []; // { turn, name, args } — which utterance each call answered
  let turnIndex = -1;
  local.registerRpcMethod("tool.execute", async (d) => {
    const { name, args } = JSON.parse(d.payload);
    toolCalls.push({ turn: turnIndex, name, args });
    return JSON.stringify({ ok: true, result: toolResult(name, args) });
  });
  local.registerRpcMethod("history.get", async () => JSON.stringify({ session: SCENARIO === "memory" ? PREVIOUS_SESSION : null }));
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
    for (const [i, u] of utterances.entries()) {
      await sleep(1200);
      turnIndex = i;
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
    return SCENARIO ? { roomName, results, toolCalls } : results;
  } finally {
    pumping = false;
    await pump.catch(() => {});
    await room.disconnect();
  }
}

// ---- main ---------------------------------------------------------------------------------
/** The worker's turn lines for one bench room, greeting skipped. */
function workerTurns(roomName) {
  return readFileSync(WORKER_LOG, "utf8")
    .split("\n")
    .filter((l) => l.includes('"evt":"turn"') && l.includes(`"room":"${roomName}"`))
    .map((l) => JSON.parse(l.slice(l.indexOf("{"))))
    .filter((t) => t.heard);
}

if (SCENARIO === "names") {
  if (!WORKER_LOG) throw new Error("--scenario names needs --log <the local worker's log file>");
  let passed = 0, checked = 0;
  for (const [c, conversation] of NAME_CONVERSATIONS.entries()) {
    const convClips = [];
    for (const u of conversation) convClips.push(await utteranceAudio(u));
    console.log(`\nconversation ${c + 1}:`);
    const { roomName, toolCalls } = await runCall(c + 1, convClips, conversation);
    await sleep(1500);
    const turns = workerTurns(roomName);
    for (const [i, u] of conversation.entries()) {
      const calls = toolCalls.filter((x) => x.turn === i);
      const ok = u.check(calls);
      checked++;
      if (ok) passed++;
      console.log(`  said : ${u.text}\n  heard: ${turns[i]?.heard ?? "(nothing)"}\n  agent: ${turns[i]?.said ?? "(nothing)"}`);
      console.log(`  tools: ${calls.map((x) => `${x.name} ${JSON.stringify(x.args)}`).join("; ") || "(none)"}\n  ${ok ? "PASS" : "FAIL"}  expected ${u.what}`);
    }
  }
  console.log(`\n${passed}/${checked} name checks passed`);
  process.exit(0);
}

if (SCENARIO === "memory") {
  if (!WORKER_LOG) throw new Error("--scenario memory needs --log <the local worker's log file>");
  const clips = [];
  for (const u of MEMORY_CONVERSATION) clips.push(await utteranceAudio(u));
  const { roomName } = await runCall(1, clips, MEMORY_CONVERSATION);
  await sleep(1500);
  const turns = workerTurns(roomName);
  let passed = 0;
  for (const [i, u] of MEMORY_CONVERSATION.entries()) {
    const said = String(turns[i]?.said ?? "");
    const ok = (u.expect ?? []).every((w) => new RegExp(w, "i").test(said)) && !(u.never ?? []).some((w) => new RegExp(w, "i").test(said));
    if (ok) passed++;
    console.log(`  said : ${u.text}\n  heard: ${turns[i]?.heard ?? "(nothing)"}\n  agent: ${said || "(nothing)"}\n  ${ok ? "PASS" : "FAIL"}`);
  }
  console.log(`\n${passed}/${MEMORY_CONVERSATION.length} memory checks passed`);
  process.exit(0);
}

if (SCENARIO === "email") {
  if (!WORKER_LOG) throw new Error("--scenario email needs --log <the local worker's log file> to read what was heard and said");
  let passed = 0, checked = 0;
  for (const [c, conversation] of EMAIL_CONVERSATIONS.entries()) {
    const convClips = [];
    for (const u of conversation) convClips.push(await utteranceAudio(u));
    console.log(`\nconversation ${c + 1}:`);
    const { roomName, toolCalls } = await runCall(c + 1, convClips, conversation);
    await sleep(1500); // let the worker flush its last turn line
    const turns = readFileSync(WORKER_LOG, "utf8")
      .split("\n")
      .filter((l) => l.includes('"evt":"turn"') && l.includes(`"room":"${roomName}"`))
      .map((l) => JSON.parse(l.slice(l.indexOf("{"))))
      .filter((t) => t.heard); // skip the greeting
    for (const [i, u] of conversation.entries()) {
      const t = turns[i] ?? {};
      const sent = toolCalls.filter((x) => x.turn === i && x.name === "send_email").map((x) => String(x.args?.to ?? ""));
      console.log(`  said : ${u.text}`);
      console.log(`  heard: ${t.heard ?? "(nothing)"}`);
      console.log(`  agent: ${t.said ?? "(nothing)"}${sent.length ? `   [send_email to ${sent.join(", ")}]` : ""}`);
      if (!u.expect) continue;
      checked++;
      const ok = normalizeAddress(t.said ?? "").includes(u.expect) || sent.some((to) => to.toLowerCase() === u.expect);
      if (ok) passed++;
      console.log(`  ${ok ? "PASS" : "FAIL"}  expected ${u.expect}`);
    }
  }
  console.log(`\n${passed}/${checked} address checks passed`);
  process.exit(0);
}

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
