import assert from "node:assert/strict";
import { test } from "node:test";
import { TextEditor } from "../dist/editor.js";
import { Conversation } from "../dist/model.js";
import { dock } from "../dist/view/dock.js";
import { effortDialog } from "../dist/view/overlays.js";

const all = (node, out = []) => (out.push(node), (node.children ?? []).forEach(child => all(child, out)), out);
const role = (root, name) => all(root).filter(node => node.props.role === name);
const keyed = (root, name) => all(root).find(node => node.props.key === name);
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const view = extra => ({ levels: LEVELS, at: 1, current: "medium", ultracode: false, detail: "Balanced", saves: true, keys: true, ...extra });

test("the effort dialog is a track with its levels under it and ultracode beside them", () => {
  const calls = [];
  const on = { level: index => calls.push(["level", index]), ultracode: value => calls.push(["ultracode", value]), confirm: () => calls.push(["confirm"]), session: () => calls.push(["session"]), close: () => calls.push(["close"]) };
  const dialog = effortDialog(view(), on);
  assert.equal(dialog.kind, "overlay");
  assert.equal(dialog.props.modal, true);
  assert.equal(dialog.props.meta, "now medium");
  const slider = role(dialog, "claude.effort.slider")[0];
  assert.deepEqual([slider.props.value, slider.props.min, slider.props.max, slider.props.step], [1, 0, 4, 1]);
  const labels = role(dialog, "claude.effort.label");
  assert.deepEqual(labels.map(label => label.props.spans[0].t), LEVELS);
  // The level under the thumb stands out; the others are quiet.
  assert.deepEqual(labels.map(label => label.props.tone ?? ""), ["", "accent", "", "", ""]);
  // A drag, a click on a name, the switch and the buttons all report back.
  slider.handlers.onChange({ value: 3 });
  labels[4].handlers.onClick();
  role(dialog, "claude.effort.ultracode")[0].handlers.onChange({ on: true });
  for (const name of ["confirm", "session", "close"]) keyed(dialog, name).handlers.onClick();
  assert.deepEqual(calls, [["level", 3], ["level", 4], ["ultracode", true], ["confirm"], ["session"], ["close"]]);
  // The keys are named where there is a keyboard to press them on.
  assert.match(keyed(dialog, "keys").props.spans[0].t, /adjust.*Tab ultracode/);
});

test("the dialog offers only what applies", () => {
  // `max` is never a default, and comes with its warning.
  const max = effortDialog(view({ at: 4, saves: false, warning: "May use excessive tokens" }), {});
  assert.equal(keyed(max, "session"), undefined);
  assert.equal(keyed(max, "warning").props.spans[0].t, "May use excessive tokens");
  // A model without ultracode (a local one): no switch, no word of Tab.
  const local = effortDialog(view({ levels: ["low", "high", "max"], at: 2, ultracode: null, saves: false }), {});
  assert.equal(role(local, "claude.effort.ultracode").length, 0);
  assert.equal(role(local, "claude.effort.slider")[0].props.max, 2);
  assert.doesNotMatch(keyed(local, "keys").props.spans[0].t, /Tab/);
  // A narrow pane: the buttons get the footer's row to themselves.
  const phone = effortDialog(view({ keys: false }), {});
  assert.equal(keyed(phone, "keys"), undefined);
  assert.doesNotMatch(role(phone, "claude.effort.ultracode")[0].props.hint, /Tab/);
});

test("the composer shows ultracode and the agents, and drops the speed on a narrow pane", () => {
  const conv = new Conversation();
  conv.ultracode = true;
  conv.busy = true;
  conv.tokPerSec = 240;
  conv.items.push({ id: "a1", kind: "agent", v: 1, at: 0, text: "", agentStatus: "running" }, { id: "a2", kind: "agent", v: 1, at: 0, text: "", agentStatus: "done" });
  const state = { editor: new TextEditor(), attachments: [], vimMode: "", drawn: null, modelName: "Opus 5.5", modelIcon: "provider:anthropic", effort: "high", reasoning: true, blocked: false, starting: false, activity: "", showTasks: true, stashed: false, update: "", narrow: false, blob: () => undefined };
  const pressed = [];
  const actions = new Proxy({}, { get: (_, name) => () => pressed.push(name) });
  const wide = dock(conv, state, actions);
  assert.equal(role(wide, "claude.composer.ultracode").length, 1);
  const chip = role(wide, "claude.composer.agents")[0];
  assert.match(JSON.stringify(chip.children.map(child => child.props.spans ?? "")), /1 agent/);
  assert.equal(chip.props.tone, "info");
  chip.handlers.onClick();
  role(wide, "claude.composer.ultracode")[0].handlers.onClick();
  assert.deepEqual(pressed.filter(name => name === "toggleAgents" || name === "toggleUltracode"), ["toggleAgents", "toggleUltracode"]);
  assert.equal(role(wide, "omp.composer.rate").length, 1);
  assert.equal(role(dock(conv, { ...state, narrow: true }, actions), "omp.composer.rate").length, 0);
  // Nothing of either when there is neither.
  const plain = dock(new Conversation(), state, actions);
  assert.equal(role(plain, "claude.composer.ultracode").length + role(plain, "claude.composer.agents").length, 0);
});
