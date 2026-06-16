# Dispatch

GitHub Action that creates a release tag, creates a GitHub Release, uploads assets, and maintains floating major/minor
tags. Designed as the publish step after [`goeselt/bumpkin`](https://github.com/goeselt/bumpkin) resolves the next
semantic version. Use it as [`goeselt/dispatch`](https://github.com/goeselt/dispatch).

## Quick Start

```yaml
steps:
  - id: version
    uses: goeselt/bumpkin@v1

  - uses: goeselt/dispatch@v1
    if: steps.version.outputs.release-needed == 'true'
    with:
      release-tag: ${{ steps.version.outputs.release-tag }}
      major-tag: ${{ steps.version.outputs.major-tag }}
      minor-tag: ${{ steps.version.outputs.minor-tag }}
```

## Usage Examples

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

### Signed Tags

Pass a base64-encoded GPG private key to sign all annotated tags created by the action. Consumers can verify releases
with `git verify-tag <tag>` after importing your public key.

```yaml
- uses: goeselt/dispatch@v1
  with:
    release-tag: ${{ steps.version.outputs.release-tag }}
    major-tag: ${{ steps.version.outputs.major-tag }}
    minor-tag: ${{ steps.version.outputs.minor-tag }}
    signing-key: ${{ secrets.RELEASE_SIGNING_KEY }}
```

Export and store your private key as a repository secret:

```bash
gpg --export-secret-keys --armor <key-id> | base64 -w0
```

Publish the corresponding public key on a keyserver or in your repository so consumers can verify signatures.

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

## Retry-Safe Workflows

Dispatch is designed to be safe to rerun for the same `release-tag`: it reuses an existing tag, reuses an existing
published GitHub Release, and updates floating tags after the concrete release exists.

The workflow must still call dispatch on reruns of a partially completed release. This matters when an earlier step
persists the version bump, for example by committing `package.json`, before dispatch creates the tag or GitHub Release.
If a later publish step fails and the rerun gates dispatch on "a new bump is needed", the rerun may skip dispatch
forever because the bump already happened.

Prefer deriving `release-tag` from persistent state and running dispatch whenever that tag is not fully released, not
only when the current run just produced a fresh version bump. A retry-safe flow should be able to continue these states:

- version bump committed, release tag missing: dispatch creates the tag and release.
- release tag exists, GitHub Release missing: dispatch creates the release.
- release tag and published GitHub Release exist: dispatch reuses both and refreshes floating tags.
- existing draft release: dispatch stops and asks you to delete or publish it before rerunning.

## Inputs

| Input            | Default | Description                                                                                     |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `release-tag`    |         | Release tag name, for example `v1.2.3`. **Required.**                                           |
| `create-tag`     | `true`  | Create and push the release tag when it does not already exist.                                 |
| `create-release` | `true`  | Create the GitHub Release.                                                                      |
| `signing-key`    |         | Base64-encoded GPG private key. When set, all annotated tags created by this action are signed. |
| `assets`         |         | Newline-separated asset files or glob patterns to upload.                                       |
| `major-tag`      |         | Floating major tag to update, e.g. `v1`.                                                        |
| `minor-tag`      |         | Floating minor tag to update, e.g. `v1.2`.                                                      |
| `github-token`   | token   | GitHub token used by `gh`.                                                                      |
| `git-user-name`  | actor   | `git user.name` for annotated tags.                                                             |
| `git-user-email` | actor   | `git user.email` for annotated tags.                                                            |

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
