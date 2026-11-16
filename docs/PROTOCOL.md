# How claude-tsp talks to Claude Code

Verified against Claude Code 2.1.321 and 2.1.322. The types of every record are
in `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts`; this is what the surface uses.

## The process

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --include-partial-messages --replay-user-messages \
       --permission-prompt-tool stdio  [the user's flags] [--session-id | --resume …]
```

with `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`, so `rewind_files` has
checkpoints. One JSON record per line both ways (`src/cc.ts`).

A session outlives its process. Resume, rewind, fork, `/add-dir` and the return
from the terminal UI all stop the process and start another with
`--resume <id>` (`--resume-session-at <assistant uuid>`, `--fork-session`).
`/clear` stays in the process: Claude Code answers with `conversation_reset`.

Resuming replays nothing on the stream, so the conversation is redrawn from the
session file (`<config>/projects/<cwd with non-alphanumerics as ->/<id>.jsonl`):
the entries from the last message back through `parentUuid`, continuing at
`logicalParentUuid` across a compaction, plus tool results that hang off the
chain (calls made side by side). A subagent's messages are in
`<id>/subagents/agent-<agentId>.jsonl`.

## What we send

| Record | For |
|---|---|
| `control_request initialize` (`promptSuggestions`, `agentProgressSummaries`, `forwardSubagentText`, `perTaskStopAffordance`) | commands, models, account, version, mode |
| `user` with our own `uuid` | prompts and slash commands; `priority: "later"` queues for after the turn; `shouldQuery: false` records a `!command` without a turn |
| `interrupt`, `background_tasks`, `stop_task`, `cancel_async_message` | Esc, Ctrl+B, Stop, Alt+↑ |
| `set_model`, `set_permission_mode`, `apply_flag_settings {effortLevel, ultracode}` (a level sent without `ultracode` turns it off), `update_settings {outputStyle}`, `rename_session` | the chips and pickers |
| `get_settings`, `get_context_usage`, `get_usage`, `mcp_status`, `mcp_reconnect`, `mcp_toggle`, `list_permission_rules`, `get_task_output` | sheets |
| `rewind_files {user_message_id, dry_run}` | rewind |
| `control_response` | answers to Claude Code's requests |
| `initialize.hooks.PreToolUse` (matcher `Bash`) | the trace hook: its `hook_callback` is answered with `hookSpecificOutput.updatedInput` carrying the tracing prelude, or `{}` when tracing is off |
| `side_question`, `set_max_thinking_tokens` | `/btw`, Alt+T |

## What we receive

- `stream_event` (message, block and delta events), `assistant` (one whole
  block per record, same message id), `user` (tool results with
  `tool_use_result`, replays of our messages), `result` (a turn's end).
  A record with `parent_tool_use_id` belongs to that subagent.
- `system`: `init`, `status` (requesting, compacting, mode changes),
  `compact_boundary`, `api_retry`, `task_started` / `task_progress` /
  `task_updated` / `task_notification`, `background_tasks_changed`,
  `local_command_output`, `informational`, `notification`, `ui_status` (a
  plugin's status text), `thinking_tokens`, `session_title_changed`,
  `commands_changed`, `model_refusal_*`, `memory_recall`.
- `command_lifecycle` (a queued message was taken), `rate_limit_event`,
  `prompt_suggestion`, `tool_progress`, `active_goal`, `conversation_reset`.
- `control_request can_use_tool` (a permission, AskUserQuestion, ExitPlanMode),
  `elicitation` (an MCP server's form or link), `control_cancel_request`.

## Answers

- Allow: `{behavior: "allow", updatedInput, updatedPermissions?}`; a "don't ask
  again" choice passes one of the request's `permission_suggestions` back.
- Deny: `{behavior: "deny", message, interrupt}`. "No" interrupts the turn;
  "No, and tell Claude…" sends the note and lets the turn go on.
- AskUserQuestion: allow with `updatedInput.answers = {question: label}`; no
  answers reads as skipped.
- ExitPlanMode: allow with `updatedPermissions: [{type: "setMode", mode, destination: "session"}]`.

## Things that cost time

- Tern scopes a surface's stylesheet to what is inside its regions: a selector
  for the region itself matches nothing, so theme variables are set with `*`.
- The primary button is painted with `--grad`, the composer glow with `--a1`
  and `--a2`; `--accent` alone leaves both in the theme's color.
- `tern ctl type` takes one argument: quote the text twice (`'"two words"'`).
- A stored tool result of a parallel call is not on the `parentUuid` chain.
- claude-pi's plugin compacts by itself and writes its summary as a plain user
  message; it is recognised by its first line.

## Plugin UI

Claude Code's plugins can draw (`$.ui` in a plugin's hooks). A host that is not
the terminal takes part with control requests that are not in the published SDK
reference; they were read from Claude Code 2.1.321 and probed live.

| Message | Direction | Use |
|---|---|---|
| `ui_attach {surface, client_id, viewport{columns, rows, isFullscreen}}` | request | Joins as a surface. `surface: "desktop"` gets the element table of a graphical host. Panes are only placed for a client whose viewport says `isFullscreen: true`. |
| `ui_render {surface, client_id, component, instance_id, props}` | request | Asks the plugins' render hooks for a site: `AbovePrompt` (`above-prompt`), `Pane` (the pane's id). The answer is `{tree, props, hooked, drawn_by}`; `tree` is `{type, props, children, press}` elements (`Box`, `Text`, `Button`, `Link`, `Code`, `Markdown`), or `{type: "engine"}` when no plugin drew. |
| `ui_press {plugin, handle, key, surface, client_id}` | request | Runs a Button's closure, which stays in the plugin; `handle` comes from the element's `press`. |
| `ui_panes {client_id}` / `ui_close {id, client_id}` | request | Lists the open panes; closes one. |
| `system/ui_invalidate`, `system/ui_panes` | push | Something changed: ask again. |
| `system/ui_notify {plugin, title, text}`, `system/ui_log {plugin, text}` | push | A notification (a toast here) and a log line (a transcript notice here). |

`src/pluginui.ts` maps a tree to Tern nodes; `test/fixtures/widget-plugin` is a
plugin that exercises all of it.

## Dialogs Claude Code only draws in its terminal

| Command | Backed by |
|---|---|
| `/sandbox` | `get_sandbox_dialog` to read; `claude edit-sandbox-settings --json` (one edit on stdin: `mode`, `allowUnsandboxedCommands`, `excludeCommand`) to write. That command refuses to run inside another Claude Code session. |
| `/remote-control` | `remote_control {enabled, name}` → `{session_url, connect_url, …}`. Fails with "Remote Control initialization failed" where the bridge is not enabled for the account or build. |
| `/feedback` | `submit_feedback {description, surface, save_locally}` → `feedback_id`, `bundle_path`, or `unavailable_reason`. |
| `/install-github-app` | `gh` directly, with the workflow files Claude Code ships (`src/github.ts`); `CLAUDE_TSP_GH` names another `gh` (the tests use a stand-in). |
| `/plugin` marketplace | `claude plugin list --available --json`, `install`, `uninstall`, `marketplace add|update`. |
| `/stats` | counted from `<config>/projects/*/*.jsonl` (`src/stats.ts`). |
