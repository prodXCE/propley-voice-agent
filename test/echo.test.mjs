import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const { stripSelfEcho } = await load("src/echo.ts");

test("a Hindi question that starts like the last reply is not cut mid-word", () => {
  // The reply said "Rohan Kapoor के"; the question says "Rohan Kapoor का". It was cut to "ा डील स्टेज क्या है?".
  const said = "आज आपकी एक ही प्रेजेंटेशन है, Rohan Kapoor के साथ";
  assert.equal(stripSelfEcho("Rohan Kapoor का डील स्टेज क्या है?", said), "Rohan Kapoor का डील स्टेज क्या है?");
});

test("a real echo of the agent's own words is still removed", () => {
  const said = "आपके पास कुल सात प्रेजेंटेशन हैं";
  assert.equal(stripSelfEcho("आपके पास कुल सात प्रेजेंटेशन हैं ठीक है कल वाली दिखाओ", said), "ठीक है कल वाली दिखाओ");
  assert.equal(stripSelfEcho("you have five clients in total and what about Rahul", "You have five clients in total."), "and what about Rahul");
});
