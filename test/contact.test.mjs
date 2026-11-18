import test from "node:test";
import assert from "node:assert/strict";
import { readBack, spokenAddress } from "../src/contact.ts";

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
