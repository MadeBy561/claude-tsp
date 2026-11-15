/**
 * What Claude Code plugins draw, as Tern nodes.
 *
 * A plugin's render hook answers a host's `ui_render` with a tree of plain
 * elements (`Box`, `Text`, `Button`, `Link`, `Code`, `Markdown`, …). This
 * surface attaches to the session as a remote surface and draws those trees
 * with Tern's own kinds: the band above the prompt and the panes a plugin
 * opens. A Button carries the handle of its closure, which stays in the
 * plugin; a press is sent back as `ui_press`.
 */
import { h, s, type Node, type Span } from "./view/h.js";

/** An element of a plugin's tree, or a run of text. */
export type UiNode = string | { type?: string; props?: Record<string, any>; children?: UiNode[]; press?: { plugin?: string; handle?: number } };

/** What a press sends back: whose closure, its handle, and the element's key. */
export interface UiPress {
  plugin: string;
  handle: number;
  key?: string;
  /** A link's target, for a Markdown whose plugin answers its links. */
  href?: string;
}

const TONES: Record<string, string> = { red: "error", green: "success", yellow: "warning", blue: "info", cyan: "info", magenta: "accent", gray: "muted", grey: "muted", error: "error", success: "success", warning: "warning", suggestion: "accent", claude: "accent", permission: "accent", secondaryText: "muted", inactive: "muted", subtle: "dim" };

/** The style tokens of a `Text` element's props. */
function tokens(props: Record<string, any> = {}): string {
  const out: string[] = [];
  if (props.bold || props.weight === "semibold" || props.weight === "bold") out.push("strong");
  if (props.italic) out.push("em");
  if (props.dimColor || props.dim) out.push("dim");
  if (props.underline) out.push("underline");
  if (props.strikethrough) out.push("strike");
  const tone = TONES[String(props.color ?? "")];
  if (tone) out.push(tone);
  if (props.mono || props.code) out.push("mono");
  return out.join(" ");
}

/** A `Text` element and the texts nested in it, as spans. */
function spans(node: UiNode, inherited = ""): Span[] {
  if (typeof node === "string") return node ? [s(node, inherited)] : [];
  if (!node || typeof node !== "object") return [];
  const own = [inherited, node.type === "Text" ? tokens(node.props) : ""].filter(Boolean).join(" ");
  if (node.type === "Link") {
    const href = String(node.props?.href ?? node.props?.url ?? "");
    const label = (node.children ?? []).filter((child): child is string => typeof child === "string").join("") || href;
    return [s(label, [own, "accent"].filter(Boolean).join(" "), /^https?:/.test(href) ? { href } : {})];
  }
  return (node.children ?? []).flatMap(child => spans(child, own));
}

const text = (node: UiNode): string => (typeof node === "string" ? node : (node?.children ?? []).map(text).join(""));

/**
 * The Tern nodes of a plugin's tree. `press` runs a Button; `path` keeps the
 * keys unique among siblings.
 */
export function uiNodes(node: UiNode | undefined, press: (target: UiPress) => void, path = "u"): Node[] {
  if (node === undefined || node === null) return [];
  if (typeof node === "string") return node.trim() ? [h("text", { key: path, wrap: "word", spans: [s(node)] })] : [];
  const props = node.props ?? {};
  const children = node.children ?? [];
  switch (node.type) {
    case "Box": {
      const row = props.flexDirection === "row" || props.flexDirection === "row-reverse";
      const kids = children.flatMap((child, index) => uiNodes(child, press, `${path}.${index}`));
      if (!kids.length) return [];
      return [h(row ? "row" : "col", { key: path, gap: props.gap || props.columnGap || props.rowGap ? "sm" : row ? "sm" : "none", ...(row ? { align: "center", wrap: true } : {}) }, kids)];
    }
    case "Text": {
      const runs = spans(node);
      return runs.length ? [h("text", { key: path, wrap: props.wrap === "truncate" || props.wrap === "truncate-end" ? "none" : "word", ...(props.wrap === "truncate" || props.wrap === "truncate-end" ? { truncate: "end" } : {}), spans: runs })] : [];
    }
    case "Button": {
      const target = node.press;
      const label = String(props.label ?? text(node) ?? "Button");
      return [
        h("button", {
          key: path,
          role: "omp.btn",
          text: props.hotkey ? `${label}` : label,
          size: "sm",
          ...(props.variant === "primary" || props.primary ? { variant: "primary" } : {}),
          title: props.hotkey ? `${label}  ${props.hotkey}` : label,
          ...(target?.plugin && typeof target.handle === "number" ? { onClick: () => press({ plugin: target.plugin!, handle: target.handle!, ...(props.key ? { key: String(props.key) } : {}) }) } : { disabled: true }),
        }),
      ];
    }
    case "Link":
      return [h("text", { key: path, wrap: "word", spans: spans(node) })];
    case "Code":
      return [h("code", { key: path, wrap: true, ...(props.language || props.lang ? { lang: String(props.language ?? props.lang) } : {}), text: String(props.code ?? props.text ?? text(node)) })];
    case "Markdown":
      return [h("md", { key: path, text: String(props.text ?? props.source ?? text(node)) })];
    case "Input":
    case "Select":
    case "Client":
    case "Svg":
    case "Raster":
    case "Image":
      // Elements this surface does not draw yet say so, rather than leave a hole the plugin's layout counts on.
      return [h("text", { key: path, spans: [s(`[${String(node.type).toLowerCase()}${props.placeholder ? `: ${String(props.placeholder)}` : ""}]`, "muted")] })];
    case "engine":
      // The engine's own drawing of the site: nothing of a plugin's.
      return [];
    default:
      // A fragment, or an element of a newer table: its children stand in for it.
      return children.flatMap((child, index) => uiNodes(child, press, `${path}.${index}`));
  }
}

/** Whether a `ui_render` answer holds something a plugin drew. */
export function drawn(answer: Record<string, any> | null | undefined): UiNode | undefined {
  if (!answer || answer.hooked !== true) return undefined;
  const tree = answer.tree as UiNode | undefined;
  if (!tree || (typeof tree === "object" && tree.type === "engine")) return undefined;
  return tree;
}

/** Every Button of a tree with its label, so they can be reached without a pointer. */
export function uiButtons(node: UiNode | undefined): { label: string; press: UiPress }[] {
  if (!node || typeof node === "string") return [];
  if (node.type === "Button") {
    const target = node.press;
    if (!target?.plugin || typeof target.handle !== "number") return [];
    const key = node.props?.key;
    return [{ label: String(node.props?.label ?? text(node) ?? "Button"), press: { plugin: target.plugin, handle: target.handle, ...(key ? { key: String(key) } : {}) } }];
  }
  return (node.children ?? []).flatMap(uiButtons);
}
