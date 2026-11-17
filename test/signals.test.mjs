import assert from "node:assert/strict";
import { test } from "node:test";
import { CLEAR_STATUS, Signals, folderReport, oneLine, statusReport, titleReport } from "../dist/signals.js";

const msg = report => Buffer.from(report.match(/:msg=([A-Za-z0-9+/=]+)/)?.[1] ?? "", "base64").toString("utf8");

test("a status report carries the state, what a blocked session waits on, the program and a reason", () => {
  assert.equal(statusReport({ state: "idle" }, "claude-tsp"), "\x1b]7501;state=idle:app=claude-tsp\x1b\\");
  assert.equal(statusReport({ state: "working" }, "claude-tsp"), "\x1b]7501;state=working:app=claude-tsp\x1b\\");
  const blocked = statusReport({ state: "blocked", kind: "permission", msg: "Run this command? rm -rf build" }, "claude-tsp");
  assert.match(blocked, /^\x1b\]7501;state=blocked:kind=permission:app=claude-tsp:msg=[A-Za-z0-9+/=]+\x1b\\$/);
  assert.equal(msg(blocked), "Run this command? rm -rf build");
  assert.equal(msg(statusReport({ state: "error", msg: "API Error: 529\nOverloaded" }, "claude-tsp")), "API Error: 529 Overloaded");
  // A reason is for a block or a failure only, and an empty one is left out.
  assert.equal(statusReport({ state: "blocked", kind: "question", msg: " \n " }, "claude-tsp"), "\x1b]7501;state=blocked:kind=question:app=claude-tsp\x1b\\");
});

test("what is told is one printable line within the protocol's limits", () => {
  assert.equal(oneLine("a\x1b[31m\tb\r\nc\x07  d", 80), "a [31m b c d");
  assert.equal([...oneLine("é".repeat(500), 240)].length, 240);
  const long = statusReport({ state: "error", msg: "x".repeat(5000) }, "claude-tsp");
  assert.ok(long.length < 3300 && Buffer.byteLength(msg(long)) <= 2048);
  // Nothing in a report can end the sequence early or start another.
  for (const report of [long, titleReport("a\x07b\x1b]0;c"), statusReport({ state: "idle" }, "bad app;name:x=y")]) assert.equal(report.slice(2, -1).replace(/\x1b\\?$/, "").search(/[\x00-\x1f\x7f]/), -1, JSON.stringify(report));
  assert.equal(statusReport({ state: "idle" }, "bad app;name:x=y"), "\x1b]7501;state=idle:app=badappnamexy\x1b\\");
  assert.equal(folderReport("/home/me/my project/é", "box"), "\x1b]7;file://box/home/me/my%20project/%C3%A9\x07");
});

test("each signal is written when it changes, and the record is taken back at the end", () => {
  const out = [];
  const signals = new Signals(text => out.push(text), "claude-tsp", "/proj");
  signals.status({ state: "idle" });
  signals.status({ state: "idle" });
  signals.title("");
  signals.folder("/proj");
  assert.equal(out.length, 1, "an unchanged status, no name and the starting folder write nothing");
  signals.status({ state: "working" });
  signals.title("Fix the login bug");
  signals.title("Fix the login bug");
  signals.folder("/proj/.claude/worktrees/x");
  assert.deepEqual(out.slice(1), ["\x1b]7501;state=working:app=claude-tsp\x1b\\", "\x1b]0;Fix the login bug\x07", folderReport("/proj/.claude/worktrees/x")]);

  // Another program takes the terminal: ours is taken back, and told again afterwards.
  out.length = 0;
  signals.release();
  assert.deepEqual(out, [CLEAR_STATUS, "\x1b]0;\x07"]);
  signals.status({ state: "working" });
  signals.title("Fix the login bug");
  assert.equal(out.length, 4);

  out.length = 0;
  signals.status({ state: "done" });
  signals.close();
  assert.deepEqual(out.slice(1), [CLEAR_STATUS, "\x1b]0;\x07"]);
  signals.status({ state: "working" });
  signals.close();
  assert.equal(out.length, 3, "nothing is written after the end");
});
