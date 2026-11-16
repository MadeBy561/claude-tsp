<p align="center">
  <img src="docs/logo.svg" alt="claude-tsp" width="96">
</p>

<h1 align="center">claude-tsp</h1>

<h3 align="center">Claude Code, rendered native in Tern.</h3>

<p align="center">
  A real surface for Claude Code: semantic markdown, tool cards, diffs,
  subagents, approvals, plans, model and effort pickers, session management,
  plugin widgets, and a composer that belongs in Tern.<br>
  No ANSI mirror. No patched Claude Code. Stock <code>claude</code> outside Tern.
</p>

<p align="center">
  <img alt="Node 22+" src="https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white">
  <img alt="Claude Code 2.1.300+" src="https://img.shields.io/badge/Claude%20Code-2.1.300%2B-C2603F">
  <img alt="Tern 0.9.20+" src="https://img.shields.io/badge/Tern-0.9.20%2B-a06bff">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-2ea44f">
  <a href="https://github.com/MadeBy561/claude-tsp/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/MadeBy561/claude-tsp?color=C2603F"></a>
  <a href="https://github.com/MadeBy561/claude-tsp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MadeBy561/claude-tsp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/MadeBy561/claude-tsp/actions/workflows/claude-code-compat.yml"><img alt="Claude Code compatibility" src="https://github.com/MadeBy561/claude-tsp/actions/workflows/claude-code-compat.yml/badge.svg"></a>
</p>

<p align="center">
  <img src="docs/claude-tsp.png" alt="claude-tsp launch surface" width="100%">
</p>

---

| A turn: read, edit with a diff, run | Approval, with the request's own choices |
|---|---|
| ![A turn](docs/claude-tsp-turn.png) | ![Approval](docs/claude-tsp-approval.png) |

| Subagents at work, in a pane of their own | `/effort`, with Ultracode |
|---|---|
| ![Agents pane](docs/claude-tsp-agents.png) | ![Effort](docs/claude-tsp-effort.png) |

| Models | Settings | Light |
|---|---|---|
| ![Models](docs/claude-tsp-models.png) | ![Settings](docs/claude-tsp-settings.png) | ![Light theme](docs/claude-tsp-light.png) |

Light and dark follow Tern, as do its themes; the clay accent is Claude's own
and `/theme` hands the accent back to Tern's.

It is a front end, not a fork. `claude-tsp` starts the Claude Code you already
have and talks to it over its stream-json protocol (`claude -p --input-format
stream-json --output-format stream-json`, the channel the Agent SDK uses), so
models, permissions, sessions, skills, plugins, hooks and MCP servers are all
Claude Code's own. Sessions are shared with the terminal UI: anything started
here resumes there, and the other way round.

Two commands:

- `claude-tsp` fronts the `claude` on your `PATH` with your normal config.
- `claude-pi-tsp` fronts the claude-pi toolkit, if you have it installed: its private
  binary, sparse system prompt, tool set and `pi-harness` plugin, so the local
  model and the ChatGPT-subscription models appear in the model picker with
  their own names and logos.

Outside Tern, and for every non-interactive invocation (`-p`, `--version`,
`mcp …`, `plugin …`), both are the stock program with the arguments unchanged.

## Install

```sh
npm install        # builds dist/
ln -sf "$PWD/bin/claude-tsp" ~/.local/bin/claude-tsp
ln -sf "$PWD/bin/claude-pi-tsp" ~/.local/bin/claude-pi-tsp
```

Node 22.19 or newer, Tern 0.9.20 or newer, Claude Code 2.1.300 or newer.

## Use

Every Claude Code flag passes through: `claude-tsp --model opus`,
`claude-tsp --continue`, `claude-tsp --resume` (opens the picker),
`claude-tsp --permission-mode plan "plan the refactor"`.

| Key | Does |
|---|---|
| Enter | Send. While Claude works, the message is taken at its next step |
| Alt+Enter | Queue for after the current turn; Alt+↑ brings queued messages back |
| Shift+Enter, `\` Enter | New line |
| Esc | Stop Claude (or a running `!command`); twice on an empty draft opens rewind |
| Shift+Tab | Step the permission mode: Ask, Accept edits, Plan, Auto |
| Alt+P | Switch model; Alt+T turns thinking on or off; Alt+E steps the effort |
| Alt+A | Show or hide the agents pane |
| Ctrl+B | Send the running command or subagent to the background |
| Ctrl+T, Ctrl+O | Show or hide the task list; expand every block |
| Ctrl+R, Ctrl+S | Search prompt history; set the draft aside |
| `/`, `@`, `!` | Commands and skills, files, shell (`!!` keeps the output from Claude) |
| Tab | Take the suggested next prompt |

`/help` lists the rest. Keys are rebound in
`~/.local/state/claude-tsp/keybindings.json` (`{"app.model.select": "ctrl+l"}`).

### Commands

Drawn natively: `/model`, `/effort`, `/mode`, `/plan`, `/resume`, `/continue`,
`/clear`, `/rewind`, `/fork`, `/tree`, `/branch`, `/context`, `/usage`, `/status`,
`/cost`, `/rename`, `/agents`, `/tasks`, `/todos`, `/mcp`, `/permissions`, `/btw`, `/thinking`, `/login`, `/logout`, `/doctor`, `/hooks`, `/memory`, `/plugin`, `/statusline`, `/trace`, `/keybindings`, `/ide`,
`/skills`, `/output-style`, `/add-dir`, `/outline`, `/copy`, `/export`,
`/inspect`, `/attach`, `/retry`, `/config`, `/vim`, `/theme`, `/help`.

Run by Claude Code itself, with their output in the transcript: `/compact`,
`/init`, `/goal`, `/review`, every skill, and every plugin command.

Almost nothing needs Claude Code's own terminal UI (five commands still open
it: `/autofix-pr`, `/passes`, `/powerup`, `/remote-env`, `/voice`). Its wizards and dialogs
(`/install-github-app`, `/sandbox`, `/remote-control`, `/feedback`, `/stats`,
`/release-notes`, the plugin marketplace, permission rules) are drawn here.
`/tui [command]` still hands this pane to it on the same session, and takes it
back when it exits.

`/remote-control` and `/feedback` are in `claude-tsp` only: they need Claude
Code's non-essential traffic, which claude-pi's settings switch off.

Plugins that draw (`$.ui`) are drawn too: their band sits above the composer,
their panes open as sheets, and `/widgets` reaches their buttons by keyboard.

### Subagents

A chip in the composer counts the session's subagents. Click it, press Alt+A,
or open an agent's card, and they get a pane of their own: every agent at
once, the ones at work with their last steps live, and one tap into any
agent's conversation as it is written. On a desktop the pane sits beside the
conversation; on a phone it is a drawer.

### Effort and Ultracode

`/effort` opens the dialog Claude Code draws: a track from Faster to Smarter
with the model's levels. ←/→ move, Tab switches Ultracode (a workflow for
every task, for this session), Enter confirms and saves the level as your
default, S keeps it to this session. `/effort high`, `/effort auto` and
`/effort ultracode on` do the same from the keyboard.

## Updates

claude-tsp asks GitHub once a day whether a newer release is out. When one is,
a note appears among the composer's facts; nothing is installed until you say
so.

- `/update` shows what every release since yours changed and installs the
  newest: a clone of this repository is moved to the release tag and rebuilt
  (`git merge --ff-only`, `npm ci`), an `npm install -g` copy gets the
  release's tarball. A clone that is not on `main`, or has changes of its own,
  is left alone and the command to run is shown instead. A build that fails
  puts the version you had back.
- After an update, "Restart now" starts the new version in the same pane on
  the same conversation.
- "Check for updates" in `/settings` turns the daily question off, as does
  `CLAUDE_TSP_NO_UPDATE_CHECK=1`. The request goes to `api.github.com` and
  carries the version you run, nothing else.

A patch release (`1.0.x`) fixes things, a minor one (`1.x.0`) adds features,
and a major one changes something you have to act on.

## Claude Code updates

The surface drives Claude Code through control requests of its stream-json
session, several of them not in the published SDK, so a Claude Code update can
change one. Three things watch for that:

- `claude-tsp --check-compat` asks a Claude Code for every request the surface
  relies on and checks the fields it reads (`--bin <path>` for a Claude Code
  other than the one on `PATH`, `--json` for a machine). The session it starts
  has a config directory of its own: no sign-in, no prompt, nothing of yours
  read or written. `/doctor` has the same check behind "Check the surface".
- The `claude-code-compat` workflow runs it every day against the newest
  Claude Code on npm and opens an issue when a check fails.
- `package.json` records the range a release was checked with
  (`claudeCode.minimum`, `claudeCode.tested`); a Claude Code older than the
  minimum gets a warning at start.

## Look

The surface follows Tern's theme, light or dark, including custom themes. Its
own identity is Claude's clay as the accent color, the spark mark, and the
permission-mode pill. `/theme` (or Settings → Display → Claude accent) switches
the clay off, and the Tern theme's own accent is used instead.

## Environment

| Variable | Effect |
|---|---|
| `CLAUDE_TSP_BIN` | The Claude Code binary to front (default: `claude` on `PATH`) |
| `CLAUDE_CONFIG_DIR` | Claude Code's config directory, as for `claude` itself |
| `CLAUDE_TSP_HOME` | Where prompt history, display choices and key bindings are kept (default `~/.local/state/claude-tsp`) |
| `CLAUDE_TSP_STOCK=1` | Always run stock Claude Code |
| `CLAUDE_TSP_NOTIFICATIONS=0` | No desktop notification when a turn ends or an approval waits in a hidden pane |
| `CLAUDE_TSP_RECORD=file`, `CLAUDE_TSP_TRACE=file` | Record the TSP traffic; log TSP errors |
| `CLAUDE_TSP_CSS=file` | A stylesheet to try in place of the built-in one |
| `CLAUDE_TSP_NO_UPDATE_CHECK=1` | Never ask GitHub whether a newer claude-tsp is out (`/update` still does when you run it) |
| `CLAUDE_TSP_RELEASES_URL=url` | Read the releases from another address (a test feed) |

## Develop

```sh
npm test                                  # build + 87 tests
tools/verify.sh                           # 180 end-to-end checks in headless Tern (about 15 minutes)
tools/serve.sh start a /tmp/demo "$PWD/bin/claude-tsp"   # headless Tern
tools/say.sh a "hello" 6 shot-name        # type, send, wait, screenshot
tools/serve.sh stop a
```

`docs/PROTOCOL.md` describes the Claude Code side; `docs/OMP-ROWS.md` goes
through omp's inventory row by row; `docs/PARITY.md` lists every
feature against Claude Code's terminal UI, claude-pi, omp's and pi-tsp's
surfaces, with what is not covered.

## Release policy

claude-tsp uses Semantic Versioning and one release per merged improvement:

1. Every PR bumps `package.json` and adds a matching `CHANGELOG.md` section.
2. The `version-check` workflow rejects a PR whose version is not higher than
   `main`.
3. Merging to `main` runs `release.yml`, which creates `v<version>`, publishes
   a GitHub release and attaches `claude-tsp-<version>.tgz`.
4. A release sets `claudeCode.tested` in `package.json` to the newest Claude
   Code that `claude-tsp --check-compat` and `tools/verify.sh` passed with.

## Contributing

Fixes and features are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the
workflow, what each file is responsible for, and how to check a change in
Tern; [CHANGELOG.md](CHANGELOG.md) has the release notes.

## Repository

```text
bin/claude-tsp          entry point
bin/claude-pi-tsp       the same surface in front of a claude-pi install
src/launcher.ts         surface or stock Claude Code
src/cc.ts               the claude child and its stream-json control protocol
src/app.ts              focus, keys, commands, pickers, dialogs, the session
src/model.ts            Claude Code messages and stored sessions -> items
src/view/               items and state -> nodes (transcript, tools, dock, overlays)
src/pluginui.ts         what Claude Code plugins draw, as Tern nodes
src/github.ts           /install-github-app over the GitHub CLI
src/settingsfile.ts     Claude Code's settings files: rules, env, switches
src/stats.ts            /stats from the stored sessions
src/sessions.ts         session discovery and previews
src/theme.ts            the stylesheet and the clay accent
src/editor.ts, vim.ts, picker.ts, keymap.ts, region.ts, shell.ts, chart.ts
test/                   unit tests and fixtures
tools/                  headless Tern harness and the end-to-end checks
docs/                   parity record, protocol notes, screenshots
.github/workflows/      CI, version check and release
```

## Credits

claude-tsp exists to bring more programs to Tern's Surface Protocol. It builds
on other people's work and is not affiliated with any of them:

- [Claude Code](https://claude.com/claude-code) by Anthropic — the agent, and
  the stream-json protocol this surface drives. Claude Code is not patched or
  redistributed here; you install it yourself. The GitHub Actions workflow
  files that `/install-github-app` writes are the ones Claude Code ships.
- [Tern](https://stencil.so/tern) by Stencil Labs — the terminal and the Tern
  Surface Protocol (TSP), and the `@stencil-hq/tern` SDK this is written on.
- [oh-my-pi](https://github.com/can1357/oh-my-pi) — the reference TSP client.
  Its surface set the bar: `docs/OMP-ROWS.md` goes through its 104 behaviours
  one by one, and this surface keeps its node roles so Tern styles both alike.
- [claude-pi](https://github.com/CompactionHater/claude-pi) by CompactionHater —
  the idea and the specification of a pi-style Claude Code (sparse prompt, lean
  tool set, local and routed models). This repository contains none of
  claude-pi's code. `claude-pi-tsp` fronts an install built from the spec (its
  own launcher, binary and `~/.claude-pi`); the plugins the author publishes
  install into stock Claude Code, so with those you run plain `claude-tsp`
  (that combination has not been tested here yet).
- [pi-tsp](https://github.com/MadeBy561/pi-tsp) — the sister surface for pi,
  from which the editor, picker and reconciler code here began.

## License

MIT, the same as Tern's SDK, oh-my-pi, claude-pi and pi-tsp. See
[LICENSE](LICENSE).
