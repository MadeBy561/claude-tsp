import assert from "node:assert/strict";
import { test } from "node:test";
import { compatCli, failures, formatReport, runChecks, standing } from "../dist/compat.js";

/** A session that answers as Claude Code 2.1.322 does, with what a test changes laid over it. */
function session(overrides = {}) {
  const state = { ultracode: false, effort: "medium" };
  const answers = {
    initialize: () => ({ commands: [{ name: "clear", description: "Clear the conversation" }], models: [{ value: "opus", displayName: "Opus", supportedEffortLevels: ["low", "high"] }], agents: [], account: null, claude_code_version: "2.1.322", current_permission_mode: "default" }),
    get_settings: () => ({ effective: {}, sources: [], applied: { model: "claude-opus-5-5", effort: state.effort, ultracode: state.ultracode, ultracodeAvailable: true } }),
    set_permission_mode: body => ({ mode: body.mode }),
    apply_flag_settings: body => {
      // A level sent without ultracode turns it off, as the real one does.
      state.ultracode = body.settings.ultracode === true;
      if ("effortLevel" in body.settings && body.settings.effortLevel) state.effort = body.settings.effortLevel;
      return {};
    },
    set_max_thinking_tokens: () => ({}),
    set_model: () => ({}),
    get_context_usage: () => ({ categories: [{ id: "system_prompt" }] }),
    get_usage: () => ({ session: { total_cost_usd: 0 } }),
    mcp_status: () => ({ mcpServers: [] }),
    list_permission_rules: () => ({ state: { rules: [] } }),
    background_tasks: () => ({}),
    ui_panes: () => ({ panes: [] }),
    get_sandbox_dialog: () => ({ supported: true }),
    get_workspace_diff: () => ({ diff: null, noDiffReason: "no-repository" }),
    interrupt: () => ({ still_queued: [] }),
    stop_task: () => ({}),
    get_task_output: () => {
      throw new Error("get_task_output: no shell or Monitor task with that task_id in this session");
    },
    cancel_async_message: () => ({ cancelled: false }),
    rewind_files: () => ({ canRewind: false }),
    mcp_reconnect: () => {
      throw new Error("Server not found: claude-tsp-check");
    },
    ui_press: () => ({ handled: false }),
    ui_attach: () => ({}),
    get_hooks_listing: () => ({}),
    ...overrides,
  };
  const asked = [];
  return {
    asked,
    request: async (subtype, body = {}) => {
      asked.push(subtype);
      const answer = answers[subtype];
      if (!answer) throw new Error(`Unsupported control request subtype: ${subtype}`);
      return answer(body);
    },
  };
}
const failed = report => failures(report).map(result => result.id);

test("a Claude Code that answers everything passes, and is left as it was found", async () => {
  const cc = session();
  const report = await runChecks(cc);
  assert.equal(report.version, "2.1.322");
  assert.deepEqual(failed(report), []);
  assert.ok(report.results.length >= 20);
  // An error about the arguments still shows the request is known.
  assert.match(report.results.find(result => result.id === "get_task_output").detail, /^known \(/);
  // Nothing that would send a message, rename the session or file a report is asked.
  for (const never of ["side_question", "rename_session", "submit_feedback", "remote_control"]) assert.ok(!cc.asked.includes(never));
  // Ultracode was switched on to see it work, then put back.
  assert.equal((await cc.request("get_settings")).applied.ultracode, false);
});

test("a request Claude Code no longer has fails its own check, and only that one", async () => {
  const report = await runChecks(session({ get_context_usage: undefined, ui_attach: undefined }));
  assert.deepEqual(failed(report), ["get_context_usage", "ui_attach"]);
  assert.match(report.results.find(result => result.id === "ui_attach").detail, /Unsupported control request subtype/);
  assert.equal(failures(report).some(result => result.core), false);
  assert.match(formatReport(report), /2 of \d+ checks failed \(each costs one feature; the rest works\)/);
});

test("an answer that changed shape is caught by the field the surface reads", async () => {
  const renamed = await runChecks(session({ get_settings: () => ({ effective: {}, applied: { modelId: "claude-opus-5-5" } }) }));
  const settings = renamed.results.find(result => result.id === "get_settings");
  assert.equal(settings.ok, false);
  assert.match(settings.detail, /get_settings\.applied\.model is missing, expected string/);
  assert.equal(settings.core, true);
  assert.match(formatReport(renamed), /the surface cannot work without the core ones/);
  // Ultracode that no longer survives a level change is a finding too.
  const lost = await runChecks(
    session({
      apply_flag_settings: () => ({}),
    }),
  );
  assert.match(lost.results.find(result => result.id === "apply_flag_settings").detail, /ultracode did not turn on/);
});

test("a session that never opens is an error, not a report", async () => {
  const dead = { request: async () => Promise.reject(new Error("claude is not running")) };
  await assert.rejects(runChecks(dead), /the session did not open/);
  // And the command line says so with its own exit code.
  let printed = "";
  const code = await compatCli(["--check-compat", "--bin", "/nonexistent/claude-tsp-test"], "claude", "1.0.0", text => (printed += text));
  assert.equal(code, 2);
  assert.match(printed, /could not be started/);
});

test("a version stands against what the release supports", () => {
  const range = { minimum: "2.1.300", tested: "2.1.322" };
  assert.equal(standing("2.1.299", range), "older");
  assert.equal(standing("2.1.300", range), "tested");
  assert.equal(standing("2.1.322 (Claude Code)", range), "tested");
  assert.equal(standing("2.1.325", range), "newer");
  assert.equal(standing("2.2.0", range), "newer");
  assert.equal(standing("", range), "unknown");
  assert.match(formatReport({ version: "2.1.325", results: [] }, range, "1.0.0"), /Claude Code 2\.1\.325, claude-tsp 1\.0\.0\nNewer than the release was checked with \(2\.1\.322\)/);
});
