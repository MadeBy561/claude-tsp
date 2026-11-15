# Changelog

## [1.0.0] - 2026-11-15

A new claude-tsp, written from scratch in TypeScript on Tern's SDK. It replaces
the Python adapter that mirrored a hidden terminal UI (retired).

- Drives Claude Code over its stream-json control protocol instead of scraping
  a pty: token streaming, exact tool results, permission requests by id.
- Transcript: streamed Markdown and thinking, cards for every tool (Bash with
  the command pane, Read groups, Edit and Write diffs, Grep, Glob, web search
  and fetch, tasks, questions, plans, LSP, MCP), subagents with live nested
  transcripts, compaction, `!command` runs, images.
- Dock: working row, task list, queue, context meter, model and effort chip,
  permission-mode pill, plan limits, plugin status texts.
- Dialogs: tool approvals with a native preview and Claude Code's "don't ask
  again" choices, AskUserQuestion, plan approval, MCP elicitation.
- Sessions: resume across projects, continue, clear, rewind with file restore,
  fork from a message, the session tree, branch, rename, export.
- Thinking on/off, side questions (`/btw`), hook activity and failures, prompt
  suggestions.
- Sign-in and sign-out dialogs over `claude auth`; an auth error offers the sign-in.
- Native `/doctor`, `/hooks`, `/memory` and `/plugin`; `/statusline` draws
  Claude Code's configured status line in the composer.
- Shell trace and replay: `!commands` always, Claude's Bash calls with `/trace`.
- `/keybindings`, `/terminal-setup`.
- Settings → Turns: Auto-compact, Auto-retry, and what Enter does while Claude
  works. `/ide` lists IDEs running the extension.
- `/tree` can summarize the branch it leaves; a jump onto an abandoned branch
  goes to where it forked.
- `tools/verify.sh`: 156 end-to-end checks in headless Tern.
- Sheets and pickers: models, effort, mode, context, usage, status, agents,
  background work, MCP servers, permission rules, skills, output styles,
  outline, copy, prompt history, settings, keys.
- Plugin UI: attaches to Claude Code as a host and draws what plugins render
  (band above the composer, panes, buttons, notifications, log lines); `/widgets`.
- Native `/install-github-app`, `/sandbox`, `/remote-control`, `/feedback`,
  `/release-notes`, `/stats`, `/upgrade`, `/privacy-settings`; a plugin
  marketplace tab with install and uninstall; permission rules added and
  removed; hook settings opened in `$EDITOR`.
- Native `/diff`, `/cd`, `/background`, `/subtask`, `/workflows`, `/rate-limit-options`,
  `/setup-bedrock`, `/setup-vertex`, `/install-slack-app`, `/mobile`, `/stickers`, `/radio`;
  keys for effort up and down, fast mode and stop-all; Claude Code's switches in `/settings`.
- The transcript column takes the composer's width; the rewind page, the sign-in
  dialog and the error banner follow it. Settings dropdowns open by click and key.
- A subagent's hand-back is shown as its report. `/context` uses a routed model's
  real window. Session and tree titles are the first real prompt, without Markdown marks.
- An explicit Ask mode survives a restart of Claude Code.
- `/tui` hands the pane to Claude Code's own terminal UI for anyone who wants it.
- `claude-pi-tsp`: the same surface over the claude-pi toolkit.
- Claude identity on any Tern theme: clay accent, spark mark, mode pill.
