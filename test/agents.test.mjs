import assert from "node:assert/strict";
import { test } from "node:test";
import { paneCss } from "../dist/theme.js";
import { agentsOf, agentsPane, paneLayout, recentSteps } from "../dist/view/agents.js";

const all = (node, out = []) => (out.push(node), (node.children ?? []).forEach(child => all(child, out)), out);
const byRole = (root, role) => all(root).filter(node => node.props.role === role);
const foot = pane => pane.children.find(node => node.props.key === "foot");
const noop = { focus() {}, hide() {}, stop() {}, stopAll() {}, copy() {}, full() {} };

const tool = (id, name, args, extra = {}) => ({ id, kind: "tool", v: 1, at: 0, text: "", name, args, status: "done", ...extra });
const agent = (id, description, extra = {}) => ({ id, kind: "agent", v: 1, at: 0, text: "", agentType: "Explore", args: { description, prompt: `Do: ${description}` }, agentStatus: "done", ...extra });

test("the pane goes where the width allows", () => {
  // A desktop window: the wide pane, the conversation at its full measure.
  assert.deepEqual(paneLayout(175), { side: "right", size: "lg", beside: 576, measure: 736, touch: false });
  // An unfolded phone on its side (890pt): side by side, the conversation in what is left.
  const unfolded = paneLayout(111);
  assert.equal(unfolded.side, "right");
  assert.equal(unfolded.size, "md");
  assert.equal(unfolded.measure, 111 * 8 - 416 - 48);
  assert.equal(unfolded.touch, true);
  // A phone on its side (956pt) and a tablet (1180pt) are side by side too.
  assert.equal(paneLayout(119).side, "right");
  assert.equal(paneLayout(147).size, "md");
  // Upright phones, folded ones and an unfolded phone held upright (up to 704pt): a drawer.
  for (const cols of [51, 55, 58, 78, 88]) {
    const layout = paneLayout(cols);
    assert.equal(layout.side, "bottom");
    assert.equal(layout.beside, 0);
    assert.ok(layout.tall > layout.size);
  }
  // The conversation never gets narrower than a phone's.
  assert.ok(paneLayout(100).measure >= 320);
});

test("the stylesheet moves the conversation only when the pane is beside it", () => {
  const beside = paneCss(paneLayout(175));
  assert.match(beside, /margin-right: 576px/);
  assert.match(beside, /--rd-measure: 736px/);
  assert.doesNotMatch(beside, /min-height: 40px/);
  const drawer = paneCss(paneLayout(55));
  assert.doesNotMatch(drawer, /margin-right/);
  assert.match(drawer, /min-height: 40px/);
  // Tern's sheet filter takes no logical properties.
  assert.doesNotMatch(paneCss(paneLayout(111)), /-inline|-block/);
});

test("agents are listed in order, a nested one after its parent", () => {
  const child = agent("c", "inner");
  const conv = { items: [{ id: "u", kind: "user", text: "hi" }, agent("a", "outer", { sub: { items: [tool("t", "Bash", { command: "ls" }), child] } }), agent("b", "second")] };
  assert.deepEqual(agentsOf(conv).map(entry => [entry.item.id, entry.depth]), [["a", 0], ["c", 1], ["b", 0]]);
});

test("an agent's last steps read as what they are for", () => {
  const item = agent("a", "work", {
    agentStatus: "running",
    sub: {
      items: [
        tool("1", "Bash", { command: "ls /etc", description: "List the config directory" }, { durationMs: 20 }),
        tool("2", "Read", { file_path: "/etc/hostname" }, { durationMs: 2400 }),
        tool("3", "Grep", { pattern: "root" }, { isError: true, status: "error" }),
        tool("4", "Bash", { command: "sleep 9" }, { status: "running", startedAt: 1000 }),
      ],
    },
  });
  const lines = recentSteps(item, 3, 5000);
  assert.deepEqual(lines.map(line => line.id), ["2", "3", "4"]);
  assert.deepEqual([lines[0].title, lines[0].target, lines[0].took], ["Read", "/etc/hostname", 2400]);
  assert.equal(lines[1].status, "error");
  assert.deepEqual([lines[2].status, lines[2].age, lines[2].target], ["running", 4000, "sleep 9"]);
  // A call that says what it is for shows that, and a time under a second is not worth a column.
  const first = recentSteps(item, 4, 5000)[0];
  assert.equal(first.title, "List the config directory");
  assert.equal(first.took, undefined);
  // Nothing yet: it is starting.
  assert.deepEqual(recentSteps(agent("n", "new", { agentStatus: "running" }), 4).map(line => line.title), ["Starting"]);
});

test("the overview shows every agent, the ones at work with their steps", () => {
  const working = agent("a", "count lines", { agentStatus: "running", startedAt: 1, taskId: "t1", sub: { items: [tool("1", "Bash", { command: "wc -l x" }, { status: "running", startedAt: 1 })] } });
  const done = agent("b", "list files", { output: "Found 12 files.\nDetails follow." });
  const agents = [
    { item: working, depth: 0 },
    { item: done, depth: 0 },
  ];
  const focused = [];
  const pane = agentsPane({ agents, focus: null, transcript: [], layout: paneLayout(175), now: 10 }, { ...noop, focus: id => focused.push(id) });
  assert.equal(pane.kind, "overlay");
  assert.equal(pane.props.modal, false);
  assert.equal(pane.props.side, "right");
  assert.match(pane.props.meta, /^1 working · 2 in this session$/);
  const tiles = byRole(pane, "claude.agents.tile");
  assert.equal(tiles.length, 2);
  assert.equal(byRole(tiles[0], "claude.agents.steps").length, 1);
  assert.equal(byRole(tiles[1], "claude.agents.steps").length, 0);
  assert.equal(byRole(tiles[1], "claude.agents.result")[0].props.spans[0].t, "Found 12 files. Details follow.");
  // One agent at work: the footer stops it.
  assert.equal(foot(pane).children.find(node => node.props.key === "stop-all").props.text, "Stop it");
  tiles[1].handlers.onClick();
  assert.deepEqual(focused, ["b"]);
});

test("a focused agent has its way back, its neighbours and its own actions", () => {
  const first = agent("a", "one", { output: "report" });
  const second = agent("b", "two", { agentStatus: "running", taskId: "t2", startedAt: 1 });
  const agents = [
    { item: first, depth: 0 },
    { item: second, depth: 0 },
  ];
  const seen = [];
  const pane = agentsPane({ agents, focus: second, transcript: [], layout: paneLayout(55), now: 10 }, { ...noop, focus: id => seen.push(id) });
  // A drawer, at its taller height for reading.
  assert.equal(pane.props.side, "bottom");
  assert.equal(pane.props.size, paneLayout(55).tall);
  const nav = byRole(pane, "claude.agents.nav")[0];
  const key = name => nav.children.find(node => node.props.key === name);
  key("back").handlers.onClick();
  key("next").handlers.onClick();
  key("prev").handlers.onClick();
  assert.deepEqual(seen, [null, "a", "a"]);
  assert.equal(key("at").props.spans[0].t, "2 of 2");
  // It is working: it can be stopped, and its conversation keeps to its end.
  assert.deepEqual(foot(pane).children.filter(node => node.kind === "button").map(node => node.props.key), ["stop", "full"]);
  assert.equal(byRole(pane, "claude.agents.body")[0].props.stick, "end");
  // A finished one offers its report instead.
  const settled = agentsPane({ agents, focus: first, transcript: [], layout: paneLayout(175) }, noop);
  assert.deepEqual(foot(settled).children.filter(node => node.kind === "button").map(node => node.props.key), ["copy", "full"]);
  assert.equal(byRole(settled, "claude.agents.body")[0].props.stick, undefined);
});
