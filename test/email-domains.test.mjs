import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const { snapEmailDomains } = await load("src/vocab.ts");

const known = ["kestrel.in", "quva.in", "mandake.co.in"];

test("misheard known domains snap back (the bench's failures)", () => {
  assert.equal(snapEmailDomains("Uska email hai Vikram.शह@castrel.in bolo", known), "Uska email hai Vikram.शह@kestrel.in bolo");
  assert.equal(snapEmailDomains("Her address is sneha.k@kuva.in", known), "Her address is sneha.k@quva.in");
  assert.equal(snapEmailDomains("write to a@mandeke.co.in", known), "write to a@mandake.co.in");
  assert.equal(snapEmailDomains("Vikram.शह@castrail.in", known), "Vikram.शह@kestrel.in");
  assert.equal(snapEmailDomains("उसका ईमेल है Vikram.शह@केस्ट्रेल.इन, बोलो", known), "उसका ईमेल है Vikram.शह@kestrel.in, बोलो");
});

test("unknown, well-known and differently-ended domains are left alone", () => {
  assert.equal(snapEmailDomains("priya@gmail.com", known), "priya@gmail.com");
  assert.equal(snapEmailDomains("rohan@castrel.com", known), "rohan@castrel.com"); // .com is not .in
  assert.equal(snapEmailDomains("x@kava.in", ["quva.in"]), "x@kava.in"); // letters differ too much
  assert.equal(snapEmailDomains("no address here, see you at castrel dot", known), "no address here, see you at castrel dot");
  assert.equal(snapEmailDomains("a@castrel.in", []), "a@castrel.in");
});

test("a short company domain said as one syllable is snapped to the known one", () => {
  const ours = ["auum.in", "quva.in"];
  for (const heard of ["om", "AWM", "aoum", "aum", "ohm"]) assert.equal(snapEmailDomains(`ashish.roy@${heard}.in`, ours), "ashish.roy@auum.in");
  assert.equal(snapEmailDomains("x@kava.in", ours), "x@kava.in");
  assert.equal(snapEmailDomains("x@221.com", ours), "x@221.com");
  assert.equal(snapEmailDomains("x@om.com", ours), "x@om.com"); // a different ending is a different domain
});
