# Dispatch

GitHub Action that creates a release tag, creates a GitHub Release, uploads assets, and maintains floating major/minor
tags. Designed as the publish step after [`goeselt/intent`](https://github.com/goeselt/intent) resolves the next
semantic version.

Use dispatch when release creation should be boring, retry-safe, and guarded: it fails early for doubtful GitHub Actions
contexts, verifies reused tags, keeps floating tags consistent, and treats missing release assets as release blockers.

## Quick Start

```yaml
permissions:
  contents: write

steps:
  - id: version
    uses: goeselt/intent@v1

  - uses: goeselt/dispatch@v1
    if: steps.version.outputs.release-needed == 'true'
    with:
      release-tag: ${{ steps.version.outputs.release-tag }}
      major-tag: ${{ steps.version.outputs.major-tag }}
      minor-tag: ${{ steps.version.outputs.minor-tag }}
```

## Usage Examples

Release jobs only need `contents: write` unless another step requires additional scopes.

### Standalone Release

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0

- uses: goeselt/dispatch@v1
  with:
    release-tag: v1.2.3
```

### Release With Binary Assets

```yaml
- uses: goeselt/dispatch@v1
  with:
    release-tag: ${{ steps.version.outputs.release-tag }}
    major-tag: ${{ steps.version.outputs.major-tag }}
    minor-tag: ${{ steps.version.outputs.minor-tag }}
    assets: |
      dist/my-tool-linux-amd64.tar.gz
      dist/my-tool-darwin-amd64.tar.gz
      dist/checksums.txt
```

Glob patterns are supported: `dist/*.tar.gz`.

Assets must be existing regular files inside the checked-out workspace. Absolute paths, parent-directory traversal, and
symlinks that resolve outside the workspace are rejected before the GitHub Release is created.

Every asset entry is strict: a plain path must exist and every glob must match at least one file. Dispatch also fails
when a published GitHub Release already exists and `assets` were requested, because immutable releases cannot be
repaired by uploading missing assets later. Use a new `release-tag` for changed release artifacts.

If an asset path or glob fails, check that the build step runs before dispatch, writes into the checkout workspace, and
uses the same relative path listed in `assets`.

### Maintenance Branch Release

```yaml
permissions:
  contents: write

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  - uses: goeselt/dispatch@v1
    with:
      release-tag: v1.2.4
      allow-non-default-branch: true
```

By default, maintenance branch releases pass `--latest=false` to `gh release create`, so they do not accidentally
replace the Latest marker for the main release line. Set `make-latest: auto` to use GitHub's default Latest calculation,
`make-latest: true` to force Latest, or `make-latest: false` to disable Latest explicitly.

### Tag Only (GoReleaser Owns the Release)

```yaml
- uses: goeselt/dispatch@v1
  with:
    release-tag: ${{ steps.version.outputs.release-tag }}
    create-release: false

- uses: goreleaser/goreleaser-action@v6
  with:
    version: '~> v2'
    args: release --clean
```

When `create-release` is `false`, dispatch does not update floating tags. Let the release-owning tool finish first, then
run dispatch with `create-release: true` if you want dispatch to refresh `major-tag` or `minor-tag`.

### Signed Tags

Pass a base64-encoded GPG private key to sign all annotated tags created by the action. Consumers can verify releases
with `git verify-tag <tag>` after importing your public key.

See [Signing Key Setup](docs/signing-key.md) for a straight-forward Debian-based setup guide.

```yaml
- uses: goeselt/dispatch@v1
  with:
    release-tag: ${{ steps.version.outputs.release-tag }}
    major-tag: ${{ steps.version.outputs.major-tag }}
    minor-tag: ${{ steps.version.outputs.minor-tag }}
    signing-key: ${{ secrets.RELEASE_SIGNING_KEY }}
```

If `signing-key` is set and the concrete release tag already exists, dispatch verifies the existing tag with
`git verify-tag` before reusing it.

### Elevated Permissions via GitHub App Token

The default `GITHUB_TOKEN` cannot push tags that trigger downstream workflows. Use a GitHub App token for the checkout
and pass it to dispatch:

```yaml
- id: app
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ vars.RELEASE_APP_ID }}
    private-key: ${{ secrets.RELEASE_APP_KEY }}

- uses: actions/checkout@v4
  with:
    token: ${{ steps.app.outputs.token }}

- uses: goeselt/dispatch@v1
  with:
    release-tag: ${{ steps.version.outputs.release-tag }}
    github-token: ${{ steps.app.outputs.token }}
    git-user-name: ${{ steps.app.outputs.app-slug }}[bot]
    git-user-email: ${{ steps.app.outputs.app-slug }}[bot]@users.noreply.github.com
```

When GitHub Actions provides `GITHUB_REPOSITORY`, dispatch checks that `github-token` can access that repository before
creating or pushing tags, and binds GitHub Release CLI calls to that repository.

## Retry-Safe Workflows

Dispatch is designed to be safe to rerun for the same `release-tag`: it reuses an existing tag, reuses an existing
published GitHub Release when no assets were requested, and updates floating tags after the concrete release exists.

The workflow must still call dispatch on reruns of a partially completed release. This matters when an earlier step
persists the version bump, for example by committing `package.json`, before dispatch creates the tag or GitHub Release.
If a later publish step fails and the rerun gates dispatch on "a new bump is needed", the rerun may skip dispatch
forever because the bump already happened.

Prefer deriving `release-tag` from persistent state and running dispatch whenever that tag is not fully released, not
only when the current run just produced a fresh version bump. A retry-safe flow should be able to continue these states:

- version bump committed, release tag missing: dispatch creates the tag and release.
- release tag exists, GitHub Release missing: dispatch creates the release.
- release tag and published GitHub Release exist without requested assets: dispatch reuses both and refreshes floating
  tags.
- release tag and published GitHub Release exist with requested assets: dispatch stops, because assets cannot be
  repaired safely for immutable releases.
- existing draft release: dispatch stops and asks you to delete or publish it before rerunning.

## Release Context Guards

Dispatch creates repository-visible tags and releases, so it only runs from branch contexts by default. Pull request
events, pull request refs, and tag refs are blocked before any Git or GitHub release command runs.

Dispatch also requires the current branch to match the repository default branch from the GitHub event payload. This
prevents accidental releases from feature branches, PR merge refs, detached checkouts, or old maintenance branches.

The checked-out `HEAD` must also match `GITHUB_SHA`. If a workflow checks out a different ref before dispatch runs,
dispatch stops before creating or reusing tags. When a concrete release tag already exists, dispatch verifies that the
tag points to the same commit as the current release run before reusing it.

If you intentionally release from a maintenance branch, or from a context where GitHub does not expose the default
branch in the event payload, set `allow-non-default-branch: true`. This opt-out still does not allow pull request events
or tag refs. With the default `make-latest: default-branch` policy, non-default branch releases are created with
`--latest=false`.

## Inputs

Tag inputs accept simple Git tag names such as `v1.2.3`, `v1`, and `v1.2`. For safety, tag names cannot contain
whitespace, control characters, refspec syntax, `..`, or option-like values beginning with `-`.

When provided, `major-tag` and `minor-tag` must match the semantic `release-tag`. For `v1.2.3`, the only matching
floating tags are `v1` and `v1.2`.

| Input                      | Default          | Description                                                                                     |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `release-tag`              |                  | Release tag name, for example `v1.2.3`. **Required.**                                           |
| `create-tag`               | `true`           | Create and push the release tag when it does not already exist.                                 |
| `create-release`           | `true`           | Create the GitHub Release.                                                                      |
| `allow-non-default-branch` | `false`          | Allow releases from a non-default branch. PR events and tag refs remain blocked.                |
| `make-latest`              | `default-branch` | Controls GitHub's Latest marker: `default-branch`, `auto`, `true`, or `false`.                  |
| `signing-key`              |                  | Base64-encoded GPG private key. When set, all annotated tags created by this action are signed. |
| `assets`                   |                  | Newline-separated asset files or glob patterns to upload. Paths must exist; globs must match.   |
| `major-tag`                |                  | Floating major tag to update, e.g. `v1`.                                                        |
| `minor-tag`                |                  | Floating minor tag to update, e.g. `v1.2`.                                                      |
| `github-token`             | token            | GitHub token used by `gh`.                                                                      |
| `git-user-name`            | actor            | `git user.name` for annotated tags.                                                             |
| `git-user-email`           | actor            | `git user.email` for annotated tags.                                                            |

## Outputs

| Output              | Description                                 |
| ------------------- | ------------------------------------------- |
| `tag-created`       | Whether the release tag was created.        |
| `release-created`   | Whether the GitHub Release was created.     |
| `release-url`       | URL of the created or existing release.     |
| `assets-uploaded`   | Number of uploaded assets.                  |
| `major-tag-updated` | Whether the floating major tag was updated. |
| `minor-tag-updated` | Whether the floating minor tag was updated. |

## GitHub Step Summary

Dispatch writes a concise release summary to `GITHUB_STEP_SUMMARY` when GitHub Actions provides it. The summary includes
the release tag, whether the concrete tag and GitHub Release were created or reused, the release URL, uploaded asset
count, and floating tag updates. Failed runs write a failure summary with the release tag and error message.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
