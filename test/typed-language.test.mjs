import test from "node:test";
import assert from "node:assert/strict";
import { typedLanguage } from "../src/language.ts";

test("Indian scripts are read straight off the text", () => {
  assert.equal(typedLanguage("Arjun के plot पर पानी का क्या arrangement है?"), "hi-IN");
  assert.equal(typedLanguage("কাল কী আছে?"), "bn-IN");
  assert.equal(typedLanguage("நாளை என்ன இருக்கிறது?"), "ta-IN");
});

test("Hindi typed in English letters counts as Hindi", () => {
  assert.equal(typedLanguage("Rahul ka meeting kab hai?"), "hi-IN");
  assert.equal(typedLanguage("mujhe kal ke presentations batao"), "hi-IN");
  assert.equal(typedLanguage("Sofia ne pets ke baare mein kuch kaha tha kya"), "hi-IN");
});

test("English stays English, even with one Hindi-looking word", () => {
  assert.equal(typedLanguage("What did Rahul say about parking?"), null);
  assert.equal(typedLanguage("Reschedule Calendar Test's presentation to tomorrow at 1 pm."), null);
  assert.equal(typedLanguage("Book Ka Wing for Sofia"), null);
  assert.equal(typedLanguage("ok thanks"), null);
  assert.equal(typedLanguage(""), null);
});
