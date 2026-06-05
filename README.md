# Shipit

GitHub Action that creates a release tag, creates a GitHub Release, uploads assets, and maintains floating major/minor
tags. Designed as the publish step after [`goeselt/bumpkin`](https://github.com/goeselt/bumpkin) resolves the next
semantic version.

## Quick Start

```yaml
steps:
  - id: version
    uses: goeselt/bumpkin@v1

  - uses: goeselt/shipit@v1
    if: steps.version.outputs.release-needed == 'true'
    with:
      release-tag: ${{ steps.version.outputs.release-tag }}
      major-tag: ${{ steps.version.outputs.major-tag }}
      minor-tag: ${{ steps.version.outputs.minor-tag }}
```

## Usage Examples

### Release With Binary Assets

```yaml
- uses: goeselt/shipit@v1
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
- uses: goeselt/shipit@v1
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
- uses: goeselt/shipit@v1
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
and pass it to shipit:

```yaml
- id: app
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ vars.RELEASE_APP_ID }}
    private-key: ${{ secrets.RELEASE_APP_KEY }}

- uses: actions/checkout@v4
  with:
    token: ${{ steps.app.outputs.token }}

- uses: goeselt/shipit@v1
  with:
    release-tag: ${{ steps.version.outputs.release-tag }}
    github-token: ${{ steps.app.outputs.token }}
    git-user-name: ${{ steps.app.outputs.app-slug }}[bot]
    git-user-email: ${{ steps.app.outputs.app-slug }}[bot]@users.noreply.github.com
```

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
