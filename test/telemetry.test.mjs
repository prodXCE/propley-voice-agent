import test from "node:test";
import assert from "node:assert/strict";
import { TurnRecorder, questionBefore } from "../src/telemetry.ts";

const msg = (id, role, textContent) => ({ id, type: "message", role, textContent });

test("an interrupted greeting answers nothing; the reply after it answers the typed message", () => {
  // History is in creation order: the greeting started before the advisor typed.
  const items = [msg("g", "assistant", "Afternoon, Dev."), msg("u", "user", "कल क्या है?"), msg("r", "assistant", "दो presentations हैं।")];
  assert.equal(questionBefore(items, "g"), "");
  assert.equal(questionBefore(items, "r"), "कल क्या है?");
});

test("a greeting stamped between a question and its answer is skipped", () => {
  const items = [msg("u", "user", "When is it?"), msg("g", "assistant", "Afternoon, Dev."), msg("r", "assistant", "At 4.")];
  assert.equal(questionBefore(items, "r", new Set(["g"])), "When is it?");
  assert.equal(questionBefore(items, "r"), "");
});

test("tool calls in between don't hide the question; an earlier reply does", () => {
  const items = [
    msg("u1", "user", "Where is Rahul's?"),
    { id: "f", type: "function_call" },
    msg("r1", "assistant", "Tomorrow at 4."),
    msg("r2", "assistant", "Anything else?"),
  ];
  assert.equal(questionBefore(items, "r1"), "Where is Rahul's?");
  assert.equal(questionBefore(items, "r2"), "");
});

test("said() logs the question it is given, with no language when there was none", () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  try {
    const t = new TurnRecorder("room", "1");
    t.heard("कल क्या है?", "hi-IN");
    t.said("Afternoon, Dev.", "en-IN", true, "");
    t.said("दो presentations हैं।", "hi-IN", false, "कल क्या है?");
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines.map((l) => [l.heard, l.heardLang]), [["", null], ["कल क्या है?", "hi-IN"]]);
});
