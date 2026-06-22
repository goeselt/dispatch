# Dispatch -- Integration Guide

- [Patterns](#patterns)
  - [Standalone Release](#standalone-release)
  - [Release With Binary Assets](#release-with-binary-assets)
  - [Maintenance Branch Release](#maintenance-branch-release)
  - [Tag Only (GoReleaser)](#tag-only-goreleaser)
  - [Signed Tags](#signed-tags)
  - [Elevated Permissions via GitHub App Token](#elevated-permissions-via-github-app-token)
- [Retry Safety](#retry-safety)
- [Release Context Guards](#release-context-guards)

---

## Patterns

### Standalone Release

Create a release without intent, for example in a manually triggered workflow or when the version is derived externally:

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

By default, maintenance branch releases are marked as not Latest, so they do not accidentally replace the Latest marker
for the main release line. Control this with `make-latest`:

| Value            | Behavior                                                       |
| ---------------- | -------------------------------------------------------------- |
| `default-branch` | Not Latest for a non-default branch; otherwise GitHub decides. |
| `auto`           | GitHub's default Latest calculation in all cases.              |
| `true`           | Force the Latest marker regardless of branch.                  |
| `false`          | Disable the Latest marker explicitly.                          |

`allow-non-default-branch` does not bypass the pull request event guard or the tag-ref guard. Only the default-branch
requirement is relaxed.

### Tag Only (GoReleaser)

When another tool owns the GitHub Release, set `create-release: false` to push only the concrete release tag and skip
floating tag updates:

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

Dispatch does not update floating tags when `create-release` is `false`, because floating tags are only refreshed by the
run that owns the GitHub Release creation. If you want dispatch to manage `major-tag` or `minor-tag` after GoReleaser
finishes, run a second dispatch step with `create-release: true`.

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

If `signing-key` is set and the concrete release tag already exists, dispatch verifies the existing tag with
`git verify-tag` before reusing it. The key is imported into a temporary `GNUPGHOME` pinned to the imported key
fingerprint; the temporary keyring is removed before the action exits.

See [Signing Key Setup](signing-key.md) for a Debian-based setup guide.

### Elevated Permissions via GitHub App Token

The default `GITHUB_TOKEN` cannot push tags that trigger downstream workflows. Pass a GitHub App token when you need
tag-triggered workflow dispatch:

```yaml
- id: app
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ vars.RELEASE_APP_ID }}
    private-key: ${{ secrets.RELEASE_APP_KEY }}

- uses: actions/checkout@v4
  with:
    token: ${{ steps.app.outputs.token }}
    persist-credentials: false

- uses: goeselt/dispatch@v1
  with:
    release-tag: ${{ steps.version.outputs.release-tag }}
    github-token: ${{ steps.app.outputs.token }}
    git-user-name: ${{ steps.app.outputs.app-slug }}[bot]
    git-user-email: ${{ steps.app.outputs.app-slug }}[bot]@users.noreply.github.com
```

Dispatch uses `github-token` for GitHub REST calls (sent as an `Authorization: Bearer` header against `GITHUB_API_URL`)
and as request-scoped authentication for `git fetch`, `git ls-remote`, and `git push`. The token is passed only through
per-command environment or per-request headers, never through `process.env` or `.git/config`: Git network commands
receive it as a temporary `http.<server>.extraheader`, which also overrides any credential the checkout persisted.
`persist-credentials: false` is recommended to make the override explicit, but not required. Dispatch verifies that
`github-token` can access `GITHUB_REPOSITORY` before creating or pushing tags.

---

## Retry Safety

Dispatch is designed to be safe to rerun for the same `release-tag`. It reuses an existing concrete tag and an existing
published GitHub Release (when no assets were requested), and updates floating tags after the concrete release exists.
Floating tags are pushed with `--force-with-lease` to avoid silently overwriting a concurrent update.

| State when rerun starts                                | What dispatch does                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Version bump committed, release tag missing            | Creates the tag and GitHub Release.                                                 |
| Release tag exists, GitHub Release missing             | Creates the GitHub Release.                                                         |
| Tag and published release exist, no assets requested   | Reuses both, refreshes floating tags.                                               |
| Tag and published release exist, assets were requested | Stops -- assets cannot be repaired for immutable releases. Use a new `release-tag`. |
| Existing draft release                                 | Stops -- intended state is ambiguous. Delete or publish the draft and rerun.        |

### Designing retry-safe workflows

The workflow must call dispatch on reruns of a partially completed release. This breaks when dispatch is gated on "a new
bump is needed": if an earlier step persists the version bump (for example by committing `package.json`), and a later
step fails, the rerun may skip dispatch entirely because the bump already happened.

Prefer deriving `release-tag` from persistent state and running dispatch whenever that tag is not fully released, not
only when the current run just produced a fresh version bump.

---

## Release Context Guards

Dispatch creates repository-visible tags and releases, so it only runs from branch contexts by default.

**Default guards (always enforced):**

- Pull request events are blocked.
- Pull request refs (`refs/pull/*`) are blocked.
- Tag refs (`refs/tags/*`) are blocked.
- The current branch must match the repository default branch from the GitHub event payload.
- The checked-out `HEAD` must be `GITHUB_SHA` or a descendant of it. This allows release workflows to commit generated
  version files before dispatch runs, while still blocking unrelated checkouts.

**When a concrete release tag already exists**, dispatch verifies that the tag points to the same commit as the current
release run before reusing it.

**`allow-non-default-branch: true`** relaxes only the default-branch requirement. Pull request event and tag-ref guards
still apply. With the default `make-latest: default-branch` policy, non-default branch releases are created with
`--latest=false`.

Set `allow-non-default-branch: true` when releasing from a maintenance branch, or from a context where GitHub does not
expose the default branch in the event payload.
