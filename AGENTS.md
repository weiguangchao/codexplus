# codexplus

## Layout

- npm workspaces monorepo. `packages/tui` is the client (`codexplus`), `packages/app-server` is the server (`codexplus-server`), `packages/shared` holds code both sides use.
- Dependencies point one way: tui → app-server → shared, and tui → shared. app-server and shared never import tui; shared imports no other package.
- Put code in shared only when both tui and app-server use it. Import other packages by name (`@weiguangchao/codexplus-shared`), never by relative path into their `src`.
- Tests live in each package's `test/`. Tests that start both a client and a server go in tui.
- Run scripts from the repo root. Dev and test commands need `--conditions=source` so packages resolve to source; `npm run check` is the full gate.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images embedded in the PR body.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or other PR-only assets into the repo.
- When babysitting: call `watch_pull_request` and end your turn. T3 Code wakes you on checks, comments, or conflicts. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.
