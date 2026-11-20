import test from "node:test";
import assert from "node:assert/strict";
import { spellOut, spokenAddress } from "../src/contact.ts";

test("a spelled-out address reads back as the same address", () => {
  for (const a of ["rohan.m@kestrel.in", "sneha.k@quva.in", "priya@gmail.com"]) {
    assert.equal(spokenAddress(spellOut(a)), a);
  }
  assert.equal(spellOut("priya@gmail.com"), "p-r-i-y-a at gmail dot com");
  assert.equal(spellOut("rohan.m@kestrel.in"), "r-o-h-a-n dot m at k-e-s-t-r-e-l dot in");
});
