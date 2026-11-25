import assert from "node:assert/strict";
import test from "node:test";
import { dispatchOrdered } from "../lib/ordered-dispatch.mjs";

test("dispatches by lane, expected duration and waiting time while filling multiple slots", async () => {
  const tasks = [
    { id: "bot", lane: "maintenance", family: "quick", enqueuedAt: 0 },
    { id: "long", lane: "foreground", family: "slow", enqueuedAt: 1000 },
    { id: "short", lane: "foreground", family: "quick", enqueuedAt: 1000 },
    { id: "aged", lane: "foreground", family: "slow", enqueuedAt: 0 },
    { id: "release", lane: "release", family: "slow", enqueuedAt: 1000 },
  ];
  const sent = [];
  const signals = [];
  let finishRelease;
  await dispatchOrdered(tasks, { quick: [10, 20, 30], slow: [400, 500, 600] }, {
    capacity: 2,
    now: () => 1000,
    dispatch: task => {
      sent.push(task.id);
      return task.id;
    },
    started: id => {
      signals.push(id);
      if (id === "aged") finishRelease();
    },
    completed: id => id === "release" ? new Promise(resolve => { finishRelease = resolve; }) : Promise.resolve(),
  });
  assert.deepEqual(sent, ["release", "aged", "short", "long", "bot"]);
  assert.deepEqual(signals, sent);
});

test("refuses missing own task history before dispatch", async () => {
  const tasks = [{ lane: "foreground", family: "unknown", enqueuedAt: 0 }];
  await assert.rejects(dispatchOrdered(tasks, {}, { capacity: 2 }), /elapsed-duration samples/);
});
