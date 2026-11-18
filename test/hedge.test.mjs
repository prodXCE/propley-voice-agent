import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const { raceFirst, HedgeError } = await load("src/hedge.ts");

/** A fake stream: yields `items` after `delayMs`, or fails / ends empty. Records whether it was closed. */
function fake(label, { delayMs = 0, items = ["a", "b"], fail = false, log = [] } = {}) {
  let i = 0;
  const c = {
    label,
    closed: false,
    iterator: {
      next: () =>
        new Promise((resolve, reject) =>
          setTimeout(() => {
            if (fail) return reject(new Error(`${label} failed`));
            resolve(i < items.length ? { done: false, value: items[i++] } : { done: true, value: undefined });
          }, i === 0 ? delayMs : 0),
        ),
    },
    close() {
      c.closed = true;
    },
  };
  log.push(label);
  return c;
}

test("a fast primary wins and the backup is never started", async () => {
  const started = [];
  const r = await raceFirst(() => fake("primary", { delayMs: 20, log: started }), () => fake("backup", { log: started }), { hedgeMs: 200, deadlineMs: 2000 });
  assert.equal(r.winner.label, "primary");
  assert.equal(r.first, "a");
  assert.deepEqual(started, ["primary"]);
});

test("a slow primary is hedged: the backup answers first and the primary is closed", async () => {
  let primary;
  const r = await raceFirst(
    () => (primary = fake("primary", { delayMs: 1000 })),
    () => fake("backup", { delayMs: 30, items: ["x"] }),
    { hedgeMs: 100, deadlineMs: 3000 },
  );
  assert.equal(r.winner.label, "backup");
  assert.equal(r.first, "x");
  assert.equal(r.hedged, true);
  assert.equal(primary.closed, true);
});

test("a failing primary starts the backup at once, without waiting for the hedge", async () => {
  const t0 = Date.now();
  const r = await raceFirst(() => fake("primary", { delayMs: 10, fail: true }), () => fake("backup", { delayMs: 10 }), { hedgeMs: 1000, deadlineMs: 3000 });
  assert.equal(r.winner.label, "backup");
  assert.ok(Date.now() - t0 < 500, "did not wait for the hedge timer");
});

test("an empty primary counts as a failure and goes to the backup", async () => {
  const r = await raceFirst(() => fake("primary", { delayMs: 10, items: [] }), () => fake("backup", { delayMs: 10 }), { hedgeMs: 1000, deadlineMs: 3000 });
  assert.equal(r.winner.label, "backup");
});

test("both empty returns an empty winner rather than hanging", async () => {
  const r = await raceFirst(() => fake("primary", { items: [] }), () => fake("backup", { items: [] }), { hedgeMs: 1000, deadlineMs: 3000 });
  assert.equal(r.first, undefined);
});

test("both failing is an error, not a hang", async () => {
  await assert.rejects(
    raceFirst(() => fake("primary", { fail: true }), () => fake("backup", { fail: true }), { hedgeMs: 1000, deadlineMs: 3000 }),
    HedgeError,
  );
});

test("nothing by the deadline is an error, and both are closed", async () => {
  const made = [];
  const t0 = Date.now();
  await assert.rejects(
    raceFirst(
      () => (made[0] = fake("primary", { delayMs: 5000 })),
      () => (made[1] = fake("backup", { delayMs: 5000 })),
      { hedgeMs: 50, deadlineMs: 300 },
    ),
    /within 300 ms/,
  );
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(made.every((c) => c.closed));
});

test("an abort closes everything", async () => {
  const ac = new AbortController();
  let primary;
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(raceFirst(() => (primary = fake("primary", { delayMs: 5000 })), null, { hedgeMs: 1000, deadlineMs: 3000, signal: ac.signal }), /aborted/);
  assert.equal(primary.closed, true);
});
