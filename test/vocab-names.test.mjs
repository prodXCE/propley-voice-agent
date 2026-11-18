import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const { introducesName, snapToVocabulary } = await load("src/vocab.ts");

test("a new or corrected name is not snapped to an existing client (the Tapaswin/Tapaswan merge)", () => {
  for (const t of [
    "Add a new client named Tapaswin",
    "add client Tapaswin, site visit tomorrow",
    "It's Tapaswin, not Tapaswan",
    "rename Tapaswan to Tapaswin",
    "नया क्लाइंट जोड़ो, Tapaswin",
  ]) assert.ok(introducesName(t), t);
});

test("ordinary questions still get snapped", () => {
  for (const t of ["Tell me about Tapasvan", "When is Rahul's presentation?", "Move Priya to negotiation"]) {
    assert.ok(!introducesName(t), t);
  }
  assert.equal(snapToVocabulary("Tell me about Tapasvan", ["Tapaswan", "Rahul Verma"]), "Tell me about Tapaswan");
});
