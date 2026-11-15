/**
 * The dock: the working row and task HUD, queued messages, and the composer
 * with its context meter, chips and status facts.
 */
import type { TextEditor } from "../editor.js";
import type { Conversation, Image } from "../model.js";
import { duration, firstLine, h, money, s, tokens, type EditEvent, type Node, type SendEvent, type Span } from "./h.js";

/** The wire id of the composer's editor: the caret anchor of the completion popup. */
export const EDITOR_ID = "dock.editor.line.input";

export interface Attachment extends Image {
  name: string;
}

/** How a permission mode reads and is toned in the composer. */
export const MODES: Record<string, { label: string; tone: string; icon: string; hint: string }> = {
  default: { label: "Ask", tone: "muted", icon: "shield", hint: "Claude asks before it edits files or runs commands" },
  manual: { label: "Ask", tone: "muted", icon: "shield", hint: "Claude asks before it edits files or runs commands" },
  acceptEdits: { label: "Accept edits", tone: "accent", icon: "edit", hint: "File edits are applied without asking; commands still ask" },
  plan: { label: "Plan", tone: "info", icon: "plan", hint: "Claude explores and proposes a plan; nothing is changed until you approve it" },
  auto: { label: "Auto", tone: "success", icon: "sparkles", hint: "A classifier approves safe actions and asks about risky ones" },
  dontAsk: { label: "Don't ask", tone: "warning", icon: "shield", hint: "Anything not already allowed is denied without asking" },
  bypassPermissions: { label: "Bypass", tone: "error", icon: "warning", hint: "Every action runs without asking" },
};

export interface DockState {
  editor: TextEditor;
  attachments: Attachment[];
  /** The Vim mode label (`NORMAL`, `VISUAL`), or empty in insert mode or with Vim keys off. */
  vimMode: string;
  /** The selection to draw instead of the editor's own (Vim's Visual modes). */
  drawn: { anchor: number; cursor: number } | null;
  modelName: string;
  /** The model maker's logo, as an icon name. */
  modelIcon: string | undefined;
  effort: string;
  /** Whether the model takes an effort level at all. */
  reasoning: boolean;
  /** A dialog owns the keyboard: the composer is not ready for a `send`. */
  blocked: boolean;
  /** Startup is not finished: Tern keeps what is typed until this clears. */
  starting: boolean;
  /** What the model is doing now, for the working row. */
  activity: string;
  /** Whether the task list is drawn above the composer. */
  showTasks: boolean;
  /** A draft set aside with Ctrl+S. */
  stashed: boolean;
  blob(image: { data?: string; mimeType?: string }): string | undefined;
}

export interface DockActions {
  submit(): void;
  interrupt(): void;
  pickModel(): void;
  cycleEffort(): void;
  cycleMode(): void;
  showContext(): void;
  showSession(): void;
  showUsage(): void;
  showBackground(): void;
  dequeue(): void;
  detach(index: number): void;
  edit(event: EditEvent): void;
  undo(): void;
  send(event: SendEvent): void;
}

/** The live "working" indicator above the composer. */
function workingRow(conv: Conversation, state: DockState, on: DockActions): Node {
  const retry = conv.retry;
  const label = retry
    ? `Retrying${retry.max ? ` (attempt ${retry.attempt}/${retry.max})` : ""} in ${duration(Math.max(0, retry.delayMs - (Date.now() - retry.at)))}`
    : conv.compacting
      ? "Compacting the conversation"
      : state.activity || "Working";
  return h("row", { key: "working", role: "omp.working", align: "center", gap: "sm", ...(retry ? { title: retry.error } : {}) }, [
    h("spinner", { key: "spinner", style: "starburst", tone: retry ? "warning" : "accent" }),
    conv.runStartedAt ? h("elapsed", { key: "elapsed", age: Math.max(0, Date.now() - conv.runStartedAt), format: "short" }) : null,
    conv.runStartedAt ? h("text", { key: "sep", text: "·", role: "omp.working.sep" }) : null,
    h("shimmer", { key: "label", role: "omp.working.label", mode: "classic", palette: { low: "dim", mid: "muted", high: "accent" }, spans: [s(label, "muted")] }),
    conv.thinkingTokens > 0 && !retry && !conv.compacting ? h("text", { key: "thinking", wrap: "none", spans: [s(`· ${tokens(conv.thinkingTokens)} tok`, "dim")] }) : null,
    h("row", { key: "fill", grow: 1 }),
    h("row", { key: "stop", role: "omp.working.stop", gap: "xs", align: "center", title: "Stop  esc", onClick: () => on.interrupt() }, [
      h("kbd", { key: "0", keys: ["escape"] }),
      h("text", { key: "1", text: "Stop" }),
    ]),
  ]);
}

function todoHud(conv: Conversation, state: DockState): Node | null {
  const phases = conv.todos;
  if (!phases?.length || !state.showTasks) return null;
  const open = phases.some(phase => phase.items.some(item => item.status === "pending" || item.status === "active" || item.status === "blocked"));
  if (!open && !conv.busy) return null;
  return h("checklist", {
    key: "todo",
    role: "omp.hud.todo",
    mode: "hud",
    phases: phases.map(phase => ({
      id: phase.id,
      title: phase.name,
      items: phase.items.map(item => ({ id: `${phase.id}.${item.id}`, text: item.text, status: item.status, ...(item.note ? { note: item.note } : {}) })),
    })),
  });
}

/** The work still running behind the conversation, as a pill that opens its list. */
function runningPill(conv: Conversation, on: DockActions): Node | null {
  const agents = conv.items.filter(item => item.kind === "agent" && item.background && (item.agentStatus === "running" || item.agentStatus === "pending"));
  const tasks = [...conv.background.values()];
  const count = agents.length + tasks.length;
  if (!count) return null;
  const started = Math.min(...agents.map(item => item.startedAt ?? item.at), ...tasks.map(task => task.startedAt));
  const only = count === 1 ? (agents[0] ? firstLine(agents[0].args?.description ?? agents[0].agentType ?? "subagent", 50) : firstLine(tasks[0]!.description, 50)) : `${count} running in the background`;
  return h("row", { key: "hud", role: "omp.hud", justify: "end" }, [
    h("row", { key: "jobs", role: "omp.hud.jobs", gap: "xs", align: "center", title: "Background work: click to list it", onClick: () => on.showBackground() }, [
      h("spinner", { key: "spin", style: "dots" }),
      h("text", { key: "glance", role: "omp.hud.glance", wrap: "none", truncate: "end", spans: [s(only, "muted")] }),
      h("elapsed", { key: "age", age: Math.max(0, Date.now() - started), format: "short" }),
    ]),
  ]);
}

function queueRows(conv: Conversation, on: DockActions): Node | null {
  const total = conv.queue.length;
  if (!total) return null;
  return h(
    "col",
    { key: "queue", role: "omp.queue", gap: "xs" },
    conv.queue.map((entry, index) =>
      h("row", { key: `q${index}`, role: "omp.queue.item", align: "center", gap: "sm", title: entry.priority === "later" ? "Sent after this turn" : entry.priority === "now" ? "Interrupts the turn" : "Taken at the next step" }, [
        h("icon", { key: "icon", name: entry.priority === "later" ? "clock" : "corner-down-right" }),
        h("text", { key: "text", wrap: "none", truncate: "end", grow: 1, text: (entry.text || `${entry.images.length} image${entry.images.length === 1 ? "" : "s"}`).replace(/\t/g, " ").replace(/\s*\r?\n\s*/g, " ↵ ") }),
        index === 0 && total > 1 ? h("badge", { key: "count", role: "omp.queue.count", text: `${total} queued`, title: `${total} messages queued` }) : null,
        h("row", { key: "edit", role: "omp.queue.edit", gap: "xs", align: "center", title: "Edit  Alt+↑", onClick: () => on.dequeue() }, [
          h("kbd", { key: "0", keys: ["alt", "up"] }),
          h("text", { key: "1", text: "Edit" }),
        ]),
      ]),
    ),
  );
}

function contextMeter(conv: Conversation, on: DockActions): Node | null {
  const window = conv.contextWindow;
  if (!window) return null;
  const used = Math.max(0, conv.contextTokens);
  const value = Math.min(1, used / window);
  const percent = Math.round(value * 100);
  return h("meter", {
    key: "context",
    role: "omp.composer.context",
    style: "bar",
    thresholds: { warn: 0.7, bad: 0.9 },
    total: tokens(window),
    title: [`Context ${percent}% used`, `${tokens(used)} of ${tokens(window)} tokens`].join("\n"),
    value,
    label: `${percent}%`,
    onClick: () => on.showContext(),
  });
}

function chips(state: DockState, on: DockActions): Node {
  const nodes = state.attachments.map((attachment, index) => {
    const blob = state.blob(attachment);
    return h("row", { key: `a${index}`, role: "omp.composer.chip", gap: "xs", align: "center", title: `Remove ${attachment.name}`, onClick: () => on.detach(index) }, [
      blob ? h("image", { key: "thumb", blob, alt: attachment.name, max: { h: "2lines", w: "8ch" } }) : h("icon", { key: "thumb", name: "image" }),
      h("text", { key: "name", wrap: "none", truncate: "middle", spans: [s(attachment.name, "muted")] }),
      h("icon", { key: "x", name: "x" }),
    ]);
  });
  return h("row", { key: "chips", gap: "sm", wrap: true, role: "omp.composer.chips", ...(nodes.length ? {} : { hidden: true }) }, nodes);
}

/** `5h 42%`: how much of a usage window is spent. */
function windowLabel(name: string): string {
  return ({ five_hour: "5h", seven_day: "7d", seven_day_opus: "7d opus", seven_day_sonnet: "7d sonnet", seven_day_overage_included: "7d+" } as Record<string, string>)[name] ?? name.replace(/_/g, " ");
}

/** The facts between the model chip and the send key: session, goal, plan limits, plugin statuses. */
function extras(conv: Conversation, state: DockState, on: DockActions): Node {
  // Tern draws the pane's folder and branch in this strip itself; these are the facts only Claude knows.
  const segs: Node[] = [];
  if (conv.sessionName) {
    segs.push(h("seg", { key: "session", role: "omp.status.session", side: "left", priority: 3, icon: "session", title: "Session details", spans: [s(firstLine(conv.sessionName, 40), "muted")], onClick: () => on.showSession() }));
  }
  if (conv.goal) segs.push(h("seg", { key: "goal", role: "claude.status.goal", side: "left", priority: 4, icon: "target", tone: "accent", title: `Goal: ${conv.goal}`, spans: [s("goal", "accent")] }));
  if (state.stashed) segs.push(h("seg", { key: "stash", role: "claude.status.stash", side: "left", priority: 2, icon: "archive", title: "A draft is set aside: Ctrl+S brings it back", spans: [s("stashed", "muted")] }));
  for (const name of ["five_hour", "seven_day"]) {
    const window = conv.rateWindows.get(name);
    if (!window) continue;
    const percent = Math.round(window.utilization * 100);
    const tone = percent >= 90 ? "error" : percent >= 70 ? "warning" : "muted";
    const resets = window.resetsAt ? `resets ${new Date(window.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
    segs.push(h("seg", { key: `rate-${name}`, role: "claude.status.rate", side: "right", priority: name === "five_hour" ? 5 : 4, title: [`${windowLabel(name)} usage window: ${percent}% used`, resets].filter(Boolean).join("\n"), spans: [s(`${windowLabel(name)} ${percent}%`, tone)], onClick: () => on.showUsage() }));
  }
  for (const [key, text] of conv.statuses) {
    if (!text) continue;
    // The user's own status line outranks a plugin's status text when space runs out.
    const own = key === "status line";
    segs.push(h("seg", { key: `x-${key.replace(/[^\w-]/g, "_")}`, role: own ? "claude.status.line" : "claude.status.plugin", side: "right", priority: own ? 8 : 2, title: own ? "Claude Code's status line" : key, spans: [s(firstLine(text, own ? 90 : 60), "muted")] }));
  }
  return h("status", { key: "extras", role: "omp.composer.extras", transparent: true, grow: 1 }, segs);
}

/** Style runs over the draft: the shell sigil hidden behind its chip, a command name, pasted-text chips. */
function decorations(editor: TextEditor): { from: number; to: number; s: string }[] {
  const out: { from: number; to: number; s: string }[] = [];
  if (editor.text.startsWith("!")) out.push({ from: 0, to: editor.text.startsWith("!!") ? 2 : 1, s: "hide" });
  else if (editor.text.startsWith("/")) {
    const end = editor.text.search(/\s/);
    out.push({ from: 0, to: end < 0 ? editor.text.length : end, s: "accent" });
  }
  for (const paste of editor.pastes) {
    let from = editor.text.indexOf(paste.token);
    while (from >= 0) {
      out.push({ from, to: from + paste.token.length, s: "mark" });
      from = editor.text.indexOf(paste.token, from + paste.token.length);
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

function placeholder(conv: Conversation): string | Span[] {
  if (conv.busy) return "Message Claude while it works, or queue a follow-up with Alt+Enter";
  if (conv.suggestion) return [s(conv.suggestion, "dim"), s("   Tab", "dim mono")];
  if (conv.permissionMode === "plan") return "Describe what to plan";
  if (conv.sessionName) return [s(`“${firstLine(conv.sessionName, 60)}”`, "em")];
  return "How can I help you today?";
}

function composer(conv: Conversation, state: DockState, on: DockActions): Node {
  const editor = state.editor;
  const decor = decorations(editor);
  const shell = editor.text.startsWith("!");
  const usage = conv.cost > 0 ? money(conv.cost) : "";
  const privately = editor.text.startsWith("!!");
  const mode = MODES[conv.permissionMode] ?? MODES.default!;
  return h("col", { key: "editor", role: shell ? "omp.editor.bash" : "omp.editor", ...(conv.busy ? { tone: "pending" } : {}) }, [
    contextMeter(conv, on),
    chips(state, on),
    h("row", { key: "line", role: "omp.composer.line", align: "start", gap: "sm" }, [
      shell
        ? h("row", { key: "mode", role: "omp.composer.mode", gap: "xs", align: "center", title: privately ? "Runs in your shell · not sent to Claude" : "Runs in your shell" }, [
            h("text", { key: "0", spans: [s("bash", "bashMode")] }),
            privately ? h("icon", { key: "1", name: "eye-off", title: "Not sent to Claude" }) : null,
          ])
        : null,
      h("editor", {
        key: "input",
        text: editor.text,
        cursor: state.drawn?.cursor ?? editor.cursor,
        ...(state.drawn ? { anchor: state.drawn.anchor } : editor.anchor !== null ? { anchor: editor.anchor } : {}),
        ...(decor.length ? { decor } : {}),
        ...(shell ? { lang: "bash" } : {}),
        ...(state.vimMode ? { mode: state.vimMode } : {}),
        sendable: !state.blocked && !state.starting,
        ...(state.starting ? { typeahead: true } : {}),
        placeholder: placeholder(conv),
        maxLines: 18,
        aria: "Message Claude",
        onEdit: (event: EditEvent) => on.edit(event),
        onUndo: () => on.undo(),
        onSend: (event: SendEvent) => on.send(event),
      }),
    ]),
    h("row", { key: "bar", role: "omp.composer.bar", gap: "sm", align: "center" }, [
      h("row", { key: "model", role: "omp.composer.model", gap: "xs", align: "center", title: "Switch model  Alt+P", onClick: () => on.pickModel() }, [
        state.modelIcon ? h("icon", { key: "logo", name: state.modelIcon, role: "claude.composer.model.logo" }) : null,
        state.reasoning
          ? h("effort", { key: "effort", role: "omp.composer.model.effort", level: state.effort || "off", title: state.effort === "off" ? "Thinking is off  Alt+T" : `Effort: ${state.effort || "default"}  Alt+E`, actions: { click: "effort" }, onAction: { effort: () => on.cycleEffort() } })
          : null,
        h("text", { key: "name", wrap: "none", spans: [s(state.modelName || "no model", "statusLineModel")] }),
        h("icon", { key: "chev", name: "chev" }),
      ]),
      h("row", { key: "perm", role: "claude.composer.mode", tone: mode.tone, gap: "xs", align: "center", title: `${mode.hint}\nShift+Tab changes the mode`, onClick: () => on.cycleMode() }, [
        h("icon", { key: "icon", name: mode.icon, tone: mode.tone }),
        h("text", { key: "label", wrap: "none", spans: [s(mode.label, mode.tone)] }),
      ]),
      conv.busy && conv.tokPerSec > 0 ? h("rate", { key: "rate", role: "omp.composer.rate", value: conv.tokPerSec, unit: "tok/s", title: "Generation rate" }) : null,
      extras(conv, state, on),
      h("text", { key: "usage", role: "omp.composer.usage", wrap: "none", text: usage, ...(usage ? { title: "Session cost" } : {}), onClick: () => on.showSession() }),
      conv.busy && editor.empty
        ? h("text", { key: "stop", role: "omp.composer.stop", text: "Stop", tone: "error", title: "Stop  esc", onClick: () => on.interrupt() })
        : h("kbd", { key: "send", role: "omp.composer.send", keys: ["enter"], title: conv.busy ? "Send now  ⏎" : "Send  ⏎", onClick: () => on.submit() }),
    ]),
  ]);
}

/**
 * The whole dock. `above` sits over the composer (the approval panel);
 * `instead` takes the composer's place (a question, a text field).
 */
export function dock(conv: Conversation, state: DockState, on: DockActions, above: Node | null | (Node | null)[] = null, instead: Node | null = null): Node {
  const hud = todoHud(conv, state);
  const busy = conv.busy || conv.compacting || Boolean(conv.retry);
  return h("col", { key: "dock" }, [
    runningPill(conv, on),
    busy || hud
      ? h("row", { key: "activity", role: "omp.hud.activity", align: "center", gap: "sm" }, [
          busy ? h("col", { key: "status", role: "omp.hud.status" }, [workingRow(conv, state, on)]) : h("row", { key: "status", grow: 1 }),
          hud,
        ])
      : null,
    queueRows(conv, on),
    ...(Array.isArray(above) ? above : [above]),
    instead ?? composer(conv, state, on),
  ]);
}

/** A failed turn's error, pinned above the composer until dismissed or the next turn. */
export function errorBanner(message: string, expanded: boolean, on: { details(): void; dismiss(): void }): Node {
  const clean = message.trim();
  const headline = clean.split("\n").find(line => line.trim())?.trim() || "Error";
  const long = clean !== headline || headline.length > 80;
  return h("row", { key: "error-banner", role: "omp.errorBanner", tone: "error", gap: "sm", align: expanded ? "start" : "center" }, [
    expanded
      ? h("text", { key: "text", wrap: "word", grow: 1, spans: [s(clean, "error")] })
      : h("text", { key: "text", truncate: "end", lines: 1, grow: 1, title: clean, spans: [s(headline, "error")] }),
    long ? h("button", { key: "details", role: "omp.btn", text: expanded ? "Less" : "Details", size: "sm", title: expanded ? "Less" : "Details", onClick: on.details }) : null,
    h("button", { key: "dismiss", role: "omp.btn", text: "Dismiss", size: "sm", title: "Dismiss", onClick: on.dismiss }),
  ]);
}

/** The panel shown in the composer's place while a rewind point is being chosen. */
export function rewindPanel(view: { text: string; dropped: number; index: number; total: number; files: string; mode: string }, on: { confirm(): void; cancel(): void; mode(): void }): Node {
  // The approval panel's frame: Tern draws it as a card in the composer's column.
  const what: Record<string, string> = { both: "Conversation and files", conversation: "Conversation only", files: "Files only" };
  return h("col", { key: "rewind", role: "omp.editor.ask.approval", gap: "md" }, [
    h("text", { key: "title", role: "omp.approval.title", tone: "accent", text: `Rewind to message ${view.index} of ${view.total}` }),
    h("text", { key: "text", lines: 2, truncate: "end", spans: [s(view.text, "muted")] }),
    h("text", {
      key: "note",
      wrap: "word",
      spans: [
        s(view.mode === "files" ? "The conversation stays as it is. " : view.dropped ? `${view.dropped} later ${view.dropped === 1 ? "block is" : "blocks are"} left behind in the old session; the message returns to the composer. ` : "The message returns to the composer to edit and send. ", "dim"),
        s(view.mode === "conversation" ? "Files are left as they are." : view.files, "dim"),
      ],
    }),
    h("row", { key: "actions", role: "omp.actions", gap: "sm", align: "center" }, [
      h("kbd", { key: "keys", keys: ["up"] }),
      h("kbd", { key: "keys2", keys: ["down"] }),
      h("text", { key: "hint", spans: [s("choose a message", "dim")] }),
      h("spacer", { key: "fill", grow: 1 }),
      h("button", { key: "mode", role: "omp.btn", text: what[view.mode] ?? view.mode, keys: ["tab"], size: "md", title: "What to restore  tab", onClick: on.mode }),
      h("button", { key: "cancel", role: "omp.btn", text: "Cancel", keys: ["escape"], size: "md", onClick: on.cancel }),
      h("button", { key: "confirm", role: "omp.btn", text: "Rewind here", keys: ["enter"], size: "md", variant: "primary", onClick: on.confirm }),
    ]),
  ]);
}
