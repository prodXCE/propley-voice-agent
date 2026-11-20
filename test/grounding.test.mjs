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

import { claimsDone } from "../src/grounding.ts";

test("replies that say an action happened are recognised", () => {
  for (const t of [
    "I've updated Shanaya's profile.",
    "I've scheduled the site visit for tomorrow at 6 PM.",
    "It's been sent.",
    "Done, I've added Tapaswin.",
    "ठीक है, मैंने विक्रम को ईमेल भेज दिया है।",
    "मीटिंग बुक कर दिया है।",
    "Whether or not you asked, I've sent it.",
  ]) assert.ok(claimsDone(t), t);
});

test("facts, offers and questions are not claims", () => {
  for (const t of [
    "You have seven completed meetings, and one live right now.",
    "Rahul's presentation is on the 21st at 4 PM.",
    "Shall I schedule it for tomorrow at 6?",
    "The draft is on your screen; check it and tap Send.",
    "I can add Tapaswin as a new client. Should I?",
    "I haven't done that yet. Want me to go ahead?",
    // The advisor's actions, and open questions (the bench's "did the email go out?" replies)
    "I can't see whether you sent it. I put the draft on your screen last time.",
    "I can't tell whether you sent it. I put the draft on your screen, and you would have tapped Send.",
    "I can't tell if it has been sent.",
    "Did you send it?",
  ]) assert.ok(!claimsDone(t), t);
});
