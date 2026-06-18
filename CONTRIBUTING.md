# Contributing to Dispatch

## Design

Pure Node.js standard library -- no runtime dependencies, no build step. `index.js` is committed as-is and referenced
directly by `action.yml` (`runs.using: node24`).

The project is intentionally small. Prefer keeping the release flow easy to read over adding abstractions that only save
a few lines. A future maintainer should be able to understand the action by reading `index.js`, then the section headers
in `release.js`.

| File             | Responsibility                                                                |
| ---------------- | ----------------------------------------------------------------------------- |
| `action.yml`     | Public GitHub Action metadata: inputs, outputs, runtime.                      |
| `index.js`       | GitHub Actions adapter: input/env parsing, command execution, outputs.        |
| `assets.js`      | Workspace-contained asset path and glob resolution.                           |
| `github-auth.js` | Scoped `github-token` injection for `gh` and Git network commands.            |
| `signing.js`     | GPG key import into a throwaway keyring and tag-signing configuration.        |
| `summary.js`     | Workflow command escaping, step summaries, and failure recovery guidance.     |
| `tags.js`        | Git tag name validation and semantic floating tag validation.                 |
| `release.js`     | Testable release behavior: guards, validation, git/gh calls, summaries.       |
| `*.test.js`      | Unit tests with fake command execution; no network or real repository writes. |
| `README.md`      | User-facing examples, retry model, release guards, input reference.           |

The action runs inside a checkout, but it does not depend on checkout-persisted credentials for release writes. The
`github-token` input is scoped to individual command executions and never written to `process.env` or `.git/config`:
`gh` receives it as `GH_TOKEN`, and Git network commands (`fetch`, `ls-remote`, `push`) receive it as a request-scoped
`http.<server>.extraheader` injected through Git's environment-based config (`GIT_CONFIG_COUNT`, Git >= 2.31). The
first, empty header value resets any extraheader the checkout persisted for that URL, so the supplied token wins for the
invocation without modifying stored credentials. Tag pushes use `--no-verify` so local `pre-push` hooks cannot observe
that token environment.

## Release Model

Dispatch owns a narrow job: given a concrete `release-tag`, create or reuse the tag, create or reuse the GitHub Release,
upload assets only when creating the release, and then refresh optional floating tags.

The action is retry-friendly but conservative:

- Existing concrete tags are fetched and reused.
- Reused concrete tags must point to the same commit as the current release run.
- Existing published releases are reused.
- Existing draft releases stop the run, because the intended state is ambiguous.
- Assets are uploaded only while creating a new release. Existing releases are not modified.
- Floating tags are pushed with `--force-with-lease` to avoid silently overwriting a concurrent update.
- Floating tags are only updated when dispatch owns the GitHub Release creation for that run.

## Guard Philosophy

Release context guards should run before any Git or GitHub command. The default policy is intentionally boring:

- block pull request events and pull request refs
- block tag refs
- allow branch refs only
- require the current branch to be the repository default branch
- require the checked-out `HEAD` to match `GITHUB_SHA`

`allow-non-default-branch` is the escape hatch for intentional maintenance-branch releases or contexts where GitHub did
not expose the default branch. It must not bypass pull request or tag-ref guards.

Tag and asset validation are similarly defensive. Tags are restricted to simple release names, and assets must resolve
to regular files inside the checked-out workspace. Keep these checks boring and explicit; release code is not the place
for clever parsing.

When `signing-key` is set, existing concrete release tags must pass `git verify-tag` before they are reused. New release
tags are signed through a temporary `GNUPGHOME`; Git is pinned to the imported key fingerprint, and the temporary
keyring is removed before the action exits.

When `GITHUB_REPOSITORY` is present, GitHub CLI release calls should stay bound to that repository and release auth
checks should happen before the concrete tag is created or pushed.

## Code Organization

`release.js` keeps the release orchestration and the Git/GitHub release commands together. Reusable or
security-sensitive helpers live in focused modules:

- `assets.js` for asset path/glob validation.
- `github-auth.js` for scoped token injection.
- `signing.js` for temporary GPG setup.
- `summary.js` for workflow output and failure guidance.
- `tags.js` for tag validation.

Inside `release.js`, keep new helpers close to their section:

- input parsing
- release context guard
- Git and GitHub CLI operations
- release orchestration

When adding a new input, update all of these together:

- `action.yml`
- `index.js`
- `README.md`
- `release.test.js`

Token scoping lives in `github-auth.js`, not in `release.js`: `withGitHubToken` wraps `exec` so that `gh` and Git
network commands receive the `github-token`, and `needsGitHubToken` decides which commands that covers.

When adding a new command, route it through the injected `exec` function so tests can assert the exact command without
touching the network. If the command talks to GitHub (a new `gh` subcommand or a network-facing `git` verb), update
`needsGitHubToken` in `github-auth.js` so it is authenticated.

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
automatically by `goeselt/intent` and determines the version bump on merge.
