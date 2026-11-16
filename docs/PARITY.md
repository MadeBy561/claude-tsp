# Parity

What claude-tsp 1.0.0 covers, against four references: Claude Code's terminal
UI (2.1.321/322), the claude-pi toolkit, and the two Tern surfaces it stands
beside, omp's and pi-tsp's. "Verified" means exercised in headless Tern
(`tools/serve.sh`) with the TSP error trace empty; the runs are listed at the end.

Legend: ✅ native in the surface · ◐ partly native · ↪ opens Claude Code's own
UI on the same session and returns · ➖ the reference has it but Claude Code has
nothing to back it.

Every command Claude Code's terminal UI offers (81 in 2.1.322, found by typing
each known name into it) has an entry here or is run by Claude Code itself.

## Claude Code

| Feature | | How |
|---|---|---|
| Streaming text and thinking | ✅ | `stream_event` deltas; thinking folds, with its duration |
| Bash, Read, Edit, MultiEdit, Write, NotebookEdit | ✅ | command pane and output; grouped reads; diffs from `structuredPatch` |
| Grep, Glob, LS | ✅ | matches grouped by file; file lists as links |
| WebSearch, WebFetch | ✅ | result links and summary; fetched page as Markdown |
| TodoWrite, TaskCreate/Update/List/Get | ✅ | one task list above the composer; reminder when a turn leaves work open |
| Agent / Task subagents | ✅ | card with model, tools, tokens, time, live activity; live nested transcript; Stop; nested subagents |
| Background commands, monitors, subagents | ✅ | pill, `/tasks` picker with output and Stop, Ctrl+B |
| AskUserQuestion | ✅ | question panel: single, multiple, free answer, several questions |
| Plan mode and ExitPlanMode | ✅ | plan card, approval with the mode to continue in |
| Tool permissions | ✅ | panel with native preview, "don't ask again" rules from Claude Code's own suggestions, deny with a note |
| Permission modes (Shift+Tab) | ✅ | Ask, Accept edits, Plan, Auto, Don't ask; Bypass when allowed at launch |
| MCP tools, MCP elicitation | ✅ | cards; link and form dialogs |
| `/model`, `/effort` | ✅ | pickers; chip in the composer |
| `/resume`, `--continue`, `--resume [id or name]` | ✅ | picker across projects with preview, fork, delete |
| `/clear`, `/compact`, `/rename`, `/export`, `/add-dir` | ✅ | |
| `/rewind` (Esc Esc) | ✅ | page with the point marked; conversation, files, or both |
| `/context`, `/usage`, `/cost`, `/status` | ✅ | sheets from Claude Code's own numbers |
| `/mcp`, `/permissions`, `/agents`, `/skills`, `/output-style` | ✅ | pickers; reconnect and toggle servers |
| Skills, custom and plugin commands | ✅ | in `/` completion, run by Claude Code |
| `!` shell mode, `@` files, image paste and `/attach` | ✅ | |
| Message queue while working, Esc to stop | ✅ | next-step and after-turn queues, edit back |
| Prompt suggestions, prompt history, Ctrl+R, Ctrl+S stash, Vim keys, `$EDITOR` | ✅ | |
| Rate-limit windows, API retries, errors, refusals | ✅ | status segments, retry countdown, error card with Retry |
| Hooks, CLAUDE.md memory, plugins, settings files | ✅ | they run and load as always |
| `/login`, `/logout` | ✅ | Claude Code's own sign-in (`claude auth login`) in a dialog: the link, then the code; an auth error offers it |
| `/doctor` | ✅ | `claude doctor`'s report in a sheet (the same checkup in Claude Code's own window is one button away) |
| `/plugin` | ✅ | loaded and installed plugins, each one's inventory and token cost, enable and disable; a Marketplace tab with every plugin on offer, install, uninstall, add and update marketplaces (`claude plugin …`) |
| Plugin UI (`$.ui`) | ✅ | the surface attaches as a host: what plugins draw above the prompt is drawn with Tern's own kinds, their buttons run, the panes they open come up as sheets with a tab by the band, notifications are toasts, log lines land in the transcript; `/widgets` reaches all of it by keyboard |
| `/hooks` | ✅ | the hooks in force and the events they can be set on; Ctrl+E opens the chosen settings file in `$EDITOR` |
| `/memory` | ✅ | the CLAUDE.md files, loaded or not, with a preview; Enter opens one in `$EDITOR` |
| `/keybindings` | ✅ | the surface's own bindings file, started from the defaults, in `$EDITOR`; applied when it closes |
| `/terminal-setup` | ✅ | nothing to install: Tern sends Shift+Enter as a new line already, and the command says so |
| `/ide` | ✅ | lists the IDEs that announce the Claude Code extension; choosing one starts the session again with `--ide` |
| `/install-github-app` | ✅ | the same wizard with pickers: repository, the GitHub App link, which workflows, the credential (an existing secret, a pasted key, or a subscription token from `claude setup-token`), a summary to confirm, then `gh` creates the branch, the workflow files Claude Code ships and the secret, and the pull request page is offered |
| `/sandbox` | ✅ | Claude Code's sandbox state (`get_sandbox_dialog`): mode, unsandboxed fallback, excluded commands, restrictions, missing dependencies; changes go through `claude edit-sandbox-settings` |
| `/permissions` rules | ✅ | Ctrl+N adds a rule to user, project or local settings; Ctrl+D removes one from the file it came from |
| `/remote-control` | ✅ | `remote_control`: the session's link in a sheet, Disconnect; where Claude Code refuses a host, its own window is offered; stock `claude-tsp` only (claude-pi runs with non-essential traffic off) |
| `/feedback`, `/bug` | ✅ | `submit_feedback`: write the report, then choose to send it or save a redacted copy on this machine; stock `claude-tsp` only |
| `/release-notes` | ✅ | the changelog in a sheet, the installed version marked |
| `/stats` | ✅ | counted from the stored sessions: sessions, prompts, tokens per model, active days, streaks, the last four weeks |
| `/upgrade`, `/privacy-settings` | ✅ | the page to open, as a link |
| `/diff` | ✅ | `get_workspace_diff`: the uncommitted changes, per file, as diffs |
| `/cd` | ✅ | `set_cwd`, with the folder trust question; the transcript moves with the session and Tern's folder label follows |
| `/background` (`/bg`) | ✅ | the session is handed to Claude Code's background service (`claude --bg --resume`) and a new one starts here |
| `/subtask` | ✅ | a forked copy of the conversation (`claude -p --resume --fork-session`) does the task; its result comes back as the next message |
| `/workflows` | ✅ | the session's workflows, running and finished; Ctrl+X stops one |
| `/rate-limit-options`, `/pro-trial-expired` | ✅ | what can be done about a limit: usage, upgrade, extra usage, credits, another model |
| `/setup-bedrock`, `/setup-vertex` | ✅ | region, profile or project, and model pin, written to the `env` of the user's settings; the session starts again on the provider |
| `/install-slack-app`, `/mobile`, `/stickers`, `/radio` | ✅ | the page to open, as a link |
| `/teleport` | ◐ | stock `claude-tsp` only: the account's cloud sessions are listed here (`list_cloud_sessions`); opening one, or sending this session to the cloud, runs in Claude Code's own window. Not run against a real cloud session. |
| `/autofix-pr`, `/passes`, `/remote-env` | ↪ | each talks to Anthropic's service with the account's sign-in and has no host request; drawing them here would mean reading the credentials file and imitating private calls. They open Claude Code's own window on this session and return here when it exits |
| `/powerup` | ↪ | an interactive lesson player built into the terminal UI; opens Claude Code's own window |
| `/voice` | ↪ | Claude Code records from a microphone on the machine it runs on, and neither the host protocol nor Tern carries audio; opens Claude Code's own window (which needs a microphone on that machine) |
| Claude Code's `/config` entries | ◐ | eleven are in a Claude Code section of `/settings`, written to the user's settings file: default permission mode, worktree base ref, and nine switches (idle compaction, continue at usage limit, session recap, checkpoints, workflows, ultracode trigger, auto mode during plan, turn duration, verbose). Model, theme, output style, editor mode, thinking and auto-compact have their own rows. Eight entries live in Claude Code's `.claude.json`, which it rewrites constantly and which holds account state, so the surface does not write there: gitignore in the file picker, skip the copy picker, agents view, left arrow opens agents, external editor context, PR status footer, IDE auto-connect, Chrome default. Those, and its submenus (language, notifications, time format, auto-update channel), are in Claude Code's own screen (`/tui /config`). |
| Effort up and down, stop all agents | ✅ | Shift+Up, Shift+Down, Alt+X (`/stop-all`); run live |
| Fast mode (Alt+O, `/fast`) | ➖ | the key sends `/fast`, and Claude Code answers "Fast mode is not available in the Agent SDK": it does not offer fast mode to a host |
| Thinking on/off (Alt+T, `/thinking`) | ✅ | `set_max_thinking_tokens`; Alt+E steps the effort |
| `/btw` side questions | ✅ | answered beside the conversation, also while Claude works |
| Hook activity and failures | ✅ | the running hook in the working row; a failed hook as a warning line |
| Status line (`statusLine.command`) | ✅ | `/statusline`: the configured command is run with the session's facts and its line drawn in the composer; off by default, since the composer already shows model, context, cost and limits |
| `--bg`, `--cloud`, `--remote-control`, `--teleport`, `--worktree`, `-p` | ✅ | passed straight to stock Claude Code: these are not sessions in this pane |

## claude-pi

| Feature | | How |
|---|---|---|
| Sparse prompt, tool set, plugin, both accounts | ✅ | `claude-pi-tsp` passes the toolkit's own arguments; `CLAUDE_PI_CONFIG_DIR` as before |
| Local and ChatGPT models under their own names | ✅ | picker rows and the composer chip, with the maker's logo |
| Real context windows for routed models | ✅ | `local.json`'s window; 272K for the ChatGPT rows |
| Local model effort (`/deepseek-effort`) | ✅ | the effort chip and picker drive the plugin's command |
| Cache figures (`$.ui.status`) | ✅ | status segment |
| Subagent model in the task name | ✅ | shown on the agent card |
| Plugin commands (`/codex-login`, `/pi-status`, …) | ✅ | run by the plugin; output in the transcript |
| Monitor tool and its wake-ups | ✅ | card; each batch of lines as an event block |
| Compaction by the routed model | ✅ | compaction row with the summary |

## omp's and pi-tsp's surfaces

| Feature | | Note |
|---|---|---|
| Inline `omp.session` surface, block-wise reconciliation, settle | ✅ | same core as pi-tsp |
| Welcome lockup, tips | ✅ | Claude's mark and name |
| Tool cards, read groups, compact tools, expand all, hide thinking | ✅ | |
| Subagent cards and transcript sheet | ✅ | live, where pi-tsp reads files |
| Approval panel, field dialog, pickers, sheets, settings window, toasts | ✅ | |
| Context meter, model chip, effort chip, cost, working row, queue rows | ✅ | plus the mode pill |
| Rewind page, fork picker, outline, copy picker, history search | ✅ | |
| Usage line per message, charts for tables, images, clipboard paste | ✅ | |
| Vim keys, key bindings file, external editor, desktop notifications | ✅ | |
| Session tree (`/tree`) | ✅ | built from the session file's parent links, old branches included |
| Shell trace and replay | ✅ | `!commands` are always traced; `/trace` traces Claude's Bash calls through a PreToolUse hook answered over the protocol (off by default: a traced command no longer matches allow rules written for its text). The inspector plays, steps and seeks |
| Auto-compact, auto-retry and steering-mode switches | ✅ | Settings → Turns: Auto-compact and Auto-retry (Claude Code's `DISABLE_AUTO_COMPACT` and `CLAUDE_CODE_MAX_RETRIES`, applied by starting it again on the session), and what Enter does during a turn: next step, after the turn, or stop and send |

## omp, row by row

The omp inventory made for pi-tsp (104 rows; kept with pi-tsp's parity record) was
walked again for this surface. claude-tsp shares pi-tsp 2.0.2's protocol core
(`region.ts`, `editor.ts`, `picker.ts`, the SDK session), so the protocol rows
carry over unchanged.

| Rows | Subject | |
|---|---|---|
| P1–P29 | Probe and optimistic open, feature gating, `adopt`, chunking, credits and stall recovery, `move`/`splice`/`settle`/`scroll`/`focus` ops, unique ids, `toggle`/`edit`/`undo`/`send`/`focus` events, blobs, typeahead, record file | ✅ all 29 |
| T1–T23 | Container and settling, welcome, user card, assistant block and turn footer, streaming text, thinking, failed-request frame, retry countdown and recovered note, abort label, usage row, model marker, compaction, custom and hook lines, command rows, warnings, working row, figures, images, compact mode, hold menus, outline, todo reminder | ✅ |
| T13 | Branch summary | ✅ moving in `/tree` with Ctrl+S has Claude summarize the branch being left; it is drawn as a "Branch summarized" section and given to Claude as context |
| L1–L16 | Tool frame, status machine, per-node fold, live argument streaming, bash with `shell` node and live output, edit diff, write, read and read groups, search tools, default `json` view, result images, `!` rows, todo card and HUD, agent node with nesting, MCP and plugin tools | ✅ |
| C1–C17 | Editor props and gated `sendable`, bash mode, paste chips, model and effort chip, context meter, status segments, `rate` and `elapsed`, Send/Stop, queue block, todo HUD, caret-anchored autocomplete, `@` files, history search, multi-line editing, remappable keys, Vim, toasts with actions | ✅ |
| C18 | Extension widgets | ✅ Claude Code's plugin UI: the surface attaches as a host (`ui_attach`), draws what plugins render above the prompt and in panes, and sends presses back |
| O1, O3–O6, O8–O10, O12–O18 | Approval with the request's own options, input field, model and effort pickers, session picker with delete confirm, rewind page, copy picker, `prefs` settings, session info, agent viewer, context viewer, hotkeys, plan review, error banner, program-owned picker search | ✅ |
| O2 | Extension `select` / `confirm` | ✅ as AskUserQuestion and MCP elicitation, Claude Code's two ask-the-user channels |
| O7 | Tree selector | ✅ `/tree`: every message of the session, abandoned branches indented and marked; Enter continues from one |
| O11 | Login dialogs | ✅ `/login` and `/logout` dialogs over `claude auth` |

omp-only surfaces (§3 of that matrix) that Claude Code can back are drawn:
the usage sheet, MCP server list, running-work pill and job list, recap and
away notices, the goal segment, side questions. The rest (advisor, collab, IRC,
autoresearch, git TUI, spotlight, dictation, reactions) have no Claude Code
counterpart.

## What has been run for real

Beyond `tools/verify.sh`, these were run once by hand with the account's owner (2026-11-15):

| Path | Result |
|---|---|
| `/remote-control` | on stock `claude-tsp`: turned on, the link opened on another device, a message sent from there arrived here as a user message and was answered; turned off. On, link and off are also in V. It needs Claude Code's non-essential traffic on; claude-pi's settings switch that off, so `claude-pi-tsp` leaves the command out. |
| `/feedback` | a report saved on this machine (V), and one dummy report sent to Anthropic, which returned a feedback id. |
| `/install-github-app` | against a real private repository made for the purpose: the branch, both workflow files and the secret were read back from GitHub. V runs it against a stand-in `gh` on every run. |
| "Create a subscription token" in that wizard | completed: sign-in in a browser, the code pasted, the token read from `claude setup-token` and saved as `CLAUDE_CODE_OAUTH_TOKEN`, the workflow written to read it. A refused code shows Claude Code's own reason. |
| Plugin marketplace add, install, uninstall | in a scratch config with a local marketplace (V). |
| `/login` for plain `claude` | completed on `~/.claude`: link, code, the session restarted signed in and answered a prompt. The dialog and a refused code are in V. |

## Verification

`tools/verify.sh` drives both commands in headless Tern and checks the live
document: 163 checks, each a PASS or FAIL line. The last full run is kept in
`docs/VERIFY.txt` (2026-11-16, Tern 0.9.20): **163 passed, 0 failed**.
`docs/OMP-ROWS.md` lists each of omp's 104 rows with the check or test that
shows it.

On `claude-pi-tsp` with the local model: start-up and naming; a write approval
with "accept all edits" and the mode change; Shift+Tab stepping modes and
skipping one the model lacks; Ctrl+B backgrounding, the pill, `/tasks` and
Stop; AskUserQuestion; a subagent whose own command asks for approval, and its
transcript sheet; the task list; `!command` shared with the model, traced, and
opened in the inspector; `/trace` tracing one of Claude's Bash calls with its
output untouched; `/btw`;
Alt+T; 22 overlay commands opening and closing (the native `/doctor`,
`/hooks`, `/memory` and `/plugin` among them); claude-pi's own status line
switched on and off; the command-line plugin listed; `/add-dir`; `/rename`;
`/export`; an attached image read by the model; `/compact` and recall after
it; `/clear`; an edit with its diff; rewind restoring the file and the resend;
`/tree` showing the abandoned branch, and a jump onto it with a summary of
the branch left; a message sent mid-turn queued for after the turn and then
delivered (Settings → Turns); `/resume`; Esc stopping a command
without an error card; the hand-off to Claude Code's own UI and back; the clay
accent in the light and the dark theme, and `/theme` handing the accent back
to Tern's; no TSP errors.

On stock `claude-tsp` (Claude Code 2.1.322, default prompt and tools, Haiku
5.5, signed in through claude-pi's config): naming; plan mode ending in a plan
approval, the approved edit made; a prompt suggestion offered and taken with
Tab; an MCP server's form filled and its answer reaching the tool; a failing
hook leaving a warning line; no TSP errors.

Sign-in, settings and retries: `/ide` lists an IDE that announces itself;
switching Auto-compact and Auto-retry off starts Claude Code again with them
off; with no sign-in the error card offers one; `/login` opens
the dialog with Claude's link; a wrong code is refused and writes nothing. With
the API answering "overloaded" three times (`tools/overload-proxy.mjs`), the
working row counts down the retry, the turn recovers and says so, and the
answer arrives.

Not covered by a live run: finishing a real sign-in (it needs a person at
claude.ai), and so turns under `~/.claude`'s own sign-in, which is expired on
this machine (`claude -p` fails the same way; `/login` in `claude-tsp` is the
fix).

`npm test`: 78 tests.
