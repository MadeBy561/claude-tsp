/**
 * Everything drawn over or in place of the composer: the completion popup,
 * pickers, the approval panel, extension dialogs, the settings window, the
 * subagent transcript and toasts.
 */
import type { TextEditor } from "../editor.js";
import { EDITOR_ID } from "./dock.js";
import { h, s, type ActivateEvent, type ChangeEvent, type EditEvent, type Node, type SelectEvent, type Span } from "./h.js";

export interface Completion {
  /** Unique within the list; also the node key. */
  id: string;
  label: string;
  /** The typed prefix length to mark in the label. */
  mark?: number;
  detail?: string;
  value?: string;
  icon?: string;
}

const key = (id: string): string => id.replace(/[^\w-]/g, "_") || "_";

/** The completion popup at the composer's caret. */
export function completionPopup(items: readonly Completion[], selected: number, onPick: (index: number) => void): Node {
  const base = "layer.complete.select.list";
  const keys = items.map((item, index) => `${index}-${key(item.id)}`);
  return h("overlay", { key: "complete", anchor: { caret: EDITOR_ID }, role: "omp.autocomplete" }, [
    h("col", { key: "select", role: "omp.select" }, [
      h(
        "list",
        {
          key: "list",
          selected: keys[selected] ? `${base}.${keys[selected]}` : null,
          empty: "No items",
          max: { lines: 10 },
          actions: { click: "select", dblclick: "activate" },
          onSelect: (event: SelectEvent) => pick(event.item),
          onActivate: (event: ActivateEvent) => pick(event.item),
        },
        items.map((item, index) => {
          const marked = Math.min(item.mark ?? 0, item.label.length);
          const label: Span[] = marked > 0 ? [s(item.label.slice(0, marked), "mark"), ...(marked < item.label.length ? [s(item.label.slice(marked))] : [])] : [s(item.label)];
          return h("item", {
            key: keys[index],
            ...(item.icon ? { icon: item.icon } : {}),
            label,
            ...(item.detail ? { detail: [s(item.detail, "muted")] } : {}),
            ...(item.value ? { value: [s(item.value, "muted")] } : {}),
          });
        }),
      ),
    ]),
  ]);
  function pick(id: string | undefined): void {
    const index = keys.findIndex(k => `${base}.${k}` === id || k === id);
    if (index >= 0) onPick(index);
  }
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  mono?: boolean;
  dot?: string;
  tone?: string;
  disabled?: string | true;
  facts?: Record<string, string | number>;
  badges?: { text: string; tone?: string; title?: string }[];
  node?: "user" | "assistant" | "tool" | "marker";
  depth?: number;
  mark?: { text: string; seed?: string; icon?: string };
  /** Extra text the search matches besides the label and detail. */
  search?: string;
  /** The group this item sits under when the picker groups. */
  group?: string;
}

export interface PickerAction {
  id: string;
  label: string;
  keys?: string[];
  primary?: boolean;
  danger?: boolean;
  end?: boolean;
  on?: boolean;
  disabled?: string | true;
}

/** What a picker shows now; the controller owns filtering, selection and keys. */
export interface PickerView {
  /** Static props: title, icon, noun, size, layout, placeholder, columns, preview. */
  props: Record<string, unknown>;
  items: readonly PickerItem[];
  /** Bumped when `items` changes, so unchanged catalogues are not re-sent. */
  itemsRev: number;
  /** The filtered ids (and group headers) in order; absent shows `items` as given. */
  order?: readonly (string | { group: string; label: string; count?: number })[];
  hits?: Record<string, [number, number][]>;
  query: string | null;
  cursor: number;
  selected: string | null;
  current?: readonly string[];
  tabs?: { id: string; label: string; count?: number }[];
  tab?: string;
  scopes?: { id: string; label: string; icon?: string; count?: number; group?: string }[];
  scope?: string;
  actions: PickerAction[];
  confirm?: { text: string; act: string; label?: string } | null;
  state?: "ready" | "loading" | "error";
  message?: string;
  empty?: string;
  preview?: Node[];
}

export interface PickerHandlers {
  select(id: string): void;
  activate(id: string): void;
  change(item: string, value: unknown): void;
}

const pickerItems = new WeakMap<readonly PickerItem[], { rev: number; wire: unknown[] }>();

/**
 * A data-first picker sheet; under `layer` it is itself the modal. Its buttons,
 * tabs and scopes send `action` events no node handler takes: the controller
 * reads them from the session by this node's id (`layer.picker`).
 */
export function pickerNode(view: PickerView, on: PickerHandlers): Node {
  // The catalogue is converted once per revision; an equal list diffs to nothing while the user types.
  let wire = pickerItems.get(view.items);
  if (!wire || wire.rev !== view.itemsRev) {
    wire = { rev: view.itemsRev, wire: view.items.map(({ search: _search, group: _group, ...item }) => item) };
    pickerItems.set(view.items, wire);
  }
  return h(
    "picker",
    {
      key: "picker",
      ...view.props,
      query: view.query,
      ...(view.query !== null ? { cursor: view.cursor } : {}),
      items: wire.wire,
      ...(view.order ? { order: view.order } : {}),
      ...(view.hits && Object.keys(view.hits).length ? { hits: view.hits } : {}),
      selected: view.selected,
      ...(view.current ? { current: view.current } : {}),
      total: view.items.length,
      ...(view.tabs ? { tabs: view.tabs, tab: view.tab } : {}),
      ...(view.scopes ? { scopes: view.scopes, scope: view.scope } : {}),
      actions: view.actions,
      ...(view.confirm ? { confirm: view.confirm } : {}),
      state: view.state ?? "ready",
      ...(view.message ? { message: view.message } : {}),
      ...(view.empty ? { empty: view.empty } : {}),
      onSelect: (event: SelectEvent) => on.select(event.item),
      onActivate: (event: ActivateEvent) => on.activate(event.item),
      onChange: (event: ChangeEvent) => on.change(event.item ?? "", event.value),
    },
    view.preview ?? [],
  );
}

function actionButton(label: string, id: string, keys: string[], onClick: () => void, variant?: "primary" | "danger", title?: string): Node {
  return h("button", { key: id, role: "omp.btn", text: label, keys, size: "md", ...(variant ? { variant } : {}), title: title ?? `${label}  ${keys.join("+")}`, onClick });
}

export interface ApprovalView {
  title: string;
  /** Who asks, when it is not the main conversation (`subagent · explore`). */
  origin?: string;
  /** Why Claude Code asks (a rule, a safety check). */
  reason?: string;
  /** What the call would do, drawn natively: a command, a diff, a plan. */
  preview?: (Node | null)[];
  details: string[];
  choices: { id: string; label: string; deny: boolean; detail?: string }[];
  selected: string;
  expanded: boolean;
  /** The preview can be opened further. */
  expandable?: boolean;
  /** Milliseconds left before the request times out, when it has a timeout. */
  remaining?: number;
}

/** The approval panel above the composer: what is asked, the choices, Approve and Deny. */
export function approvalPanel(view: ApprovalView, on: { take(id: string): void; approve(): void; deny(): void; expand(): void }): Node {
  const long = Boolean(view.expandable) || view.details.length > 6 || view.details.some(line => line.length > 160);
  const shown = view.expanded || !long ? view.details : view.details.slice(0, 6);
  return h("col", { key: "approval", role: "omp.editor.ask.approval", gap: "md" }, [
    h("row", { key: "head", gap: "sm", align: "baseline" }, [
      h("text", { key: "title", role: "omp.approval.title", tone: "accent", text: view.title, grow: 1 }),
      view.origin ? h("badge", { key: "origin", text: view.origin }) : null,
    ]),
    view.reason ? h("text", { key: "reason", wrap: "word", spans: [s(view.reason, "warning")] }) : null,
    view.preview?.some(Boolean) ? h("col", { key: "preview", role: "claude.approval.preview", gap: "sm", max: { h: view.expanded ? "28lines" : "14lines" }, scroll: "y" }, view.preview) : null,
    shown.length
      ? h(
          "col",
          { key: "details", role: "omp.approval.details" },
          shown.map((line, index) => h("text", { key: String(index), text: line, ...(view.expanded ? { wrap: "char" } : { truncate: "end" }), spans: [s(line, "mono")] })),
        )
      : null,
    h(
      "list",
      {
        key: "choices",
        role: "omp.approval.choices",
        selected: `dock.approval.choices.${view.selected}`,
        actions: { click: "select", dblclick: "activate" },
        onSelect: (event: SelectEvent) => on.take(String(event.item).split(".").at(-1) ?? ""),
        onActivate: (event: ActivateEvent) => on.take(String(event.item).split(".").at(-1) ?? ""),
      },
      view.choices.map((choice, index) => h("item", { key: choice.id, role: "omp.approval.choice", label: [s(`${index + 1}  `, "dim mono"), s(choice.label)], ...(choice.detail ? { detail: [s(choice.detail, "muted")] } : {}), tone: choice.deny ? "error" : "accent" })),
    ),
    h("row", { key: "actions", role: "omp.actions", gap: "sm", align: "center" }, [
      view.remaining !== undefined ? h("elapsed", { key: "timer", age: -Math.max(0, view.remaining), format: "short" }) : null,
      h("spacer", { key: "fill", grow: 1 }),
      long ? actionButton(view.expanded ? "Less" : "Details", "expand", ["ctrl", "o"], on.expand, undefined, view.expanded ? "Summarize this call  ctrl+o" : "Show every detail of this call  ctrl+o") : null,
      actionButton("Deny", "deny", ["escape"], on.deny, "danger", "Deny this call  escape"),
      actionButton("Approve", "approve", ["ctrl", "enter"], on.approve, "primary", "Approve this call  ctrl+enter"),
    ]),
  ]);
}

export interface FieldView {
  title: string;
  detail: string;
  /** A link shown under the detail (a sign-in page), opened or copied with a click. */
  link?: string;
  placeholder: string;
  multiline: boolean;
  editor: TextEditor;
  remaining?: number;
}

/** An extension's `input` or `editor` request, in the composer's place. */
export function fieldDialog(view: FieldView, on: { submit(): void; cancel(): void; edit(event: EditEvent): void; undo(): void }): Node {
  const part = view.multiline ? "omp.hook-editor" : "omp.hook-input";
  const field = view.multiline
    ? h("col", { key: "field", role: `${part}.field` }, [
        h("editor", {
          key: "input",
          text: view.editor.text,
          cursor: view.editor.cursor,
          ...(view.editor.anchor !== null ? { anchor: view.editor.anchor } : {}),
          // Ctrl+Enter in the editor is Tern's send: it submits the dialog.
          sendable: view.editor.text.trim().length > 0,
          placeholder: [s(view.placeholder || "Type here")],
          maxLines: 18,
          onSend: () => on.submit(),
          onEdit: on.edit,
          onUndo: on.undo,
        }),
      ])
    : h("col", { key: "field", role: `${part}.field` }, [
        h("col", { key: "form", gap: "md", role: "omp.form" }, [
          h("col", { key: "f", gap: "sm", role: "omp.form.field" }, [
            h("input", {
              key: "input",
              text: view.editor.text,
              cursor: view.editor.cursor,
              ...(view.editor.anchor !== null ? { anchor: view.editor.anchor } : {}),
              sendable: false,
              prompt: "> ",
              ...(view.placeholder ? { placeholder: view.placeholder } : {}),
              onEdit: on.edit,
              onUndo: on.undo,
            }),
          ]),
        ]),
      ]);
  return h("col", { key: "field", role: view.multiline ? "omp.overlay.hook-editor" : "omp.overlay.hook-input" }, [
    h("col", { key: "head", role: `${part}.head`, gap: "xs" }, [
      h("row", { key: "line", gap: "md", align: "baseline" }, [
        h("text", { key: "title", role: `${part}.title`, wrap: "word", grow: 1, spans: [s(view.title)] }),
        view.remaining !== undefined
          ? h("row", { key: "timer", role: `${part}.timer`, title: "Cancels when the time runs out" }, [h("elapsed", { key: "0", age: -Math.max(0, view.remaining), format: "short" })])
          : null,
      ]),
      view.detail ? h("text", { key: "detail", role: `${part}.detail`, wrap: "word", spans: [s(view.detail)] }) : null,
      view.link ? h("text", { key: "link", role: "claude.field.link", lines: 2, wrap: "char", truncate: "end", title: "Open the sign-in page", spans: [s(view.link, "accent", { href: view.link })] }) : null,
    ]),
    field,
    h("row", { key: "actions", role: "omp.actions", gap: "sm", align: "center" }, [
      h("spacer", { key: "fill", grow: 1 }),
      actionButton("Cancel", "cancel", ["escape"], on.cancel),
      actionButton("Submit", "submit", view.multiline ? ["ctrl", "enter"] : ["enter"], on.submit, "primary", view.multiline ? "Submit  ctrl+enter · New line  enter" : "Submit  enter"),
    ]),
  ]);
}

/** The wire id of the field a dialog edits. */
export function fieldInputId(multiline: boolean): string {
  return multiline ? "dock.field.field.input" : "dock.field.field.form.f.input";
}

export interface Toast {
  id: number;
  text: string;
  sub?: string;
  tone?: "info" | "warning" | "error" | "success";
  /** An action button on the toast (Undo). */
  action?: { act: string; label?: string; run(): void };
}

export function toastNodes(toasts: readonly Toast[]): Node[] {
  return toasts.map(toast =>
    h("toast", {
      key: `toast${toast.id}`,
      text: toast.text,
      ...(toast.sub ? { sub: toast.sub } : {}),
      ...(toast.tone && toast.tone !== "info" ? { tone: toast.tone } : {}),
      ttl: toast.action ? 6000 : 2400,
      ...(toast.action ? { action: toast.action.act, ...(toast.action.label ? { label: toast.action.label } : {}), onAction: { [toast.action.act]: () => toast.action!.run() } } : {}),
    }),
  );
}

export interface QuestionView {
  /** The question shown now, and where it stands among the others. */
  index: number;
  total: number;
  header: string;
  question: string;
  multi: boolean;
  options: { id: string; label: string; detail?: string; checked: boolean }[];
  selected: string;
  /** The free-text answer being typed, when "Other" is open. */
  other: TextEditor | null;
  /** Answers given so far, for the summary line. */
  answered: number;
}

/** AskUserQuestion, in the composer's place: one question at a time, its options, and a free answer. */
export function questionPanel(view: QuestionView, on: { take(id: string): void; next(): void; back(): void; cancel(): void; edit(event: EditEvent): void; undo(): void }): Node {
  const last = view.index === view.total - 1;
  return h("col", { key: "question", role: "omp.editor.ask.approval", gap: "md" }, [
    h("row", { key: "head", gap: "sm", align: "baseline" }, [
      view.header ? h("badge", { key: "header", text: view.header, tone: "accent" }) : null,
      h("text", { key: "title", role: "omp.approval.title", tone: "accent", wrap: "word", grow: 1, text: view.question }),
      view.total > 1 ? h("text", { key: "count", wrap: "none", spans: [s(`${view.index + 1} of ${view.total}`, "dim")] }) : null,
    ]),
    h(
      "list",
      {
        key: "choices",
        role: "omp.approval.choices",
        selected: `dock.question.choices.${view.selected}`,
        actions: { click: "select", dblclick: "activate" },
        onSelect: (event: SelectEvent) => on.take(String(event.item).split(".").at(-1) ?? ""),
        onActivate: (event: ActivateEvent) => on.take(String(event.item).split(".").at(-1) ?? ""),
      },
      view.options.map((option, index) =>
        h("item", {
          key: option.id,
          role: "omp.approval.choice",
          ...(view.multi ? { icon: option.checked ? "check-square" : "square" } : {}),
          label: [s(`${index + 1}  `, "dim mono"), s(option.label, option.checked ? "accent" : "")],
          ...(option.detail ? { detail: [s(option.detail, "muted")] } : {}),
          tone: "accent",
        }),
      ),
    ),
    view.other
      ? h("col", { key: "other", gap: "sm", role: "omp.form.field" }, [
          h("input", {
            key: "input",
            text: view.other.text,
            cursor: view.other.cursor,
            ...(view.other.anchor !== null ? { anchor: view.other.anchor } : {}),
            sendable: false,
            prompt: "> ",
            placeholder: "Type your answer",
            onEdit: on.edit,
            onUndo: on.undo,
          }),
        ])
      : null,
    h("row", { key: "actions", role: "omp.actions", gap: "sm", align: "center" }, [
      h("text", { key: "hint", spans: [s(view.multi ? "space toggles · enter continues" : "enter chooses", "dim")] }),
      h("spacer", { key: "fill", grow: 1 }),
      actionButton("Skip", "cancel", ["escape"], on.cancel, undefined, "Leave the questions unanswered  escape"),
      view.index > 0 ? actionButton("Back", "back", ["shift", "tab"], on.back) : null,
      actionButton(last ? "Submit" : "Next", "next", view.multi || view.other ? ["enter"] : ["tab"], on.next, "primary"),
    ]),
  ]);
}

/** The wire id of the free-answer field of the question panel. */
export const QUESTION_INPUT_ID = "dock.question.other.input";

/** A modal sheet with a head, a body and a Close button. */
export function sheet(id: string, head: string, size: "sm" | "md" | "lg" | "full", body: (Node | null)[], onClose: () => void, extra: (Node | null)[] = []): Node {
  // The actions ride in the overlay's footer so a long body scrolls under them.
  const foot = h("row", { role: "omp.actions", gap: "sm", align: "center" }, [h("spacer", { key: "fill", grow: 1 }), ...extra, actionButton("Close", "close", ["escape"], onClose)]);
  return h("overlay", { key: id, anchor: "center", modal: true, size, head, role: `omp.overlay.${id}`, foot }, body);
}

export interface PrefsRow {
  id: string;
  label: string;
  hint?: string;
  changed?: boolean;
  defaultLabel?: string;
  disabled?: string;
  control: Record<string, unknown>;
}

export interface PrefsView {
  title: string;
  pages: { id: string; label: string; icon?: string }[];
  page: string;
  lead?: string;
  sections: { id: string; title: string; rows: PrefsRow[] }[];
  focus: string | null;
  editing?: { row: string; option: string };
}

/** The settings window: pages of typed rows the terminal draws natively. */
export function prefsNode(view: PrefsView, on: { change(row: string, value: unknown): void; select(item: string): void; activate?(item: string): void }): Node {
  return h("prefs", {
    key: "prefs",
    title: view.title,
    pages: view.pages,
    page: view.page,
    ...(view.lead ? { lead: view.lead } : {}),
    sections: view.sections,
    focus: view.focus,
    ...(view.editing ? { editing: view.editing } : {}),
    onActivate: (event: ActivateEvent) => on.activate?.(event.item),
    onChange: (event: ChangeEvent) => on.change(event.item ?? "", event.value),
    onSelect: (event: SelectEvent) => on.select(event.item),
  });
}

export interface EffortView {
  levels: string[];
  /** The level under the thumb. */
  at: number;
  /** The level in force, for the head. */
  current: string;
  /** Ultracode as the dialog has it; null when the model takes none. */
  ultracode: boolean | null;
  /** What the level under the thumb means. */
  detail: string;
  warning?: string;
  /** Confirming also makes the level the default for new sessions (a session-only choice is offered beside it). */
  saves: boolean;
  /** Say which keys do what: left out where there is likely no keyboard and the room is short. */
  keys: boolean;
}

/**
 * The effort dialog, laid out as Claude Code's own: a track from faster to
 * smarter with the levels under it, ultracode as a switch beside them (Tab),
 * and nothing applied until it is confirmed.
 */
export function effortDialog(view: EffortView, on: { level(index: number): void; ultracode(on: boolean): void; confirm(): void; session(): void; close(): void }): Node {
  const foot = h("row", { role: "omp.actions", gap: "sm", align: "center" }, [
    view.keys ? h("text", { key: "keys", role: "claude.effort.keys", wrap: "none", spans: [s(`←/→ adjust${view.ultracode === null ? "" : "  ·  Tab ultracode"}`, "dim")] }) : null,
    h("spacer", { key: "fill", grow: 1 }),
    actionButton("Cancel", "close", ["escape"], on.close),
    view.saves ? actionButton("This session only", "session", ["s"], on.session, undefined, "Use it for this session and leave your default as it is  s") : null,
    actionButton("Confirm", "confirm", ["enter"], on.confirm, "primary", view.saves ? "Use it now and for new sessions  enter" : "Use it for this session  enter"),
  ]);
  return h("overlay", { key: "effort", anchor: "center", modal: true, size: "md", head: "Effort", icon: "gauge", meta: view.current ? `now ${view.current}` : "", role: "omp.overlay.effort", foot }, [
    h("row", { key: "ends", role: "claude.effort.ends", align: "center" }, [h("text", { key: "0", wrap: "none", spans: [s("Faster", "muted")] }), h("spacer", { key: "fill", grow: 1 }), h("text", { key: "1", wrap: "none", spans: [s("Smarter", "muted")] })]),
    h("slider", { key: "level", role: "claude.effort.slider", value: view.at, min: 0, max: Math.max(1, view.levels.length - 1), step: 1, ticks: true, aria: "Effort level", onChange: (event: ChangeEvent) => on.level(Math.round(Number(event.value))) }),
    h(
      "row",
      { key: "labels", role: "claude.effort.labels", justify: "between", align: "center" },
      view.levels.map((name, index) => h("text", { key: name, role: "claude.effort.label", wrap: "none", ...(index === view.at ? { tone: "accent" } : {}), title: `Set to ${name}`, spans: [s(name, index === view.at ? "strong accent" : "muted")], onClick: () => on.level(index) })),
    ),
    h("text", { key: "detail", role: "claude.effort.detail", wrap: "word", spans: [s(view.detail)] }),
    view.warning ? h("text", { key: "warning", wrap: "word", spans: [s(view.warning, "warning")] }) : null,
    view.ultracode === null ? null : h("rule", { key: "rule" }),
    view.ultracode === null
      ? null
      : h("switch", { key: "ultra", role: "claude.effort.ultracode", label: "Ultracode", hint: `Dynamic workflows on every task, for this session${view.keys ? ".  Tab to toggle" : ""}`, on: view.ultracode, onChange: (event: ChangeEvent) => on.ultracode(event.on ?? event.value === true) }),
  ]);
}
