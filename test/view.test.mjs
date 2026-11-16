import assert from "node:assert/strict";
import { test } from "node:test";
import { Conversation } from "../dist/model.js";
import { TextEditor } from "../dist/editor.js";
import { dock, MODES } from "../dist/view/dock.js";
import { approvalPanel, questionPanel, sheet } from "../dist/view/overlays.js";
import { toolNode, agentNode, toolTitle, diffHunks } from "../dist/view/tools.js";
import { TranscriptView, greeting, welcome } from "../dist/view/transcript.js";
import { flareCss, paneCss, stylesheet } from "../dist/theme.js";
import { gauge, spark } from "../dist/view/spark.js";

const ctx = () => ({ cwd: "/proj", kinds: new Set(["shell", "json"]), hour12: false, expandAll: false, hideThinking: false, showImages: true, showUsage: false, showCharts: true, compactTools: false, shell: new Map(), fold: new Map(), foldRev: 0, blob: () => undefined, on: { toggle() {}, copy() {}, rewind() {}, editTurn() {}, retry() {}, pickModel() {}, login() {}, openAgent() {}, stopTask() {}, open() {}, shell() {} } });
const find = (node, test) => (test(node) ? node : node.children.map(child => find(child, test)).find(Boolean));
const item = fields => ({ id: "t1", v: 0, at: 0, text: "", kind: "tool", status: "done", ...fields });

test("every Claude Code tool gets a card of its own kind", () => {
  const cases = [
    [{ name: "Bash", args: { command: "ls", description: "List" }, output: "a" }, "Bash", "omp.tool.bash"],
    [{ name: "Read", args: { file_path: "/proj/a.ts" }, details: { file: { content: "x", startLine: 1 } } }, "Read", "omp.tool.read"],
    [{ name: "Edit", args: { file_path: "/proj/a.ts", old_string: "a", new_string: "b" } }, "Edit", "omp.tool.edit"],
    [{ name: "Write", args: { file_path: "/proj/a.ts", content: "x\ny" } }, "Write", "omp.tool.write"],
    [{ name: "Grep", args: { pattern: "foo" }, details: { mode: "files_with_matches", filenames: ["/proj/a.ts"] } }, "Grep", "omp.tool.grep"],
    [{ name: "Glob", args: { pattern: "*.ts" }, details: { filenames: [] } }, "Glob", "omp.tool.glob"],
    [{ name: "WebSearch", args: { query: "tern" }, details: { results: [{ content: [{ title: "T", url: "https://t" }] }, "summary"] } }, "Web search", "omp.tool.websearch"],
    [{ name: "WebFetch", args: { url: "https://t" }, details: { result: "page", code: 200, bytes: 2048 } }, "Fetch", "omp.tool.webfetch"],
    [{ name: "TaskCreate", args: { subject: "do it" } }, "Task", "omp.tool.taskcreate"],
    [{ name: "TodoWrite", args: { todos: [{ content: "a", status: "completed" }] } }, "Todos", "omp.tool.todowrite"],
    [{ name: "AskUserQuestion", args: { questions: [{ question: "Q?", header: "H" }] }, details: { answers: { "Q?": "A" } } }, "Question", "omp.tool.askuserquestion"],
    [{ name: "ExitPlanMode", args: { plan: "# Plan\n- step" } }, "Plan", "omp.tool.exitplanmode"],
    [{ name: "LSP", args: { operation: "goToDefinition", filePath: "/proj/a.ts", line: 3 } }, "LSP", "omp.tool.lsp"],
    [{ name: "mcp__github__create_issue", args: { title: "x" }, output: "{}" }, "github · create issue", "omp.tool.mcp"],
  ];
  for (const [fields, title, role] of cases) {
    const node = toolNode(item(fields), ctx());
    assert.equal(node.props.title, title, fields.name);
    assert.equal(node.props.role, role, fields.name);
    assert.equal(node.props.status, "done");
  }
  assert.equal(toolTitle("ListAgents"), "List agents");
});

test("an edit is drawn from Claude's own patch, and a call awaiting approval says so", () => {
  assert.deepEqual(diffHunks({ structuredPatch: [{ oldStart: 4, newStart: 4, lines: [" a", "-b", "+c", "\\ No newline at end of file"] }] }), [{ oldStart: 4, newStart: 4, lines: [" a", "-b", "+c"] }]);
  const node = toolNode(item({ name: "Write", status: "running", awaiting: true, args: { file_path: "/proj/a", content: "x" } }), ctx());
  assert.equal(node.props.status, "pending");
  assert.equal(node.props.note, "awaiting approval");
});

test("a subagent card carries its model, numbers and a stop button while it runs", () => {
  const node = agentNode(item({ kind: "agent", agentType: "Explore", agentStatus: "running", taskId: "k1", model: "Haiku", activity: "Running ls", stats: { tools: 2, tokens: 900 }, args: { description: "look", prompt: "look around" } }), ctx());
  assert.equal(node.props.name, "Explore");
  assert.equal(node.props.model, "Haiku");
  assert.deepEqual(node.props.tool, { name: "Running ls" });
  assert.ok(find(node, entry => entry.props.key === "stop"));
});

test("the dock shows the permission mode, the queue and the plan's limits", () => {
  const conv = new Conversation();
  conv.permissionMode = "plan";
  conv.contextWindow = 200000;
  conv.contextTokens = 50000;
  conv.enqueue("next thing", [], "later");
  conv.rateWindows.set("five_hour", { utilization: 0.42, resetsAt: 0 });
  conv.statuses.set("pi-harness", "cache 50%");
  const state = { editor: new TextEditor(), attachments: [], vimMode: "", drawn: null, modelName: "Opus 5.5", modelIcon: "provider:anthropic", effort: "high", reasoning: true, blocked: false, starting: false, activity: "", showTasks: true, stashed: false, blob: () => undefined };
  const actions = new Proxy({}, { get: () => () => undefined });
  const node = dock(conv, state, actions);
  const mode = find(node, entry => entry.props.role === "claude.composer.mode");
  assert.equal(mode.props.tone, MODES.plan.tone);
  assert.ok(find(node, entry => entry.props.role === "omp.queue.item"));
  assert.match(JSON.stringify(find(node, entry => entry.props.key === "rate-five_hour").props.spans), /5h 42%/);
  assert.ok(find(node, entry => entry.props.role === "claude.status.plugin"));
  assert.equal(find(node, entry => entry.props.role === "omp.composer.context").props.label, "25%");
});

test("the approval and question panels list their choices, and a sheet keeps its buttons in the footer", () => {
  const approval = approvalPanel({ title: "Run this command?", details: [], preview: [], choices: [{ id: "yes", label: "Yes", deny: false }, { id: "no", label: "No", deny: true }], selected: "yes", expanded: false }, { take() {}, approve() {}, deny() {}, expand() {} });
  assert.equal(find(approval, entry => entry.props.role === "omp.approval.choices").children.length, 2);
  const question = questionPanel({ index: 0, total: 2, header: "Color", question: "Which?", multi: true, options: [{ id: "o0", label: "Red", checked: true }, { id: "other", label: "Other…", checked: false }], selected: "o0", other: null, answered: 0 }, { take() {}, next() {}, back() {}, cancel() {}, edit() {}, undo() {} });
  assert.equal(find(question, entry => entry.props.key === "o0").props.icon, "check-square");
  assert.equal(find(question, entry => entry.props.key === "next").props.text, "Next");
  const node = sheet("agent", "Head", "lg", [], () => undefined);
  assert.ok(node.slots?.foot || node.props.foot || find(node, entry => entry.props.key === "close"));
});

test("the transcript groups reads, keeps unchanged blocks, and the welcome names the product", () => {
  const conv = new Conversation();
  conv.addUser("hello").confirmed = true;
  for (const id of ["r1", "r2"]) {
    conv.onMessage({ type: "assistant", message: { id: `m-${id}`, model: "x", content: [{ type: "tool_use", id, name: "Read", input: { file_path: `/proj/${id}.ts` } }] }, parent_tool_use_id: null });
    conv.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "1\tx" }] }, parent_tool_use_id: null });
  }
  const view = new TranscriptView();
  const first = view.build(conv, ctx());
  assert.deepEqual(first.map(node => [node.kind, node.props.role]), [["card", "omp.user"], ["tool", "omp.tool.read"]]);
  assert.equal(first[1].props.target, "2 files");
  assert.equal(view.build(conv, ctx())[0], first[0]);
  const start = welcome({ name: "Claude Code", version: "1.0.0", claudeVersion: "2.1.0", tip: "tip", account: "Claude Max", greeting: greeting(9), power: "on", fresh: true });
  assert.equal(find(start, entry => entry.props.key === "greeting").props.text, "Good morning");
  assert.equal(find(start, entry => entry.props.key === "facts").props.text, "Claude Code 2.1.0 · claude\u2011tsp 1.0.0 · Claude Max");
  // Ultracode powers Clawd up.
  assert.ok(find(start, entry => entry.props.role === "claude.hero.stage.flare"));
  assert.deepEqual([0, 5, 12, 18, 22].map(greeting), ["Still up?", "Good morning", "Good afternoon", "Good evening", "Working late?"]);
});

test("the stylesheet sets Claude's accent only when asked, and holds nothing Tern refuses", () => {
  assert.match(stylesheet(true), /--accent: var\(--claude\)/);
  assert.match(stylesheet(true), /light-dark\(/);
  assert.doesNotMatch(stylesheet(false), /--accent:/);
  const sheet = stylesheet(false);
  // Tern drops the whole sheet over one rule it refuses, and the look with it. These are the refusals met so far.
  for (const css of [stylesheet(true), stylesheet(false), flareCss(), paneCss({ beside: 416, measure: 600, touch: true })]) {
    assert.doesNotMatch(css, /url\(|position:\s*fixed|@property|@import|clip-path:\s*(polygon|ellipse|circle|path)|padding-inline|margin-inline|color-mix\(in srgb, Canvas|[;{]\s*contain:|[^-\]"]\s~\s|\s\+\s\[/);
  }
  // Ultracode's scene: every layer the start screen makes is drawn by the sheet that travels with it.
  const powered = welcome({ name: "Claude Code", version: "1", claudeVersion: "2", tip: "", account: "", greeting: "hi", power: "on", fresh: true });
  const layers = [];
  (function walk(node) { if (String(node.props.role ?? "").startsWith("claude.ssj.")) layers.push(node.props.role); for (const child of node.children ?? []) walk(child); })(powered);
  assert.ok(layers.length >= 9);
  // Switched off, the power drains on a stage of its own, then the plain stage stands without Clawd's first hop.
  const roles = power => { const out = []; (function walk(node) { if (node.props.role) out.push(node.props.role); for (const child of node.children ?? []) walk(child); })(welcome({ name: "Claude Code", version: "1", claudeVersion: "2", tip: "", account: "", greeting: "hi", power, fresh: power !== "rest" })); return out; };
  assert.ok(roles("spent").includes("claude.hero.stage.cool") && roles("spent").includes("claude.ssj.power") && roles("spent").includes("claude.clawd"));
  assert.ok(flareCss().includes(`[data-role="claude.hero.stage.cool"] [data-role="claude.ssj.power"]`));
  assert.ok(roles("rest").includes("claude.hero.stage.rest") && !roles("rest").some(role => role.startsWith("claude.ssj.")));
  assert.ok(roles("off").includes("claude.hero.stage") && roles("off").includes("claude.hero") && roles("rest").includes("claude.hero.past"));
  for (const role of layers) assert.ok(flareCss().includes(`[data-role="${role}"]`), role);
  // The effort gauge lights more rays the higher the level, and all twelve at max.
  assert.equal(gauge("g", "high").props.role, "claude.gauge.high");
  assert.ok(sheet.includes(`[data-role="claude.gauge.max"] [data-role="claude.ray.11"]`));
  // The spark has a ray for each node the view makes, and every state the view names has its motion.
  const mark = spark("s", "think");
  assert.equal(mark.props.role, "claude.spark.think");
  for (const ray of mark.children) assert.ok(sheet.includes(`[data-role="${ray.props.role}"] {`), ray.props.role);
  for (const state of ["think", "work", "wait", "flare", "warn"]) assert.ok(sheet.includes(`[data-role="claude.spark.${state}"]`), state);
});
