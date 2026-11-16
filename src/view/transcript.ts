/**
 * The transcript: the welcome block, then one block per message, tool call,
 * summary and notice, in order.
 */
import { withCharts } from "../chart.js";
import type { Conversation, Item } from "../model.js";
import { clock, collapsed, duration, h, money, s, tokens, type Node, type ToggleEvent, type ViewCtx } from "./h.js";
import { agentNode, executionNode, readGroupNode, toolNode } from "./tools.js";

export interface WelcomeInfo {
  /** `Claude Code`, or `claude-pi`. */
  name: string;
  version: string;
  claudeVersion: string;
  tip: string;
  /** Who is signed in and on what plan, when known. */
  account: string;
  /** The line Claude greets with. */
  greeting: string;
  /** Ultracode on the start screen: `on` (Clawd powers up), `spent` (it was just switched off: the power drains), `rest` (after that), `off` (never on). */
  power: Power;
  /** Nothing has been said yet. Once it has, this is the conversation's head and holds still. */
  fresh: boolean;
}

export const TIPS: readonly string[] = [
  "`/model` switches the model; `/effort` sets how hard it thinks, and Alt+T turns thinking off",
  "Shift+Tab steps the permission mode: ask, accept edits, plan, auto",
  "`@` completes a file path; Tab accepts the highlighted match",
  "`!command` runs a shell command and shares its output with Claude; `!!command` keeps it private",
  "Press Esc to stop Claude; type while it works and your message is taken at the next step",
  "Alt+Enter queues a message for after the current turn; Alt+Up brings it back to edit",
  "Ctrl+O expands every tool card and thinking block; Ctrl+T shows or hides the task list",
  "`/resume` reopens an earlier session; `/rewind` goes back to an earlier message and restores the files",
  "`/compact` summarizes the conversation when the context meter fills",
  "Ctrl+R searches your prompt history",
  "Paste an image, or `/attach <path>`, to send it with the next message",
  "`/context` shows what fills the context window; `/usage` shows your plan's limits",
  "Ctrl+B sends the running command or subagent to the background",
];

const layer = (name: string): Node => h("text", { key: name, role: `claude.ssj.${name}`, text: "\u200b" });
const clawd = (): Node => h("text", { key: "clawd", role: "claude.clawd", aria: "Clawd, Claude Code's creature", text: "\u200b" });

export type Power = "off" | "on" | "spent" | "rest";

/**
 * Clawd's stage. Ultracode on: Clawd as it was (it shakes, then the flash takes it), the dust, the flash, and all
 * that arrives with the power. Just switched off: the aura as it stood, draining, steam, and Clawd itself again.
 */
function stage(power: Power): Node {
  if (power === "on") {
    return h("row", { key: "stage", role: "claude.hero.stage.flare", justify: "center", aria: "Clawd, powered up by Ultracode" }, [
      h("row", { key: "power", role: "claude.ssj.power" }, ["aura0", "aura1", "aura2", "core", "hair", "clawd", "bolt0", "bolt1"].map(layer)),
      layer("dust"),
      clawd(),
      layer("flash"),
    ]);
  }
  if (power === "spent") {
    return h("row", { key: "stage", role: "claude.hero.stage.cool", justify: "center" }, [
      h("row", { key: "power", role: "claude.ssj.power" }, ["aura0", "core", "hair", "clawd"].map(layer)),
      layer("dust"),
      clawd(),
    ]);
  }
  // `rest` is the plain stage without the hop Clawd makes when it first appears.
  return h("row", { key: "stage", role: power === "rest" ? "claude.hero.stage.rest" : "claude.hero.stage", justify: "center" }, [clawd()]);
}

/** A greeting for the hour, as Claude's own apps give. */
export function greeting(hour: number): string {
  return hour < 5 ? "Still up?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : hour < 22 ? "Good evening" : "Working late?";
}

/** The start screen above an empty transcript: Clawd, a greeting and the session's facts. */
export function welcome(info: WelcomeInfo): Node {
  const product = info.claudeVersion ? `Claude Code ${info.claudeVersion}` : "Claude Code";
  const facts = [info.name === "Claude Code" ? "" : info.name, product, `claude-tsp ${info.version}`, info.account].filter(Boolean).join(" · ").replace(/-/g, "\u2011"); // a name never breaks at its hyphen
  return h("card", { key: "welcome", role: "omp.welcome" }, [
    h("col", { key: "hero", role: info.fresh ? "claude.hero" : "claude.hero.past", align: "center" }, [
      stage(info.power),
      h("text", { key: "greeting", role: "claude.hero.greeting", wrap: "none", text: info.greeting }),
      h("text", { key: "facts", role: "claude.hero.facts", text: facts }),
    ]),
    h("row", { key: "tip", gap: "sm", align: "start", role: "omp.welcome.tip" }, [
      h("icon", { key: "0", name: "lightbulb", role: "omp.welcome.tip-icon" }),
      h("md", { key: "1", role: "omp.welcome.tip-text", text: info.tip }),
    ]),
  ]);
}

function userNode(item: Item, ctx: ViewCtx): Node {
  const images = (item.images || []).map((image, index) => {
    const blob = ctx.showImages ? ctx.blob(image) : undefined;
    return blob
      ? h("image", { key: `img${index}`, blob, alt: `attachment ${index + 1}`, max: { w: "40ch", h: "12lines" } })
      : h("badge", { key: `img${index}`, text: `image ${index + 1}` });
  });
  const menu = [
    { id: "copy-message", label: "Copy message", icon: "copy" },
    { id: "edit-turn", label: "Edit & resend", icon: "edit", detail: "To composer" },
    { id: "rewind", label: "Rewind to here…", icon: "rewind" },
  ];
  const command = /^\/\S/.test(item.text) && !item.text.includes("\n");
  // What a subagent was told is read, not acted on: no row of tools under it.
  if (ctx.sub) {
    const copy = [{ id: "copy-message", label: "Copy message", icon: "copy" }];
    return h("card", { key: item.id, role: "omp.user", tone: "user", actions: { menu: copy, hold: copy }, onAction: { "copy-message": () => ctx.on.copy(item.text, "Message") } }, [
      images.length ? h("row", { key: "images", gap: "sm", wrap: true }, images) : null,
      item.text ? h("md", { key: "text", text: item.text }) : null,
    ]);
  }
  return h(
    "card",
    {
      key: item.id,
      role: "omp.user",
      tone: "user",
      actions: { menu, hold: menu },
      onAction: {
        "copy-message": () => ctx.on.copy(item.text, "Message"),
        "edit-turn": () => ctx.on.editTurn(item),
        rewind: () => ctx.on.rewind(item),
      },
    },
    [
      h("row", { key: "tools", gap: "xs", align: "center", role: "omp.user.tools" }, [
        h("icon", { key: "copy", name: "copy", role: "omp.user.tool", title: "Copy message", aria: "Copy message", onClick: () => ctx.on.copy(item.text, "Message") }),
        h("icon", { key: "rewind", name: "rewind", role: "omp.user.tool", title: "Rewind the conversation to this message", aria: "Rewind", onClick: () => ctx.on.rewind(item) }),
        h("text", { key: "dot", text: "·" }),
        h("text", { key: "time", role: "omp.user.time", title: new Date(item.at).toLocaleString(), spans: [s(clock(item.at, ctx.hour12), "dim mono")] }),
      ]),
      images.length ? h("row", { key: "images", gap: "sm", wrap: true }, images) : null,
      item.text ? (command ? h("text", { key: "text", wrap: "word", spans: [s(item.text.split(/\s/)[0] ?? "", "accent mono"), s(item.text.slice((item.text.split(/\s/)[0] ?? "").length), "mono")] }) : h("md", { key: "text", text: item.text })) : null,
    ],
  );
}

function thinkingNode(item: Item, ctx: ViewCtx): Node {
  const live = item.status === "running";
  const label = live ? "Thinking" : item.tookMs != null && item.tookMs >= 1000 ? `Thought for ${duration(Math.round(item.tookMs / 1000) * 1000)}` : "Thought";
  return h(
    "section",
    {
      key: item.id,
      role: "omp.thinking",
      collapsible: true,
      collapsed: collapsed(ctx, item.id, true),
      ...(!live && item.tookMs != null ? { took: Math.round(item.tookMs) } : {}),
      head: h("text", { spans: [s(label, "muted", live ? { fx: "shimmer" } : {})] }),
      onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true),
    },
    [h("md", { key: "body", text: item.text, ...(live ? { stream: true } : {}) })],
  );
}

/** `8.6s · 9.7K tok · $0.02 this turn`, with the breakdown as its tooltip. */
function turnFooter(item: Item, conv: Conversation, ctx: ViewCtx): Node | null {
  const turn = item.turn;
  if (!turn) return null;
  const parts = [turn.ms > 0 ? duration(turn.ms) : "", turn.total ? `${tokens(turn.total)} tok` : "", money(turn.cost)].filter(Boolean);
  if (!parts.length) return null;
  const detail = [
    turn.ms > 0 ? duration(turn.ms) : "",
    turn.total ? `${turn.total.toLocaleString("en-US")} tokens (${turn.input.toLocaleString("en-US")} in · ${turn.output.toLocaleString("en-US")} out)` : "",
    money(turn.cost),
  ].filter(Boolean);
  const copy = (): void => ctx.on.copy(conv.answerOf(item), "Answer");
  return h("row", { key: "turn-usage", role: "omp.turn.usage", gap: "xs", align: "center", title: `This turn: ${detail.join(" · ")}` }, [
    h("icon", { key: "copy", name: "copy", role: "omp.turn.copy", title: "Copy answer", aria: "Copy answer", onClick: copy }),
    h("text", { key: "dot", text: "·" }),
    h("text", { key: "text", text: `${parts.join(" · ")} this turn` }),
  ]);
}

/** The thinking and text blocks of one assistant message. */
function assistantNode(items: Item[], conv: Conversation, ctx: ViewCtx): Node | null {
  const first = items[0]!;
  const children: (Node | null)[] = [];
  let footer: Node | null = null;
  let last: Item | undefined;
  for (const item of items) {
    if (item.kind === "thinking") {
      if (!ctx.hideThinking && item.text.trim()) children.push(thinkingNode(item, ctx));
    } else {
      if (item.text) {
        const live = item.status === "running";
        const parts = ctx.showCharts && ctx.showImages ? withCharts(item.text, live) : [{ text: item.text, chart: false }];
        parts.forEach((part, index) => {
          // Only the last piece of prose can still be arriving; a chart never is.
          const streaming = live && !part.chart && index === parts.length - 1;
          children.push(h("md", { key: index ? `${item.id}.${index}` : item.id, text: part.text, ...(part.chart ? { role: "omp.figure" } : {}), ...(streaming ? { stream: true } : {}) }));
        });
      }
      for (const [index, image] of (item.images ?? []).entries()) {
        const blob = ctx.showImages ? ctx.blob(image) : undefined;
        children.push(
          blob
            ? h("image", { key: `${item.id}.img${index}`, role: "omp.assistant.image", blob, alt: image.mimeType || "image", max: { h: "20lines" }, actions: { click: "zoom" } })
            : h("text", { key: `${item.id}.img${index}`, spans: [s(`[image ${image.mimeType || ""}]`, "muted")] }),
        );
      }
      footer = turnFooter(item, conv, ctx) ?? footer;
      last = item;
    }
  }
  if (footer) children.push(footer);
  if (!children.some(Boolean)) return null;
  const menu = [{ id: "copy-answer", label: "Copy reply", icon: "copy" }];
  return h(
    "col",
    {
      key: first.id,
      role: "omp.assistant",
      ...(last ? { actions: { menu, hold: menu }, onAction: { "copy-answer": () => ctx.on.copy(conv.answerOf(last!), "Answer") } } : {}),
    },
    children,
  );
}

function summaryNode(item: Item, ctx: ViewCtx): Node {
  if (item.kind === "branch") {
    return h(
      "section",
      { key: item.id, role: "omp.branch", head: [s("Branch summarized", "muted")], collapsible: true, collapsed: collapsed(ctx, item.id, true), onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true) },
      [h("text", { key: "caption", role: "omp.compaction.caption", spans: [s("What was done on the branch you left; Claude has it too", "dim")] }), h("md", { key: "summary", text: item.text })],
    );
  }
  const head = [
    s("Compacted", "muted"),
    ...(item.tokensAfter !== undefined && (item.tokensBefore ?? 0) > 0
      ? [s(` · ${tokens(item.tokensBefore)}`, "muted mono"), s(" → ", "dim"), s(`${tokens(item.tokensAfter)} tokens`, "muted mono")]
      : (item.tokensBefore ?? 0) > 0
        ? [s(` · ${tokens(item.tokensBefore)} tokens`, "muted mono")]
        : []),
  ];
  return h(
    "section",
    {
      key: item.id,
      role: "omp.compaction",
      head,
      collapsible: Boolean(item.text),
      collapsed: collapsed(ctx, item.id, true),
      onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true),
    },
    item.text ? [h("text", { key: "caption", role: "omp.compaction.caption", spans: [s("Summary of the earlier conversation", "dim")] }), h("md", { key: "summary", text: item.text })] : [],
  );
}

/** Output that is not the model's: a local command's, a plugin's wake-up. */
function customNode(item: Item, ctx: ViewCtx): Node {
  const long = item.text.split("\n").length > 14;
  return h(
    "card",
    {
      key: item.id,
      role: "omp.custom",
      head: [s(item.customType || "output", "customMessageLabel strong")],
      ...(long ? { collapsible: true, collapsed: collapsed(ctx, item.id, false), preview: { lines: 12 }, onToggle: (event: ToggleEvent) => ctx.on.toggle(item.id, event.collapsed === true) } : {}),
    },
    [h("md", { key: "text", text: item.text })],
  );
}

function noticeNode(item: Item): Node {
  if (item.tone === "warning" || item.tone === "error") {
    return h("row", { key: item.id, role: `omp.notice.${item.tone}`, tone: item.tone, gap: "sm", align: "start" }, [
      h("icon", { key: "0", name: item.tone === "error" ? "error" : "warning", tone: item.tone }),
      h("text", { key: "1", text: item.text, wrap: "word", grow: 1, shrink: 1 }),
    ]);
  }
  if (item.tone === "info") {
    return h("row", { key: item.id, role: "omp.marker.model", gap: "sm", align: "center" }, [h("icon", { key: "0", name: "model" }), h("text", { key: "1", truncate: "end", spans: [s(item.text, "muted")] })]);
  }
  return h("text", { key: item.id, role: "omp.assistant.abort", wrap: "word", spans: [s(item.text, "muted")] });
}

/** `14:02 · in 3.8K · out 660 · cache 12K · ttft 0.4s · 108 tok/s` under a message. */
function usageNode(item: Item, ctx: ViewCtx): Node | null {
  const usage = item.usage;
  if (!usage || !ctx.showUsage) return null;
  const parts = [
    clock(item.at, ctx.hour12),
    `in ${tokens(usage.input)}`,
    `out ${tokens(usage.output)}`,
    usage.cacheRead > 0 ? `cache ${tokens(usage.cacheRead)}` : "",
    usage.ttftMs > 0 ? `ttft ${(usage.ttftMs / 1000).toFixed(1)}s` : "",
  ].filter(Boolean);
  const decodeMs = usage.ms - usage.ttftMs;
  const rate = decodeMs > 100 && usage.output > 0 ? Math.round((usage.output / decodeMs) * 10_000) / 10 : 0;
  return h("row", { key: item.id, role: "omp.usage.turn", gap: "none", align: "baseline", title: new Date(item.at).toLocaleString() }, [
    h("text", { key: "0", spans: [s(parts.join(" · "), "dim")] }),
    rate ? h("text", { key: "1", spans: [s(" · ", "dim")] }) : null,
    rate ? h("rate", { key: "2", value: rate, unit: "tok/s" }) : null,
  ]);
}

/** The frame of a request that failed: the reason, and what to do about it. */
function errorNode(item: Item, ctx: ViewCtx): Node {
  const lines = item.text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  const code = lines[0]?.match(/^(\d{3})\s+(.*)$/);
  if (code) lines[0] = code[2] ?? "";
  const text = lines.filter(Boolean).join("\n") || "Unknown error";
  const open = !collapsed(ctx, item.id, true);
  return h("card", { key: item.id, role: "omp.error", tone: "error" }, [
    h("row", { key: "head", gap: "sm" }, [
      h("text", { key: "0", spans: [s("Request failed", "error strong")] }),
      code ? h("badge", { key: "1", text: code[1] ?? "", tone: "error", role: "omp.error.code" }) : null,
    ]),
    h("text", { key: "message", role: "omp.error.message", wrap: "word", spans: [s(text, "mono")], ...(open ? {} : { lines: 8 }) }),
    h("row", { key: "actions", gap: "sm", role: "omp.error.actions" }, [
      h("row", { key: "retry", gap: "xs", role: "omp.error.action", title: "Retry the failed turn", onClick: () => ctx.on.retry() }, [
        h("text", { key: "0", text: "Retry" }),
        h("kbd", { key: "1", keys: ["F5"] }),
      ]),
      h("row", { key: "copy-error", gap: "xs", role: "omp.error.action", title: "Copy the error message", onClick: () => ctx.on.copy(item.text, "Error") }, [
        h("text", { key: "0", text: "Copy error" }),
      ]),
      /authenticat|OAuth|sign.?in|log.?in|401/i.test(item.text)
        ? h("row", { key: "login", gap: "xs", role: "omp.error.action", title: "Sign in to your Anthropic account", onClick: () => ctx.on.login() }, [h("text", { key: "0", text: "Sign in" }), h("text", { key: "1", spans: [s("/login", "dim mono")] })])
        : null,
      h("row", { key: "switch-model", gap: "xs", role: "omp.error.action", title: "Pick another model for this session", onClick: () => ctx.on.pickModel() }, [
        h("text", { key: "0", text: "Switch model" }),
        h("kbd", { key: "1", keys: ["alt", "p"] }),
      ]),
    ]),
  ]);
}

/** The todos a run left open, as omp's reminder notice. */
function reminderNode(item: Item): Node | null {
  const phases = item.open ?? [];
  const count = phases.reduce((sum, phase) => sum + phase.items.length, 0);
  if (!count) return null;
  return h("checklist", {
    key: item.id,
    role: "omp.notice.todo",
    // Tern words the count itself ("1 todo still open").
    mode: "reminder",
    phases: phases.map(phase => ({ id: phase.id, title: phase.name, items: phase.items.map(todo => ({ id: `${phase.id}.${todo.id}`, text: todo.text, status: todo.status, ...(todo.note ? { note: todo.note } : {}) })) })),
  });
}

const isCall = (item: Item): boolean => item.kind === "tool" || item.kind === "agent";
const isRead = (item: Item): boolean => item.kind === "tool" && item.name === "Read" && item.status !== "error" && !item.awaiting;
const isProse = (item: Item): boolean => item.kind === "assistant" || item.kind === "thinking";

/** One block of the transcript: the items it draws and how to build it. */
interface Block {
  items: Item[];
  build(): Node | null;
}

function blocks(conv: Conversation, ctx: ViewCtx): Block[] {
  const out: Block[] = [];
  const items = conv.items;
  for (let at = 0; at < items.length; ) {
    const item = items[at]!;
    let run = [item];
    if (isProse(item)) {
      while (at + run.length < items.length && isProse(items[at + run.length]!) && items[at + run.length]!.msg === item.msg) run.push(items[at + run.length]!);
      const group = run;
      out.push({ items: group, build: () => assistantNode(group, conv, ctx) });
    } else if (ctx.compactTools && isCall(item)) {
      // Compact: a run of calls closes up into one gapless group.
      while (at + run.length < items.length && isCall(items[at + run.length]!)) run.push(items[at + run.length]!);
      const group = run;
      out.push({
        items: group,
        build: () => {
          const nodes: Node[] = [];
          for (let index = 0; index < group.length; ) {
            const call = group[index]!;
            let reads = 1;
            while (isRead(call) && index + reads < group.length && isRead(group[index + reads]!)) reads += 1;
            const node = reads > 1 ? readGroupNode(group.slice(index, index + reads), ctx) : blockOf(call, ctx);
            if (node) nodes.push(node);
            index += reads;
          }
          return nodes.length > 1 ? h("col", { key: group[0]!.id, role: "omp.compact", gap: "none" }, nodes) : (nodes[0] ?? null);
        },
      });
    } else if (isRead(item)) {
      while (at + run.length < items.length && isRead(items[at + run.length]!)) run.push(items[at + run.length]!);
      const group = run;
      out.push({ items: group, build: () => (group.length > 1 ? readGroupNode(group, ctx) : toolNode(item, ctx)) });
    } else {
      run = [item];
      out.push({ items: run, build: () => blockOf(item, ctx) });
    }
    at += run.length;
  }
  return out;
}

function blockOf(item: Item, ctx: ViewCtx): Node | null {
  switch (item.kind) {
    case "user":
      return userNode(item, ctx);
    case "tool":
      return toolNode(item, ctx);
    case "agent":
      return agentNode(item, ctx);
    case "compaction":
    case "branch":
      return summaryNode(item, ctx);
    case "custom":
      return customNode(item, ctx);
    case "bash":
      return executionNode(item, ctx);
    case "notice":
      return noticeNode(item);
    case "error":
      return errorNode(item, ctx);
    case "usage":
      return usageNode(item, ctx);
    case "reminder":
      return reminderNode(item);
    default:
      return null;
  }
}

/**
 * Builds the transcript, keeping the node of every block whose items did not
 * change since the last build: a long session costs what changed, not its
 * length, and an unchanged node diffs to nothing.
 */
export class TranscriptView {
  #cache = new Map<string, { rev: string; items: Item[]; versions: number[]; node: Node | null }>();

  build(conv: Conversation, ctx: ViewCtx): Node[] {
    const rev = `${ctx.foldRev}:${ctx.compactTools}`;
    const seen = new Set<string>();
    const out: Node[] = [];
    for (const block of blocks(conv, ctx)) {
      const id = block.items[0]!.id;
      seen.add(id);
      const cached = this.#cache.get(id);
      // A live tool's age and a working agent's stats are read at build time.
      let fresh = !cached || cached.rev !== rev || cached.items.length !== block.items.length;
      for (let index = 0; !fresh && index < block.items.length; index += 1) {
        const item = block.items[index]!;
        fresh = cached!.items[index] !== item || cached!.versions[index] !== item.v || item.status === "running" || item.agentStatus === "running";
      }
      let node: Node | null;
      if (fresh) {
        node = block.build();
        this.#cache.set(id, { rev, items: block.items, versions: block.items.map(item => item.v), node });
      } else node = cached!.node;
      if (node) out.push(node);
    }
    if (this.#cache.size > seen.size) for (const id of this.#cache.keys()) if (!seen.has(id)) this.#cache.delete(id);
    return out;
  }
}

