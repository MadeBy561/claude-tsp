# Contributing

Thanks for improving claude-tsp. It is a small Node.js front end with one
runtime dependency, Tern's SDK; keep changes focused and check them in a real
Tern surface where you can.

## Development

```sh
git clone https://github.com/MadeBy561/claude-tsp.git
cd claude-tsp
npm install
npm test        # builds, then runs the unit tests
npm link
claude-tsp
```

Requirements: Node 22.19+, Claude Code 2.1.300+ (signed in), and Tern 0.9.20+
for the native surface.

## Pull requests

1. Make the change.
2. Bump `version` in `package.json` using Semantic Versioning:
   - patch for fixes and internal changes,
   - minor for new user-visible features,
   - major for breaking changes.
3. Add the same version section to `CHANGELOG.md`.
4. Run `npm test`.
5. Open a PR and label it.

Every issue and PR carries labels from this set, and no others:

| Label | For |
|---|---|
| `bug` | Something works wrong |
| `visual` | Works, but looks wrong on screen |
| `enhancement` | A new feature or an improvement |
| `documentation` | README, docs or changelog only |
| `chore` | Build, CI, tests, dependencies, cleanup |
| `release` | The version bump and changelog of a release |
| `claude-code-compat` | Caused by a Claude Code update or protocol change |
| `claude-pi` | Only affects the `claude-pi-tsp` profile |
| `tern` | Needs a change or an answer on Tern's side |
| `needs-repro` | Not reproduced yet |
| `duplicate` | Already tracked elsewhere |
| `wontfix` | Will not be worked on |

`version-check` fails when a PR does not raise `package.json` above the base
branch. That is intentional: every merged improvement gets a release.

## Releases

Merging a PR with a higher `version` to `main` makes the release workflow:

1. read `package.json`,
2. create the `v<version>` tag if it does not exist,
3. create a GitHub release with the matching changelog section,
4. attach the `npm pack` tarball.

Do not edit a released tag. Cut a new version instead.

A release that was checked against a newer Claude Code says so: set
`claudeCode.tested` in `package.json` to the newest version that both
`claude-tsp --check-compat` and `tools/verify.sh` passed with. The
`claude-code-compat` workflow runs the first of those every day against the
newest Claude Code and opens an issue when it fails.

## Scope

- `src/launcher.ts` decides between a surface and stock Claude Code; nothing
  else does.
- `src/cc.ts` speaks Claude Code's stream-json protocol and nothing else;
  `docs/PROTOCOL.md` records what was learned about it.
- `src/model.ts` knows Claude Code's messages and nothing about Tern.
- `src/view/*.ts` are pure: conversation plus UI state in, nodes out. They build
  with the Tern SDK's `node()`; the SDK owns ids, diffing, framing and flow control.
- `src/app.ts` owns focus, keys, commands and the session.
- Node roles keep oh-my-pi's names (`omp.*`) so Tern styles this surface as it
  styles that one; roles of this surface's own start with `claude.`.
- A change to what is drawn needs a test asserting the nodes, **and a look in
  Tern**: the tests read the document, not how it looks.
- Claude Code is not patched and its private service calls are not imitated.
  What it gives a host no request for stays in its own UI (`/tui`).
- Do not add runtime dependencies unless there is a strong reason.
- Never commit credentials, keys, session files or personal paths.

## Testing the surface

`npm test` runs the unit tests. `tools/verify.sh` drives real sessions in
headless Tern (`tern serve` and `tern ctl`) and checks the live document; it
needs a signed-in Claude Code, so it is run by hand: all of it before a
feature release (about 4 minutes, output kept in `docs/VERIFY.txt`), the
sections a fix touches before a patch. Do not rebuild `dist/` or edit the
script while it runs.

The script is made of sections (`tools/verify.sh --list`). Each is one session
with its own Tern, folders and state under `/tmp/ctsp-verify/NAME`, which is
what lets them run side by side: a check must not reach outside its section's
folders (`$W`, `$DEMO`, `$OTHER`) or look at processes other than its own. Put
a new check in the section whose session it needs, and only when it needs a
live session; anything else is a unit test. A new section is a function
`s_NAME` plus its name in `SECTIONS`, `LONGEST_FIRST` and `about`. A section
that stops before its end counts as a failure.

For a look: `tools/serve.sh start a /tmp/demo "$PWD/bin/claude-tsp"`, then
`tools/serve.sh ctl a shot name` and open the picture under `tools/out/`.
Scripted sessions send Ctrl as Meta; the harness sets
`CLAUDE_TSP_META_AS_CTRL=1` for that, and `CLAUDE_TSP_RECORD=file.jsonl` keeps
every message.
