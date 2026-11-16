# Changelog

## [1.1.0] - 2026-11-16

claude-tsp now keeps itself up to date, and watches whether Claude Code still
speaks what it relies on.

### Added

- `/update`: updates claude-tsp itself (the Tern surface, not Claude Code). It
  shows what every release since yours changed and installs the newest. A
  clone of the repository is moved to the release tag and rebuilt; a copy
  installed with `npm install -g` gets the release's tarball. A clone that is
  not on `main`, or has changes of its own, is left alone and the command to
  run is shown. A build that fails puts the version you had back.
- A check for a newer release once a day, with a note among the composer's
  facts when there is one. Nothing is installed until you say so. "Check for
  updates" in `/settings` (or `CLAUDE_TSP_NO_UPDATE_CHECK=1`) turns it off. The
  request goes to `api.github.com` with the version you run, nothing else.
- "Restart now" after an update: the new version starts in the same pane on
  the same conversation, and says what changed.
- `claude-tsp --check-compat`: asks a Claude Code for every control request
  the surface relies on and checks the fields it reads (`--bin <path>`,
  `--json`). The session it starts has a config directory of its own: no
  sign-in, no prompt, nothing of yours read or written.
- `/doctor` has the same check behind "Check the surface".
- A daily `claude-code-compat` workflow runs the check against the newest
  Claude Code on npm and opens an issue when it fails.
- `package.json` records the Claude Code range a release was checked with
  (`claudeCode.minimum`, `claudeCode.tested`). A Claude Code older than the
  minimum gets a warning at start.

### Fixed

- The welcome header fits a pane as narrow as a phone: the wordmark stays
  beside the logo and the version line shortens instead of being clipped (#2).
- A subagent's report no longer starts with Claude Code's
  `<tools-used-before-summary>` note, in the card, the transcript sheet and
  "Copy report" (#3).
- `tools/verify.sh` runs the checkout it is in, not the installed copy.

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
