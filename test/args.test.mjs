import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, spawnArgs } from "../dist/args.js";

test("a bare invocation is a session the surface fronts", () => {
  const launch = parseArgs([]);
  assert.equal(launch.native, true);
  assert.deepEqual(launch.base, []);
});

test("print mode, version, and subcommands run stock Claude Code", () => {
  for (const args of [["-p", "hi"], ["--version"], ["mcp", "list"], ["--output-format", "json"], ["plugin", "install", "x"]]) assert.equal(parseArgs(args).native, false, args.join(" "));
});

test("the prompt, session and model flags are taken out of what passes through", () => {
  const launch = parseArgs(["--model", "opus", "--resume", "abc", "--fork-session", "--plugin-dir", "/p", "--tools", "Read,Bash", "--strict-mcp-config", "fix", "the", "bug"]);
  assert.equal(launch.model, "opus");
  assert.equal(launch.resume, "abc");
  assert.equal(launch.fork, true);
  assert.equal(launch.prompt, "fix the bug");
  assert.deepEqual(launch.base, ["--plugin-dir", "/p", "--tools", "Read,Bash", "--strict-mcp-config"]);
});

test("a bare --resume opens the picker, and --flag=value forms are read", () => {
  assert.equal(parseArgs(["--resume"]).resume, true);
  assert.equal(parseArgs(["--model=sonnet"]).model, "sonnet");
  assert.equal(parseArgs(["-c"]).continue, true);
});

test("--dangerously-skip-permissions starts in bypass and allows choosing it", () => {
  const launch = parseArgs(["--dangerously-skip-permissions"]);
  assert.equal(launch.permissionMode, "bypassPermissions");
  assert.equal(launch.allowBypass, true);
  assert.ok(spawnArgs(launch, { permissionMode: launch.permissionMode }).includes("--allow-dangerously-skip-permissions"));
});

test("a process is spawned for a new session, a resume, or a fork at a message", () => {
  const launch = parseArgs(["--add-dir", "/x"]);
  assert.deepEqual(spawnArgs(launch, { sessionId: "s1", model: "opus" }), ["--add-dir", "/x", "--model", "opus", "--session-id", "s1"]);
  assert.deepEqual(spawnArgs(launch, { resume: "s1", resumeAt: "m9", fork: true, permissionMode: "plan" }), ["--add-dir", "/x", "--permission-mode", "plan", "--resume", "s1", "--resume-session-at", "m9", "--fork-session"]);
});

test("an explicit Ask mode is passed on, so a restart keeps it over the settings default", () => {
  const launch = parseArgs(["--permission-mode", "default"]);
  assert.deepEqual(spawnArgs(launch, { permissionMode: "default" }).slice(-2), ["--permission-mode", "default"]);
  assert.ok(!spawnArgs(parseArgs([]), {}).includes("--permission-mode"));
});
