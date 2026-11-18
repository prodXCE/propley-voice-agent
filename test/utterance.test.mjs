import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const { isMeaningfulUtterance, endsWithQuestion } = await load("src/utterance.ts");

test("a yes to the agent's question is answered (the stuck Hindi booking)", () => {
  for (const t of ["हाँ।", "हां।", "हाँ जी", "ठीक है", "haan", "ok", "okay", "sure", "yes", "जी"]) {
    assert.equal(isMeaningfulUtterance(t, true), true, t);
  }
});

test("hesitations are never a reply, even to a question", () => {
  for (const t of ["hmm", "uh", "umm", "हम्म", "अं"]) assert.equal(isMeaningfulUtterance(t, true), false, t);
});

test("backchannel after a statement is still ignored", () => {
  for (const t of ["हाँ।", "हां", "ok", "ठीक है", "hmm", "thank you"]) assert.equal(isMeaningfulUtterance(t), false, t);
  assert.equal(isMeaningfulUtterance("के नाम बताना ज़रा।"), true);
});

test("endsWithQuestion looks at the last agent line", () => {
  assert.equal(endsWithQuestion("Evening.\nक्या मैं 21 नवंबर को सुबह 8 बजे शेड्यूल कर दूँ?"), true);
  assert.equal(endsWithQuestion("Want me to pull them up?\nकैलेंडर खुल गया है।"), false);
  assert.equal(endsWithQuestion(""), false);
});
