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
5. Open a PR.

`version-check` fails when a PR does not raise `package.json` above the base
branch. That is intentional: every merged improvement gets a release.

## Releases

Merging a PR with a higher `version` to `main` makes the release workflow:

1. read `package.json`,
2. create the `v<version>` tag if it does not exist,
3. create a GitHub release with the matching changelog section,
4. attach the `npm pack` tarball.

Do not edit a released tag. Cut a new version instead.

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
needs a signed-in Claude Code and takes about 40 minutes, so it is run by hand
before a release and its output kept in `docs/VERIFY.txt`. Do not rebuild
`dist/` or edit the script while it runs.

For a look: `tools/serve.sh start a /tmp/demo "$PWD/bin/claude-tsp"`, then
`tools/serve.sh ctl a shot name` and open the picture under `tools/out/`.
Scripted sessions send Ctrl as Meta; the harness sets
`CLAUDE_TSP_META_AS_CTRL=1` for that, and `CLAUDE_TSP_RECORD=file.jsonl` keeps
every message.
