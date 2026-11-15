import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrace, traced, untraced, usesTracing } from "../dist/trace.js";

test("a traced command gets a one-line prelude that comes off again for display", () => {
  const command = traced("echo one\necho two", "/tmp/x/1");
  assert.equal(command.split("\n").length, 3);
  assert.match(command, /BASH_XTRACEFD/);
  assert.equal(untraced(command), "echo one\necho two");
  assert.equal(untraced("echo plain"), "echo plain");
});

test("a trace is read for line numbers and times only, the prelude's own line left out", () => {
  const text = ["+\t100.000000\t1\texec {x}>/tmp/f", "++\t100.000100\t2\techo secret-value", "+\t100.250000\t3\techo two", "not a trace line"].join("\n");
  assert.deepEqual(parseTrace(text), { steps: [{ line: 1, at: 0, depth: 2 }, { line: 2, at: 249.9, depth: 1 }] });
  assert.equal(parseTrace("nothing here"), null);
});

test("a command that drives tracing itself is left alone", () => {
  assert.equal(usesTracing("set -x; make"), true);
  assert.equal(usesTracing("PS4='> ' bash script.sh"), true);
  assert.equal(usesTracing("echo set -y"), false);
});
