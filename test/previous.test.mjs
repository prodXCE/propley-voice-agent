import test from "node:test";
import assert from "node:assert/strict";
import { previousConversation } from "../src/previous.ts";
import { asksToRecall } from "../src/grounding.ts";

const session = (messages) => ({ endedAt: "2026-11-17T09:30:00Z", messages });

test("no previous session gives nothing", () => {
  assert.equal(previousConversation(null), "");
  assert.equal(previousConversation(session([])), "");
});

test("the previous session reads as Advisor/You lines under a dated heading", () => {
  const block = previousConversation(
    session([
      { role: "advisor", text: "Add a new client named Shanaya" },
      { role: "assistant", text: "Saved \"Shanaya\" as a new client." },
    ]),
  );
  assert.match(block, /^## Your previous conversation with this advisor \(Tuesday, 17 November/);
  assert.match(block, /\nAdvisor: Add a new client named Shanaya\nYou: Saved "Shanaya" as a new client\.$/);
  assert.doesNotMatch(block, /left out/);
});

test("a long session keeps its newest lines", () => {
  const messages = Array.from({ length: 80 }, (_, i) => ({ role: "advisor", text: `line ${i} ${"x".repeat(80)}` }));
  const block = previousConversation(session(messages));
  assert.match(block, /\(earlier lines left out\)/);
  assert.match(block, /line 79 x+$/);
  assert.doesNotMatch(block, /line 0 /);
  const kept = block.slice(block.indexOf("(earlier lines left out)") + "(earlier lines left out)".length);
  assert.ok(kept.length <= 4000, String(kept.length));
});

test("asking about last time is a recall question", () => {
  for (const q of ["What were we discussing last time?", "what did I ask you earlier", "last time what did we talk about", "पिछली बार क्या बात हुई थी?"]) {
    assert.equal(asksToRecall(q), true, q);
  }
  for (const q of ["How many presentations last week?", "Show me earlier presentations"]) {
    assert.equal(asksToRecall(q), false, q);
  }
});

test("the previous session is marked as over, so its drafts are not described as on screen now", () => {
  const block = previousConversation(session([{ role: "assistant", text: "The draft is on your screen. Check it and tap Send." }]));
  assert.match(block, /That session is OVER/);
  assert.match(block, /Never say it is on their screen now/);
});

test("the agent's own 'no record' from last time is left out, so it searches again instead of repeating it", () => {
  const block = previousConversation(
    session([
      { role: "advisor", text: "What budget did I mention for Tapaswin?" },
      { role: "assistant", text: "I have no record of you mentioning a budget for Tapaswin." },
    ]),
  );
  assert.match(block, /Advisor: What budget did I mention for Tapaswin\?$/);
  assert.doesNotMatch(block, /You: I have no record/);
});
