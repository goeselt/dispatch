# Dispatch

GitHub Action that creates a release tag, creates a GitHub Release, uploads assets, and maintains floating major/minor
tags. Designed as the publish step after [`goeselt/intent`](https://github.com/goeselt/intent) resolves the next
semantic version.

Use Dispatch when release creation should be boring, retry-safe, and guarded: it fails early for doubtful GitHub Actions
contexts, verifies reused tags, keeps floating tags consistent, and treats missing release assets as release blockers.

## Getting Started

```yaml
on:
  push:
    branches: [main]

permissions:
  contents: write # create tags and GitHub Release

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - id: version
        uses: goeselt/intent@v1

      - uses: goeselt/dispatch@v1
        if: steps.version.outputs.release-needed == 'true'
        with:
          release-tag: ${{ steps.version.outputs.release-tag }}
          major-tag: ${{ steps.version.outputs.major-tag }}
          minor-tag: ${{ steps.version.outputs.minor-tag }}
```

> [!NOTE]
>
> By default, Dispatch only runs from the repository's default branch and blocks pull request events and tag refs. If
> you intentionally release from a maintenance branch, set `allow-non-default-branch: true`. See
> [Release Context Guards](docs/integration-guide.md#release-context-guards) for details.

`github-token` defaults to `${{ github.token }}`; `contents: write` covers the standard release case (create tag, create
GitHub Release, update floating tags). Dispatch does not use credentials persisted by `actions/checkout` -- the token is
injected per command only, never written to `.git/config` or retained in the process environment, and removed after each
call -- so `persist-credentials` on the checkout step does not affect Dispatch's tag pushes.

The default `GITHUB_TOKEN` cannot push tags that trigger downstream workflows. For that, pass a GitHub App token via
`github-token`; see [Elevated Permissions](docs/integration-guide.md#elevated-permissions-via-github-app-token).

For binary assets, signed tags, GoReleaser integration, and retry-safe workflow design, see the
[Integration Guide](docs/integration-guide.md).

## Inputs

Tag inputs accept simple Git tag names such as `v1.2.3`, `v1`, and `v1.2`. For safety, tag names cannot contain
whitespace, control characters, refspec syntax, `..`, or option-like values beginning with `-`.

When provided, `major-tag` and `minor-tag` must match the semantic `release-tag`. For `v1.2.3`, the only matching
floating tags are `v1` and `v1.2`.

| Input                      | Default                          | Description                                                                                     |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `release-tag`              |                                  | Release tag name, for example `v1.2.3`. **Required.**                                           |
| `create-tag`               | `true`                           | Create and push the release tag when it does not already exist.                                 |
| `create-release`           | `true`                           | Create the GitHub Release.                                                                      |
| `allow-non-default-branch` | `false`                          | Allow releases from a non-default branch. PR events and tag refs remain blocked.                |
| `make-latest`              | `default-branch`                 | Controls GitHub's Latest marker: `default-branch`, `auto`, `true`, or `false`.                  |
| `signing-key`              |                                  | Base64-encoded GPG private key. When set, all annotated tags created by this action are signed. |
| `assets`                   |                                  | Newline-separated asset files or glob patterns to upload. Paths must exist; globs must match.   |
| `major-tag`                |                                  | Floating major tag to update, e.g. `v1`.                                                        |
| `minor-tag`                |                                  | Floating minor tag to update, e.g. `v1.2`.                                                      |
| `github-token`             | token                            | GitHub token for GitHub REST API calls and Git tag fetch/push operations.                       |
| `git-user-name`            | actor                            | `git user.name` for annotated tags.                                                             |
| `git-user-email`           | <actor@users.noreply.github.com> | `git user.email` for annotated tags.                                                            |

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
