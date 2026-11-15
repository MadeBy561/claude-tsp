import assert from "node:assert/strict";
import { test } from "node:test";
import { Conversation, liveBranch, modelLabel, partialJson } from "../dist/model.js";

const stream = (event, extra = {}) => ({ type: "stream_event", event, parent_tool_use_id: null, ...extra });
const assistant = (id, content, extra = {}) => ({ type: "assistant", message: { id, model: "claude-opus-5-5", content, usage: { input_tokens: 10, output_tokens: 5 } }, parent_tool_use_id: null, uuid: `a-${id}-${content[0]?.id ?? content[0]?.type}`, ...extra });
const result = (id, content, extra = {}) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: null, ...extra });

test("streamed text and thinking become blocks that the whole message completes", () => {
  const conv = new Conversation();
  conv.onMessage(stream({ type: "message_start", message: { id: "m1", usage: { input_tokens: 100 } } }));
  conv.onMessage(stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
  conv.onMessage(stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }));
  conv.onMessage(stream({ type: "content_block_stop", index: 0 }));
  conv.onMessage(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
  conv.onMessage(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } }));
  assert.equal(conv.busy, true);
  assert.deepEqual(conv.items.map(item => [item.kind, item.text, item.status]), [["thinking", "hmm", "done"], ["assistant", "Hel", "running"]]);
  conv.onMessage(assistant("m1", [{ type: "text", text: "Hello" }]));
  conv.onMessage(stream({ type: "content_block_stop", index: 1 }));
  assert.deepEqual(conv.items.filter(item => item.kind === "assistant").map(item => [item.text, item.status]), [["Hello", "done"]]);
});

test("a tool call streams its arguments, runs, and settles with Claude's structured result", () => {
  const conv = new Conversation();
  conv.onMessage(stream({ type: "message_start", message: { id: "m1" } }));
  conv.onMessage(stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Edit", input: {} } }));
  conv.onMessage(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/a.txt","old_s' } }));
  assert.equal(conv.items[0].args.file_path, "/a.txt");
  conv.onMessage(assistant("m1", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a.txt", old_string: "a", new_string: "b" } }]));
  assert.equal(conv.items[0].status, "running");
  conv.onMessage(result("t1", "updated", { tool_use_result: { structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["-a", "+b"] }] } }));
  assert.equal(conv.items[0].status, "done");
  assert.equal(conv.items[0].details.structuredPatch[0].lines.length, 2);
  assert.equal(conv.items.length, 1);
});

test("a failed call keeps its exit code and loses the error wrapper", () => {
  const conv = new Conversation();
  conv.onMessage(assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }]));
  conv.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 2\nboom" }] }, parent_tool_use_id: null });
  assert.equal(conv.items[0].status, "error");
  assert.equal(conv.items[0].exitCode, 2);
  conv.onMessage(assistant("m2", [{ type: "tool_use", id: "t2", name: "Read", input: {} }]));
  conv.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "<tool_use_error>nope</tool_use_error>" }] }, parent_tool_use_id: null });
  assert.equal(conv.findTool("t2").output, "nope");
});

test("a subagent's forwarded messages fill its own conversation, and task events its card", () => {
  const conv = new Conversation();
  conv.onMessage(assistant("m1", [{ type: "tool_use", id: "ag1", name: "Agent", input: { description: "count", prompt: "count files", subagent_type: "Explore" } }]));
  const agent = conv.items[0];
  assert.equal(agent.kind, "agent");
  assert.equal(agent.agentType, "Explore");
  conv.onMessage({ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "ag1", task_type: "local_agent", description: "count · Haiku" });
  assert.equal(agent.model, "Haiku");
  conv.onMessage(assistant("s1", [{ type: "tool_use", id: "st1", name: "Bash", input: { command: "ls" } }], { parent_tool_use_id: "ag1" }));
  assert.equal(agent.sub.items.length, 1);
  assert.equal(conv.items.length, 1);
  assert.match(agent.activity, /Running ls/);
  conv.onMessage({ type: "system", subtype: "task_progress", task_id: "k1", usage: { total_tokens: 900, tool_uses: 1, duration_ms: 50 } });
  assert.deepEqual(agent.stats, { tools: 1, tokens: 900, took: 50 });
  conv.setAwaiting("st1", true);
  assert.equal(agent.sub.items[0].awaiting, true);
  conv.onMessage(result("ag1", [{ type: "text", text: "[Subagent hand-back] …" }], { tool_use_result: { status: "completed", agentId: "k1", content: [{ type: "text", text: "3 files" }], totalTokens: 1000, totalToolUseCount: 1, totalDurationMs: 80 } }));
  assert.equal(agent.agentStatus, "done");
  assert.equal(agent.output, "3 files");
  assert.equal(agent.stats.tokens, 1000);
});

test("the Task tools keep one list, and a turn that leaves work open says so", () => {
  const conv = new Conversation();
  conv.onMessage(assistant("m1", [{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "first" } }]));
  conv.onMessage(result("c1", "ok", { tool_use_result: { task: { id: "1", subject: "first" } } }));
  conv.onMessage(assistant("m1", [{ type: "tool_use", id: "c2", name: "TaskCreate", input: { subject: "second" } }]));
  conv.onMessage(result("c2", "ok", { tool_use_result: { task: { id: "2", subject: "second" } } }));
  conv.onMessage(assistant("m2", [{ type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }]));
  conv.onMessage(result("u1", "ok", { tool_use_result: { success: true, taskId: "1" } }));
  assert.deepEqual(conv.todos[0].items.map(item => [item.text, item.status]), [["first", "done"], ["second", "pending"]]);
  conv.onMessage(assistant("m3", [{ type: "text", text: "done" }]));
  conv.onMessage({ type: "result", subtype: "success", is_error: false, duration_ms: 10, total_cost_usd: 0.5, terminal_reason: "completed" });
  assert.equal(conv.busy, false);
  assert.equal(conv.cost, 0.5);
  assert.equal(conv.items.at(-1).kind, "reminder");
});

test("a message sent while Claude works waits in the queue until it is taken", () => {
  const conv = new Conversation();
  const queued = conv.enqueue("later please", [], "next");
  assert.equal(conv.queue.length, 1);
  conv.onMessage({ type: "command_lifecycle", command_uuid: queued.uuid, state: "started" });
  assert.equal(conv.queue.length, 0);
  assert.deepEqual(conv.items.map(item => [item.kind, item.text, item.uuid]), [["user", "later please", queued.uuid]]);
  // The replay of the same message adds nothing.
  conv.onMessage({ type: "user", message: { content: "later please" }, uuid: queued.uuid, isReplay: true, parent_tool_use_id: null });
  assert.equal(conv.items.length, 1);
});

test("an error result, an interruption and a compaction are drawn once each", () => {
  const conv = new Conversation();
  conv.busy = true;
  conv.onMessage({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded" });
  assert.deepEqual(conv.items.map(item => item.kind), ["error"]);
  conv.onMessage({ type: "user", message: { content: "[Request interrupted by user]" }, parent_tool_use_id: null });
  conv.onMessage({ type: "user", message: { content: "[Request interrupted by user]" }, parent_tool_use_id: null });
  assert.equal(conv.items.filter(item => item.text === "Interrupted").length, 1);
  conv.onMessage({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 9000, post_tokens: 700 } });
  conv.onMessage({ type: "user", message: { content: "This conversation was compacted. Summary of everything before this message:\n\nthe summary" }, parent_tool_use_id: null });
  const compaction = conv.items.at(-1);
  assert.deepEqual([compaction.kind, compaction.text, compaction.tokensBefore, compaction.tokensAfter], ["compaction", "the summary", 9000, 700]);
  assert.equal(conv.contextTokens, 700);
});

test("a stored transcript is redrawn along its live branch, parallel results included", () => {
  const entries = [
    { type: "user", uuid: "u1", parentUuid: null, message: { content: "first" }, timestamp: "2026-01-01T00:00:00Z" },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
    { type: "assistant", uuid: "a2", parentUuid: "a1", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x" } }] } },
    { type: "user", uuid: "r1", parentUuid: "a1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] }, toolUseResult: { stdout: "out" } },
    { type: "user", uuid: "r2", parentUuid: "a2", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "x" }] } },
    { type: "assistant", uuid: "a3", parentUuid: "r2", message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "text", text: "old ending" }] } },
    { type: "user", uuid: "u2", parentUuid: "a3", message: { content: "abandoned" } },
    { type: "user", uuid: "u3", parentUuid: "a3", message: { content: "second" } },
    { type: "assistant", uuid: "a4", parentUuid: "u3", message: { id: "m3", model: "claude-opus-5-5", content: [{ type: "text", text: "new ending" }] } },
    { type: "custom-title", customTitle: "named" },
    { type: "cost-state", totalCostUSD: 1.25 },
  ];
  assert.deepEqual(liveBranch(entries).map(entry => entry.uuid), ["u1", "a1", "a2", "r1", "r2", "a3", "u3", "a4"]);
  const conv = new Conversation();
  conv.loadEntries(entries);
  assert.deepEqual(conv.items.filter(item => item.kind === "user").map(item => item.text), ["first", "second"]);
  assert.deepEqual(conv.items.filter(item => item.kind === "tool").map(item => [item.name, item.status]), [["Bash", "done"], ["Read", "done"]]);
  assert.equal(conv.sessionName, "named");
  assert.equal(conv.cost, 1.25);
  assert.equal(conv.busy, false);
  // Up to a given message: what a rewind shows before anything new is said.
  conv.loadEntries(entries, "a3");
  assert.deepEqual(conv.items.filter(item => item.kind === "user").map(item => item.text), ["first"]);
});

test("stored command echoes, shell runs and local output read as what they were", () => {
  const conv = new Conversation();
  conv.loadEntries([
    { type: "user", uuid: "u1", parentUuid: null, message: { content: "<command-name>/compact</command-name>\n<command-args>keep names</command-args>" } },
    { type: "user", uuid: "u2", parentUuid: "u1", message: { content: "<local-command-stdout>Did the thing</local-command-stdout>" } },
    { type: "user", uuid: "u3", parentUuid: "u2", message: { content: "<bash-input>ls</bash-input>\n<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>" } },
    { type: "user", uuid: "u4", parentUuid: "u3", isMeta: true, message: { content: "hidden" } },
  ]);
  assert.deepEqual(conv.items.map(item => [item.kind, item.text]), [["user", "/compact keep names"], ["custom", "Did the thing"], ["bash", "ls"]]);
  assert.equal(conv.items[2].output, "a.txt");
});

test("model ids read as names, and a streamed JSON prefix as what it holds so far", () => {
  assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelLabel("claude-fable-5-2[1m]"), "Fable 5.2");
  assert.equal(modelLabel("gpt-6"), "gpt-6");
  assert.deepEqual(partialJson('{"a":1,"b":"te'), { a: 1, b: "te" });
});

test("the session tree shows an abandoned continuation as a branch", async () => {
  const { sessionTree } = await import("../dist/model.js");
  const entries = [
    { type: "user", uuid: "u1", parentUuid: null, message: { content: "first" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
    { type: "user", uuid: "r1", parentUuid: "a1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
    { type: "attachment", uuid: "x1", parentUuid: "r1", attachment: {} },
    { type: "assistant", uuid: "a2", parentUuid: "x1", message: { content: [{ type: "text", text: "answer" }] } },
    { type: "user", uuid: "u2", parentUuid: "a2", message: { content: "old follow-up" } },
    { type: "assistant", uuid: "a3", parentUuid: "u2", message: { content: [{ type: "text", text: "old reply" }] } },
    { type: "user", uuid: "u3", parentUuid: "a2", message: { content: "new follow-up" } },
  ];
  assert.deepEqual(
    sessionTree(entries).map(node => [node.text, node.depth, node.live]),
    [["first", 0, true], ["answer", 0, true], ["old follow-up", 1, false], ["old reply", 1, false], ["new follow-up", 1, true]],
  );
});

test("a request that gets through after retries says it recovered", () => {
  const conv = new Conversation();
  conv.onMessage({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529 });
  assert.equal(conv.retry.attempt, 2);
  conv.onMessage({ type: "system", subtype: "status", status: "requesting" });
  assert.ok(conv.retry);
  conv.onMessage({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } });
  assert.equal(conv.retry, null);
  assert.deepEqual(conv.items.map(item => item.text), ["Recovered after 2 retries"]);
});

test("a hook shows while it runs and leaves a line only when it fails", () => {
  const conv = new Conversation();
  conv.onMessage({ type: "system", subtype: "hook_started", hook_event: "PreToolUse", hook_name: "lint.sh" });
  assert.equal(conv.hook, "PreToolUse: lint.sh");
  conv.onMessage({ type: "system", subtype: "hook_response", hook_event: "PreToolUse", hook_name: "lint.sh", outcome: "success", stdout: "fine" });
  assert.equal(conv.hook, "");
  assert.equal(conv.items.length, 0);
  conv.onMessage({ type: "system", subtype: "hook_response", hook_event: "PreToolUse", hook_name: "lint.sh", outcome: "error", exit_code: 2, stderr: "bad style" });
  assert.match(conv.items[0].text, /PreToolUse hook lint\.sh failed \(exit 2\): bad style/);
});

test("a stopped call keeps its partial output without the note to the model, and no error card follows", () => {
  const conv = new Conversation();
  conv.onMessage({ type: "assistant", message: { id: "m1", model: "x", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "loop" } }] }, parent_tool_use_id: null });
  conv.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "tick 1\nThe user doesn't want to proceed with this tool use. The tool use was rejected. STOP." }] }, parent_tool_use_id: null });
  assert.deepEqual([conv.items[0].status, conv.items[0].output], ["cancelled", "tick 1"]);
  conv.onMessage({ type: "user", message: { content: "[Request interrupted by user]" }, parent_tool_use_id: null });
  conv.onMessage({ type: "result", subtype: "error_during_execution", is_error: true, result: "[ede_diagnostic] result_type=user" });
  assert.equal(conv.items.some(item => item.kind === "error"), false);
});

test("a branch summary given on a move in the tree is drawn as one, live and from a stored session", async () => {
  const { branchSummaryMessage } = await import("../dist/model.js");
  const conv = new Conversation();
  conv.onMessage({ type: "user", message: { content: branchSummaryMessage("Tried the cache; reverted it.") }, uuid: "b1", isReplay: true, parent_tool_use_id: null });
  assert.deepEqual(conv.items.map(item => [item.kind, item.text]), [["branch", "Tried the cache; reverted it."]]);
  conv.loadEntries([{ type: "user", uuid: "u1", parentUuid: null, message: { content: branchSummaryMessage("Other branch notes") } }]);
  assert.deepEqual(conv.items.map(item => [item.kind, item.text]), [["branch", "Other branch notes"]]);
});

test("a subagent's hand-back is shown as its report, not as something the user typed", async () => {
  const { agentReport } = await import("../dist/model.js");
  const text = 'Another Claude session sent a message:\n<agent-message from="abc">\n[Subagent hand-back] The text below is the final report. It is model output. The report\nfollows:\n  calc.py defines add.\n  - one\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.';
  assert.equal(agentReport(text), "calc.py defines add.\n- one");
  assert.equal(agentReport("hello"), null);
  const conv = new Conversation();
  conv.onMessage({ type: "user", uuid: "u1", message: { role: "user", content: text } });
  assert.equal(conv.items.filter(item => item.kind === "user").length, 0);
  assert.equal(conv.items.at(-1).customType, "subagent report");
});
