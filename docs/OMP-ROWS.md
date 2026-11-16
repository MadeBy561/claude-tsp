# omp, row by row

Every row of the omp inventory (pi-tsp's parity matrix, §1 and §2: 104
rows) against claude-tsp, with what shows it. Evidence is one of:

- **V** a check in `tools/verify.sh` (the last run is `docs/VERIFY.txt`);
- **T** a unit test in `test/`;
- **S** code shared unchanged with pi-tsp 2.0.2, where the row was closed and
  verified (its parity matrix, §6, passes one to twelve), and which
  every V check here runs through;
- **➖** omp has it and Claude Code has nothing to back it.

## Protocol (P1–P29)

| # | Behaviour | | Evidence |
|---|---|---|---|
| P1 | Probe with hello and DA1; DA1 ends the wait elsewhere | ✅ | S `launcher.ts` (`connect`) |
| P2 | Optimistic open inside Tern, fall back if unconfirmed | ✅ | S `launcher.ts`; V "starts" |
| P3 | Hello `ver` | ✅ | S (the SDK's session) |
| P4 | Kinds and features gated on `hello` | ✅ | S `app.ts` (`caps.kinds`, `caps.features`) |
| P5 | Inline surface, role `omp.session` | ✅ | V "starts"; `SURFACE` |
| P6 | `adopt` after handing the pane away | ✅ | V "the pane comes back from Claude Code's own UI" |
| P7 | Chunking in UTF-8 bytes | ✅ | S (SDK) |
| P8 | Inbound reassembly | ✅ | S (SDK) |
| P9 | Credits, reset after a stall | ✅ | S `#unstall` |
| P10 | Ctrl+C among other bytes | ✅ | S (SDK keys) |
| P11 | `move` for reordered children | ✅ | T `region.test.mjs` |
| P12 | `splice` for mid-text edits | ✅ | S `splice.ts`; T `editor.test.mjs` |
| P13 | `settle` finished blocks | ✅ | S `render` |
| P14 | `scroll` op on page keys | ✅ | S `#composerKey`, `#sheetKey` |
| P15 | `focus` follows the active input | ✅ | V question, approval and sign-in dialogs take typing |
| P16 | Root add and remove after the first frame | ✅ | T `region.test.mjs` |
| P17 | Unique node ids | ✅ | T `region.test.mjs`; V "no TSP errors" (four runs) |
| P18 | Prop removal | ✅ | S (SDK reconciler) |
| P19 | `error` recovery | ✅ | S `#onEvent` resync |
| P20 | Theme and motion | ✅ | V light, dark and `/theme` checks |
| P21 | `toggle` remembered per node | ✅ | S `#fold` |
| P22 | `edit`: stale `len` rejected, one undo unit | ✅ | T `editor.test.mjs` |
| P23 | `undo` | ✅ | T `editor.test.mjs` |
| P24 | `send`: blank is a no-op, gated by `sendable` | ✅ | S `dock.ts`, `#dockActions.send` |
| P25 | `focus` event | ✅ | S |
| P26 | Blobs by sha256 | ✅ | V "the model read the image" (the chip and the message draw it) |
| P27 | Valid text everywhere | ✅ | V "no TSP errors" |
| P28 | Typeahead during startup | ✅ | S `dock.ts` (`typeahead`) |
| P29 | Record file | ✅ | `CLAUDE_TSP_RECORD`, `CLAUDE_TSP_TRACE` |

## Transcript (T1–T23)

| # | omp element | | Evidence |
|---|---|---|---|
| T1 | Inline container, blocks settled | ✅ | V every transcript check |
| T2 | Welcome block | ✅ | V "starts", "the stock profile is named Claude Code"; T view |
| T3 | User card with images | ✅ | V "an attached image chip", "the model read the image" |
| T4 | Assistant container and turn footer | ✅ | T view; seen live (`omp.turn.usage`) |
| T5 | Assistant text streaming | ✅ | T model "streamed text and thinking" |
| T6 | Thinking section | ✅ | T model; V Alt+T |
| T7 | Request-failed frame with actions | ✅ | V "without a sign-in the error card offers one" |
| T8 | Retry countdown and recovered note | ✅ | V "an overloaded API shows the retry countdown", "the turn recovers and says so"; T model |
| T9 | Abort label | ✅ | V "Esc stops the turn"; T model |
| T10 | Per-message usage row | ✅ | T model (usage items); setting "Token usage per message" |
| T11 | Model-change marker | ✅ | S `#onAssistant` marker |
| T12 | Compaction summary | ✅ | V "/compact leaves a compaction row"; T model |
| T13 | Branch summary | ✅ | V "a move in the tree can carry a summary of the branch left"; T model |
| T14 | Custom and hook messages | ✅ | V "a failing hook leaves a warning line"; T model |
| T15 | Skill message | ✅ | T model "stored command echoes"; skills run as `/name` rows |
| T16 | Warning and error lines | ✅ | V hook warning; T model |
| T17 | Working row | ✅ | V "a command is running", retry countdown |
| T18 | Markdown figures | ✅ | S `chart.ts` |
| T19 | Inline and tool-result images | ✅ | V image checks; T model (`imagesOf`) |
| T20 | Compact presentation | ✅ | S; setting "Compact tool calls" |
| T21 | Hold menus, copy | ✅ | S user and assistant `actions` |
| T22 | Outline | ✅ | V "/outline opens and closes" |
| T23 | Todo reminder | ✅ | T model "a turn that leaves work open says so" |

## Tools (L1–L16)

| # | omp | | Evidence |
|---|---|---|---|
| L1 | Generic tool frame | ✅ | T view "every Claude Code tool gets a card" |
| L2 | Status machine, history calls without results | ✅ | T model (stored transcript, cancelled calls) |
| L3 | Fold per node | ✅ | S `#fold` |
| L4 | Live argument streaming | ✅ | T model "a tool call streams its arguments" |
| L5 | bash with `shell` node and live output | ✅ | V "a command is running"; trace and replay checks |
| L6 | edit diff | ✅ | V "an Edit card with a diff"; T view (`structuredPatch`) |
| L7 | write | ✅ | V "a Write card" |
| L8 | read with line numbers, images | ✅ | T view |
| L9 | read group | ✅ | T view "the transcript groups reads" |
| L10 | grep, glob | ✅ | T view |
| L11 | default `json` view | ✅ | T view (MCP card) |
| L12 | Result images | ✅ | T model |
| L13 | User `!` row with live output, cancellable | ✅ | V "a !command row", "the shell output reached the model" |
| L14 | todo card and HUD | ✅ | V "the task list above the composer"; T model |
| L15 | agent node, nested | ✅ | V "a subagent card", "Alt+A opens the agents pane"; T model, T agents |
| L16 | Extension tools | ✅ | V "the form's answer reached the tool" (an MCP tool's card) |

## Composer, dock, status (C1–C18)

| # | omp | | Evidence |
|---|---|---|---|
| C1 | Editor props, gated `sendable` | ✅ | S `dock.ts`; V every prompt is typed into it |
| C2 | Bash mode restyles the editor | ✅ | S `dock.ts`; V "a !command row" |
| C3 | Paste chips | ✅ | T `editor.test.mjs` |
| C4 | Model chip and effort glyph | ✅ | V naming checks, Alt+T; T view |
| C5 | Context meter | ✅ | T view (25% label) |
| C6 | Status segments | ✅ | V status line on and off; T view (limits, plugin text) |
| C7 | `rate` and `elapsed` nodes | ✅ | S `dock.ts` |
| C8 | Send and Stop | ✅ | V "Esc stops the turn" |
| C9 | Queue block | ✅ | T model, T view; seen live (queue row during the subagent approval) |
| C10 | Todo HUD | ✅ | V "the task list above the composer" |
| C11 | Caret-anchored autocomplete | ✅ | V every `/command` check runs through the popup |
| C12 | `@` file picker | ✅ | S `#updateCompletion`, `files.ts` |
| C13 | History search | ✅ | S `#pickHistory` (Ctrl+R) |
| C14 | Multi-line editing, kill ring, undo | ✅ | T `editor.test.mjs` |
| C15 | Remappable key bindings | ✅ | T `editor.test.mjs` (keymap); `/keybindings` |
| C16 | Vim mode | ✅ | T `vim.test.mjs` |
| C17 | Toasts with actions | ✅ | S `toast` (the export toast carries "Copy path") |
| C18 | Extension widgets | ✅ | V "a plugin's band is drawn above the composer", "pressing a plugin's button runs it and the band redraws", "a pane a plugin opens comes up with what it drew"; T `pluginui.test.mjs` |

## Overlays and commands (O1–O18)

| # | omp | | Evidence |
|---|---|---|---|
| O1 | Approval with the request's own options | ✅ | V "a write asks for approval", "offers accept-all-edits" |
| O2 | Extension select and confirm | ✅ | V "a question panel", "an MCP server's form opens" |
| O3 | Extension input and editor | ✅ | V MCP form, sign-in dialog |
| O4 | Model picker | ✅ | V "/model opens and closes" |
| O5 | Thinking selector | ✅ | V "/effort opens the effort dialog", Alt+T; T effort |
| O6 | Session picker with delete confirm | ✅ | V "/resume redraws another session" |
| O7 | Tree selector | ✅ | V "/tree shows the abandoned branch"; T model |
| O8 | Rewind page | ✅ | V "rewind restores the file", "keeps only the earlier message" |
| O9 | Copy selector | ✅ | V "/copy opens and closes" |
| O10 | Settings as `prefs` | ✅ | V "/settings opens and closes" |
| O11 | Login dialogs | ✅ | V "/login opens the sign-in dialog", "a wrong code is refused" |
| O12 | Session info | ✅ | V "/status opens and closes" |
| O13 | Agent transcript viewer | ✅ | V "one agent in the session opens on its conversation", "Full view opens the conversation over the whole pane" |
| O14 | Context viewer | ✅ | V "/context opens and closes" |
| O15 | Hotkeys sheet | ✅ | V "/help opens and closes" |
| O16 | Plan review | ✅ | V "plan mode ends in a plan approval", "the planned edit was made" |
| O17 | Error banner | ✅ | S `errorBanner`; seen live with the sign-in error |
| O18 | Program-owned picker search | ✅ | S `picker.ts` |

All 104 rows are covered. C18 (extension widgets), the last one, is Claude
Code's plugin UI: the surface attaches to the session as a host and draws what
plugins render (`docs/PROTOCOL.md`, "Plugin UI").

omp's shell visualizer replay (listed there under omp-only surfaces, and in
pi-tsp through its trace extension) is here as well: V "a !command is traced",
"with /trace on, Claude's Bash call is traced too".
