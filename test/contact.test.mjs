import test from "node:test";
import assert from "node:assert/strict";
import { dictatedAddressInstruction, readBack, spokenAddress } from "../src/contact.ts";

test("spoken and spelled forms reduce to one address", () => {
  assert.equal(spokenAddress("r-o-h-a-n dot m, at kestrel dot in"), "rohan.m@kestrel.in");
  assert.equal(spokenAddress("It's S N E H A dot K at quva dot in"), "itssneha.k@quva.in");
  assert.equal(spokenAddress("v-i-k-r-a-m dot s-h-a-h at kestrel dot in"), "vikram.shah@kestrel.in");
});

test("a dictated address counts as read back only once the agent said that exact address", () => {
  const said = "I heard s-n-e-h-a dot k at k-u-v-a dot in. Is that right?";
  assert.equal(readBack("sneha.k@kuva.in", said), true);
  assert.equal(readBack("sneha.k@quva.in", said), false); // corrected after the read-back: read it back again
  assert.equal(readBack("sneha.k@kuva.in", "What should the email say?"), false);
});

test("an address heard in English letters gets the exact read-back, and never a request to spell it", () => {
  const text = dictatedAddressInstruction("Uska email hai vikram.shah@kestrel.in, bolo ki Monday ko call karenge.");
  assert.match(text, /"v-i-k-r-a-m dot s-h-a-h at k-e-s-t-r-e-l dot in"/);
  assert.match(text, /NEVER ask them to spell it/);
});

test("an address heard half in Devanagari (the Hindi failure) is written in English letters by the model, not asked for", () => {
  const text = dictatedAddressInstruction("Vikram को ईमेल Palm है। उसका ईमेल है Vikram.शह@kestrel.in, बोलो कि मंडे को कॉल करेंगे।");
  assert.doesNotMatch(text, /keeping the letters as English letters: "/); // no exact read-back of a half-heard address
  assert.match(text, /"dot" and "at" said as words/);
  assert.match(text, /English letters yourself/);
  assert.match(text, /NEVER ask them to spell it/);
});
