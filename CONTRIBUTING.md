# Contributing to Dispatch

## Design

Pure Node.js standard library -- no runtime dependencies, no build step. `index.js` is committed as-is and referenced
directly by `action.yml` (`runs.using: node24`).

| File         | Responsibility                                                        |
| ------------ | --------------------------------------------------------------------- |
| `release.js` | Release orchestration, git/gh command wrappers, asset glob expansion. |
| `index.js`   | Input parsing, `GH_TOKEN` wiring, output writing.                     |

The action runs inside a checkout that must have push credentials. For repositories where the default `GITHUB_TOKEN`
cannot push tags, callers pass a GitHub App token via `github-token` and use it in the preceding `actions/checkout`
step.

## Development Setup

- Node.js 20 or later

No dependencies to install.

## Local Verification

Run the linter from the repository root:

```bash
docker pull ghcr.io/goeselt/pedant:latest
docker run --rm -v "$(pwd):/work" ghcr.io/goeselt/pedant:latest
```

Run the unit tests from `project/dispatch/`:

```bash
npm test
```

## Submitting Changes

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/). The PR title is validated
automatically by `goeselt/bumpkin` and determines the version bump on merge.
