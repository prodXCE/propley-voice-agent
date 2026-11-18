import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const { LanguagePolicy } = await load("src/language-policy.ts");

test("Hindi in Devanagari switches even when the STT is unsure (the engineer's Hinglish)", () => {
  const p = new LanguagePolicy("en-IN");
  const d = p.observe({ detected: "hi-IN", transcript: "अच्छा क्लाइंट पोर्टफोलियो कितने सारे हैं?", confidence: 0.55 });
  assert.equal(d.language, "hi-IN");
  assert.equal(d.switched, true);
});

test("and switches back for an English question", () => {
  const p = new LanguagePolicy("en-IN");
  p.observe({ detected: "hi-IN", transcript: "अच्छा क्लाइंट पोर्टफोलियो कितने सारे हैं?", confidence: 0.55 });
  assert.equal(p.observe({ detected: "en-IN", transcript: "Okay, and total presentations?", confidence: 0.98 }).language, "en-IN");
});

test("an unsure tag on Latin text still does not switch", () => {
  const p = new LanguagePolicy("en-IN");
  const d = p.observe({ detected: "hi-IN", transcript: "acha clients kitne saare hain", confidence: 0.55 });
  assert.equal(d.language, "en-IN");
});

test("a one-word Devanagari blip is still not enough", () => {
  const p = new LanguagePolicy("en-IN");
  assert.equal(p.observe({ detected: "hi-IN", transcript: "हाँ।", confidence: 0.4 }).language, "en-IN");
});
