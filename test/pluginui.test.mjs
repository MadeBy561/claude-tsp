import assert from "node:assert/strict";
import { test } from "node:test";
import { drawn, uiButtons, uiNodes } from "../dist/pluginui.js";

const tree = {
  type: "Box",
  props: { flexDirection: "row", gap: 1 },
  children: [
    { type: "Text", props: { bold: true, color: "red" }, children: ["widget"] },
    { type: "Text", children: ["count ", { type: "Text", props: { italic: true }, children: ["3"] }] },
    { type: "Button", props: { key: "bump", label: "Add one" }, press: { plugin: "p", handle: 7 } },
    { type: "Button", props: { label: "Dead" } },
    { type: "Link", props: { href: "https://example.com" }, children: ["docs"] },
    { type: "Markdown", props: { text: "**hi**" } },
    { type: "Code", props: { language: "js", code: "1+1" } },
    { type: "Mystery", children: [{ type: "Text", children: ["inside"] }] },
  ],
};
const all = (node, out = []) => (out.push(node), (node.children ?? []).forEach(child => all(child, out)), out);

test("a plugin's tree becomes Tern nodes", () => {
  const pressed = [];
  const [root] = uiNodes(tree, target => pressed.push(target));
  assert.equal(root.kind, "row");
  const nodes = all(root);
  const texts = nodes.filter(node => node.kind === "text");
  assert.equal(texts[0].props.spans[0].t, "widget");
  assert.equal(texts[0].props.spans[0].s, "strong error");
  assert.deepEqual(texts[1].props.spans.map(span => span.t), ["count ", "3"]);
  const buttons = nodes.filter(node => node.kind === "button");
  assert.equal(buttons.length, 2);
  buttons[0].handlers.onClick();
  assert.deepEqual(pressed, [{ plugin: "p", handle: 7, key: "bump" }]);
  assert.equal(buttons[1].props.disabled, true);
  assert.ok(nodes.some(node => node.kind === "md" && node.props.text === "**hi**"));
  assert.ok(nodes.some(node => node.kind === "code" && node.props.text === "1+1" && node.props.lang === "js"));
  assert.ok(texts.some(node => node.props.spans?.[0]?.t === "inside"), "an unknown element's children stand in for it");
  const keys = nodes.map(node => node.props.key);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
});

test("buttons can be listed for the keyboard", () => {
  assert.deepEqual(uiButtons(tree), [{ label: "Add one", press: { plugin: "p", handle: 7, key: "bump" } }]);
  assert.deepEqual(uiButtons(undefined), []);
});

test("only what a plugin drew counts as drawn", () => {
  assert.equal(drawn(null), undefined);
  assert.equal(drawn({ hooked: false, tree }), undefined);
  assert.equal(drawn({ hooked: true, tree: { type: "engine", ref: 1 } }), undefined);
  assert.equal(drawn({ hooked: true, tree }), tree);
  assert.deepEqual(uiNodes({ type: "engine" }, () => {}), []);
});
