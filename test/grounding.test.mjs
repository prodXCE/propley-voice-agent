import test from "node:test";
import assert from "node:assert/strict";
import { asksToRecall, isUngrounded } from "../src/grounding.ts";

const base = { calledTool: false, hasToolOutput: false, screen: null };

test("spelling back an address the advisor dictated is not blocked (the transcript's failure)", () => {
  const evidence = { said: "Alright, I have that email address.", heard: "Okay, it's rohanmehra@kestrel.in." };
  for (const userText of ["Can you just spell out the email for me again?", "Can you confirm me and spell back the email I just gave you?"]) {
    assert.equal(isUngrounded({ ...base, userText, replyText: "It's rohanmehra@kestrel.in.", evidence }), false, userText);
  }
});

test("echoing a dictated address while confirming it is grounded by the conversation", () => {
  const evidence = { said: "", heard: "Send it to rohanmehra@kestrel.in" };
  assert.equal(
    isUngrounded({ ...base, userText: "Send it to rohanmehra@kestrel.in", replyText: "Sending to rohanmehra@kestrel.in. What's the subject?", evidence }),
    false,
  );
});

test("an address nobody said is still blocked", () => {
  const evidence = { said: "", heard: "What's Rahul's email?" };
  assert.equal(isUngrounded({ ...base, userText: "What's Rahul's email?", replyText: "It's rahul@lodha.com.", evidence }), true);
});

test("the advisor's own numbers are still not evidence; earlier lookups are", () => {
  const heard = { said: "", heard: "I have 500 presentations, right? How many presentations do I have?" };
  assert.equal(isUngrounded({ ...base, userText: "How many presentations do I have?", replyText: "You have 500.", evidence: heard }), true);
  const looked = { said: '{"ok":true,"total":12}', heard: "How many presentations do I have?" };
  assert.equal(isUngrounded({ ...base, userText: "How many presentations do I have again?", replyText: "You have 12.", evidence: looked }), false);
});

test("recall requests are told apart from questions that merely end in 'again'", () => {
  for (const t of ["spell it back", "what did I just say?", "repeat that", "read the email back", "can you confirm what I said", "दोबारा बताओ"]) {
    assert.ok(asksToRecall(t), t);
  }
  for (const t of ["When is Rahul's presentation again?", "confirm Rahul's meeting time", "how many clients do I have"]) {
    assert.ok(!asksToRecall(t), t);
  }
});
