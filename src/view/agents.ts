/**
 * The agents pane: the session's subagents beside the conversation.
 *
 * Two levels, one at a time, so the pane's height goes to one thing whether
 * it is a tall desktop pane or a phone on its side:
 *
 * - the overview: every agent as a tile, the ones at work with their last
 *   steps live, so several can be watched at once;
 * - the focus: one agent's own conversation, with its way back and its
 *   neighbours a tap away.
 *
 * Where the pane goes follows the width (`paneLayout`): beside the
 * conversation when both fit, a drawer from the bottom when they do not.
 */
import { toolActivity, type Conversation, type Item } from "../model.js";
import { firstLine, h, s, type Node } from "./h.js";

export interface AgentEntry {
  item: Item;
  /** 0 for an agent the session started, 1 for one that agent started, and so on. */
  depth: number;
}

export interface PaneLayout {
  side: "right" | "bottom";
  size: "lg" | "md" | number;
  /** A drawer's height with one agent's conversation in it (the overview takes `size`). */
  tall?: number;
  /** The pixels the pane takes beside the conversation (0: it lies over it). */
  beside: number;
  /** The conversation column's width while the pane is beside it. */
  measure: number;
  /** Larger targets: the pane may well be under a finger. */
  touch: boolean;
}

/**
 * Where a pane goes in a pane of `cols` columns. Tern says how wide the pane
 * is in columns only (about 8px each at its own font size), so the breakpoints
 * move with the user's text size, as `em` breakpoints do.
 *
 * - 164 columns and up (a desktop window): a 560px pane, the conversation at full measure.
 * - 100 to 163 (a tablet, an unfolded phone or a phone on its side, a split): a
 *   400px pane, and the conversation takes what is left.
 * - under 100 (a phone upright, a folded one, a narrow split): a drawer from
 *   the bottom; the two do not fit side by side.
 */
export function paneLayout(cols: number): PaneLayout {
  // Tern's named widths are fixed, 8px off the edge; the conversation keeps 24px each side of what is left.
  const fit = (beside: number): number => Math.max(320, Math.min(736, cols * 8 - beside - 48));
  if (cols >= 164) return { side: "right", size: "lg", beside: 576, measure: fit(576), touch: false };
  if (cols >= 100) return { side: "right", size: "md", beside: 416, measure: fit(416), touch: true };
  // Two heights, as a sheet has detents: a glance at every agent, and one agent's conversation to read.
  return { side: "bottom", size: 0.56, tall: 0.86, beside: 0, measure: 736, touch: true };
}

export const agentLive = (item: Item): boolean => item.agentStatus === "running" || item.agentStatus === "pending";

/** Every subagent of a conversation in the order they started, a nested one after its parent. */
export function agentsOf(conv: Conversation, depth = 0, out: AgentEntry[] = []): AgentEntry[] {
  for (const item of conv.items) {
    if (item.kind !== "agent") continue;
    out.push({ item, depth });
    if (item.sub && depth < 4) agentsOf(item.sub, depth + 1, out);
  }
  return out;
}

export const agentTitle = (item: Item): string => firstLine(item.args?.description ?? item.args?.prompt ?? item.agentType ?? "Subagent", 80);

const STEP_ICONS: Record<string, string> = { Bash: "terminal", Read: "file", Edit: "edit", Write: "write", NotebookEdit: "edit", Grep: "search", Glob: "search", WebSearch: "globe", WebFetch: "globe", LSP: "code", Agent: "agent", Task: "agent" };

/** A step in a line: what it is for when the call says so, else the tool and what it acts on. */
function stepText(step: Item): { icon: string; title: string; target?: string } {
  if (step.kind === "agent") return { icon: "agent", title: agentTitle(step) };
  const args = step.args || {};
  const name = String(step.name || "tool");
  const icon = STEP_ICONS[name] ?? (name.startsWith("mcp__") ? "plug" : "wrench");
  const on = firstLine(args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.url ?? args.subject ?? "", 70);
  if (args.description) return { icon, title: firstLine(args.description, 90) };
  if (!on) return { icon, title: toolActivity(step) };
  return { icon, title: name.replace(/^mcp__/, "").replace(/__/g, " · "), target: on };
}

/** The last `count` steps of an agent, oldest first, as `trace` lines. */
export function recentSteps(item: Item, count: number, now = Date.now()): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const items = item.sub?.items ?? [];
  for (let index = items.length - 1; index >= 0 && lines.length < count; index -= 1) {
    const step = items[index]!;
    if (step.kind === "tool" || step.kind === "agent") {
      const running = step.kind === "agent" ? agentLive(step) : step.status === "running" || step.status === "pending";
      const failed = step.isError === true || step.status === "error";
      lines.push({
        id: step.id,
        ...stepText(step),
        status: running ? "running" : failed ? "error" : "done",
        // A time worth a column: a call still going, or one that took a second or more.
        ...(running && step.startedAt ? { age: Math.max(0, now - step.startedAt) } : (step.durationMs ?? 0) >= 1000 ? { took: Math.round(step.durationMs!) } : {}),
      });
    } else if (step.kind === "assistant" && step.text.trim() && !lines.length) {
      // What it last said, when that is the newest thing: it is writing its answer.
      lines.push({ id: step.id, icon: "message", title: firstLine(step.text.trim().split("\n").filter(Boolean).pop() ?? "", 90), status: agentLive(item) ? "running" : "done" });
    }
  }
  if (!lines.length) lines.push({ id: "start", title: item.activity ? firstLine(item.activity, 90) : "Starting", status: "running" });
  return lines.reverse();
}

function stats(item: Item, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (item.stats?.tools) out.tools = item.stats.tools;
  if (item.stats?.tokens) out.tokens = item.stats.tokens;
  if (agentLive(item) && item.startedAt) out.age = Math.max(0, now - item.startedAt);
  else if (item.stats?.took != null) out.took = Math.round(item.stats.took);
  return out;
}

/** An agent's head: who it is, what it was asked, how it stands. */
function agentHead(entry: AgentEntry, now: number, tool: boolean): Node {
  const { item, depth } = entry;
  const args = item.args || {};
  const figures = stats(item, now);
  const badges = [...(item.background ? [{ text: "background" }] : []), ...(item.awaiting ? [{ text: "needs approval", tone: "warning" }] : []), ...(item.status === "cancelled" ? [{ text: "stopped", tone: "muted" }] : [])];
  return h("agent", {
    key: "head",
    role: "claude.agents.agent",
    name: String(args.name ?? item.agentType ?? "agent"),
    task: firstLine(args.description ?? args.prompt ?? "", 100) || undefined,
    status: item.agentStatus ?? "pending",
    model: item.model || undefined,
    tool: tool && agentLive(item) && item.activity ? { name: firstLine(item.activity, 60) } : null,
    ...(Object.keys(figures).length ? { stats: figures } : {}),
    ...(badges.length ? { badges } : {}),
    ...(depth ? { depth } : {}),
    collapsible: false,
  });
}

export interface AgentsPaneActions {
  /** Shows one agent's conversation, or with `null` the overview. */
  focus(id: string | null): void;
  hide(): void;
  stop(item: Item): void;
  stopAll(): void;
  copy(item: Item): void;
  /** The agent's conversation over the whole pane. */
  full(item: Item): void;
}

export interface AgentsPaneView {
  agents: AgentEntry[];
  /** The agent in focus, or `null` for the overview. */
  focus: Item | null;
  /** The focused agent's conversation, built by the caller's transcript view. */
  transcript: Node[];
  layout: PaneLayout;
  now?: number;
}

const button = (key: string, props: Record<string, unknown>): Node => h("button", { key, role: "claude.agents.btn", size: "md", ...props });

/** The overview: a tile for each agent; one at work shows its last steps. */
function overview(view: AgentsPaneView, on: AgentsPaneActions, now: number): (Node | null)[] {
  if (!view.agents.length) return [h("empty", { key: "none", role: "claude.agents.empty", icon: "agents", title: "No agents yet", text: "Subagents Claude starts in this session show up here while they work." })];
  return view.agents.map(entry => {
    const { item } = entry;
    const live = agentLive(item);
    const failed = item.isError === true || item.agentStatus === "failed" || Boolean(item.error);
    const output = (item.error || item.output || "").trim();
    return h("col", { key: `tile.${item.id}`, role: "claude.agents.tile", ...(live ? { tone: "info" } : failed ? { tone: "error" } : {}), gap: "xs", title: "Open this agent's conversation", onClick: () => on.focus(item.id) }, [
      agentHead(entry, now, false),
      live
        ? h("trace", { key: "steps", role: "claude.agents.steps", variant: "rail", status: "running", lines: recentSteps(item, 4, now) })
        : output
          ? h("text", { key: "result", role: "claude.agents.result", lines: 2, truncate: "end", wrap: "word", spans: [s(firstLine(output.replace(/\s+/g, " "), 220), failed ? "error" : "muted")] })
          : null,
    ]);
  });
}

/** One agent: the way back, its neighbours, its head and its conversation. */
function focused(view: AgentsPaneView, item: Item, on: AgentsPaneActions, now: number): (Node | null)[] {
  const at = view.agents.findIndex(entry => entry.item === item);
  const entry = view.agents[at] ?? { item, depth: 0 };
  const many = view.agents.length > 1;
  const live = agentLive(item);
  const neighbour = (step: number): Item | undefined => view.agents[(at + step + view.agents.length) % view.agents.length]?.item;
  return [
    h("row", { key: "nav", role: "claude.agents.nav", align: "center", gap: "xs" }, [
      button("back", { icon: "back", text: many ? "All agents" : "Agents", variant: "quiet", title: "Back to every agent", onClick: () => on.focus(null) }),
      h("spacer", { key: "fill", grow: 1 }),
      many ? button("prev", { icon: "arrow-left", variant: "quiet", title: "The agent before", aria: "The agent before", onClick: () => on.focus(neighbour(-1)?.id ?? null) }) : null,
      many ? h("text", { key: "at", role: "claude.agents.at", wrap: "none", spans: [s(`${at + 1} of ${view.agents.length}`, "muted")] }) : null,
      many ? button("next", { icon: "arrow-right", variant: "quiet", title: "The agent after", aria: "The agent after", onClick: () => on.focus(neighbour(1)?.id ?? null) }) : null,
    ]),
    agentHead(entry, now, true),
    // The conversation scrolls on its own under the head, and keeps to its end while the agent works.
    h("scroll", { key: "body", role: "claude.agents.body", grow: 1, variant: "fade", ...(live ? { stick: "end" } : {}), gap: "sm" }, [
      item.args?.prompt && !view.transcript.length ? h("card", { key: "prompt", role: "omp.user", tone: "user" }, [h("md", { key: "text", text: String(item.args.prompt).slice(0, 20_000) })]) : null,
      h("col", { key: "transcript", role: "claude.agents.transcript", gap: "sm" }, view.transcript),
      !view.transcript.length && !live && item.output ? h("md", { key: "report", text: item.output.slice(0, 40_000) }) : null,
      !view.transcript.length && !item.output ? h("text", { key: "note", spans: [s(live ? "This agent has not written anything yet." : "No transcript was kept for this run.", "muted")] }) : null,
    ]),
  ];
}

/** The pane as an overlay docked where `layout` says. */
export function agentsPane(view: AgentsPaneView, on: AgentsPaneActions): Node {
  const now = view.now ?? Date.now();
  const item = view.focus;
  const running = view.agents.filter(entry => agentLive(entry.item));
  const waiting = view.agents.filter(entry => entry.item.awaiting).length;
  const meta = [running.length ? `${running.length} working` : "", waiting ? `${waiting} waiting on you` : "", `${view.agents.length} in this session`].filter(Boolean).join(" · ");
  const actions: (Node | null)[] = item
    ? [
        agentLive(item) && item.taskId ? button("stop", { icon: "stop", text: "Stop", variant: "danger", onClick: () => on.stop(item) }) : null,
        item.output ? button("copy", { icon: "copy", text: "Copy report", onClick: () => on.copy(item) }) : null,
        button("full", { icon: "expand", text: "Full view", title: "Open this conversation over the whole pane", onClick: () => on.full(item) }),
      ]
    : [running.length ? button("stop-all", { icon: "stop", text: running.length === 1 ? "Stop it" : `Stop all ${running.length}`, variant: "danger", onClick: () => (running.length === 1 ? on.stop(running[0]!.item) : on.stopAll()) }) : null];
  const shown = actions.filter(Boolean);
  return h(
    "overlay",
    {
      key: "agents",
      role: "claude.agents",
      ...(view.layout.touch ? { tone: "touch" } : {}),
      side: view.layout.side,
      variant: view.layout.side === "right" ? "inset" : "edge",
      modal: false,
      size: item && view.layout.tall ? view.layout.tall : view.layout.size,
      head: "Agents",
      icon: "agents",
      meta,
      end: button("hide", { icon: "x", variant: "quiet", title: "Hide the agents pane  Alt+A", aria: "Hide the agents pane", onClick: () => on.hide() }),
      ...(shown.length ? { foot: h("row", { role: "omp.actions", gap: "sm", align: "center" }, [h("spacer", { key: "fill", grow: 1 }), ...shown]) } : {}),
    },
    item ? focused(view, item, on, now) : overview(view, on, now),
  );
}
