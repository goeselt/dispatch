'use strict'

const path = require('node:path')

const { resolveAssets } = require('./assets.js')
const { withGitHubToken } = require('./github-auth.js')
const { branchNameFromRef, hasReleaseContext, inferRefType } = require('./release-context.js')
const { setupSigning } = require('./signing.js')
const { RELEASE_CONTEXT_HELP, logInfo, writeWarning } = require('./summary.js')
const { validateFloatingTags, validateOptionalTagName, validateTagName } = require('./tags.js')

// Input parsing

function parseBool(value, name) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`${name} must be true or false, got ${JSON.stringify(value)}`)
}

function parseMakeLatest(value, name = 'make-latest') {
  const normalized = String(value ?? 'default-branch')
    .trim()
    .toLowerCase()
  if (['default-branch', 'auto', 'true', 'false'].includes(normalized)) return normalized
  throw new Error(`${name} must be default-branch, auto, true, or false, got ${JSON.stringify(value)}`)
}

function parseAssets(input) {
  return String(input ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// Release context guard

function guardReleaseContext(inputs) {
  const context = inputs.releaseContext || {}
  const eventName = context.eventName || ''
  const ref = context.ref || ''
  const refType = context.refType || inferRefType(ref)
  const refName = context.refName || branchNameFromRef(ref)
  const defaultBranch = context.defaultBranch || ''
  const hasGitHubContext = Boolean(eventName || ref || refType || refName || defaultBranch)

  if (!hasGitHubContext) return

  if (eventName.startsWith('pull_request') || ref.startsWith('refs/pull/')) {
    throw new Error(`dispatch cannot create releases from pull request events. ${RELEASE_CONTEXT_HELP}`)
  }

  if (refType && refType !== 'branch') {
    throw new Error(`dispatch can only create releases from branch refs; got ${refType}. ${RELEASE_CONTEXT_HELP}`)
  }

  if (!refName) {
    throw new Error(`dispatch could not determine the current branch. ${RELEASE_CONTEXT_HELP}`)
  }

  if (!defaultBranch && !inputs.allowNonDefaultBranch) {
    throw new Error(
      'dispatch could not determine the repository default branch from the GitHub event payload. Set allow-non-default-branch to true only if this release is intentional.',
    )
  }

  if (defaultBranch && refName !== defaultBranch && !inputs.allowNonDefaultBranch) {
    throw new Error(
      `dispatch is running on ${refName}, but releases are only allowed from the default branch ${defaultBranch}. Set allow-non-default-branch to true only if this branch release is intentional.`,
    )
  }
}

// isNonDefaultBranchRelease reports whether the run targets a branch other than the repository default. Reaching the
// release flow with this true means allow-non-default-branch permitted it (guardReleaseContext would have thrown
// otherwise), so it is worth surfacing in the log.
function isNonDefaultBranchRelease(context = {}) {
  const refName = context.refName || branchNameFromRef(context.ref || '')
  const defaultBranch = context.defaultBranch || ''
  return Boolean(defaultBranch && refName && refName !== defaultBranch)
}

function guardReleaseHead(exec, inputs) {
  const context = inputs.releaseContext || {}
  if (!hasReleaseContext(context)) return ''

  const expected = context.sha || ''
  if (!expected) {
    throw new Error('dispatch could not determine the expected release commit from GITHUB_SHA.')
  }

  const actual = exec('git', ['rev-parse', 'HEAD']).stdout.trim()
  if (actual === expected) return actual

  const ancestor = exec('git', ['merge-base', '--is-ancestor', expected, actual], { allowFailure: true })
  if (ancestor.status === 0) return actual

  throw new Error(
    `dispatch is running on checked-out commit ${actual || '(unknown)'}, but the GitHub event points to ${expected} and is not an ancestor of HEAD. Check the actions/checkout ref before releasing.`,
  )
}

// Git command wrappers

function configureGitUser(exec, name, email) {
  if (name) exec('git', ['config', 'user.name', name])
  if (email) exec('git', ['config', 'user.email', email])
}

function remoteTagObjectId(exec, tag) {
  validateTagName(tag)
  const result = exec('git', ['ls-remote', '--tags', '--refs', 'origin', `refs/tags/${tag}`], { allowFailure: true })
  if (result.status !== 0) throw new Error(`could not check remote tag ${tag}: ${result.stderr || result.stdout}`)
  return result.stdout.trim().split(/\s+/)[0] || ''
}

function localTagTargetObjectId(exec, tag) {
  validateTagName(tag)
  return exec('git', ['rev-parse', `${tag}^{}`]).stdout.trim()
}

function verifyTagSignature(exec, tag) {
  validateTagName(tag)
  exec('git', ['verify-tag', tag])
}

function verifyExistingReleaseTag(exec, tag, expectedSha, requireSignature) {
  if (expectedSha) {
    const actual = localTagTargetObjectId(exec, tag)
    if (actual !== expectedSha) {
      throw new Error(`release tag ${tag} points to ${actual}, but this run is releasing ${expectedSha}.`)
    }
  }
  if (requireSignature) verifyTagSignature(exec, tag)
}

function tagExists(exec, tag) {
  return remoteTagObjectId(exec, tag) !== ''
}

function createTag(exec, tag) {
  validateTagName(tag)
  exec('git', ['tag', '-a', tag, '-m', `Release ${tag}`])
  try {
    exec('git', ['push', '--no-verify', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
  } catch (err) {
    exec('git', ['tag', '-d', tag], { allowFailure: true })
    throw err
  }
}

function fetchTag(exec, tag) {
  validateTagName(tag)
  exec('git', ['fetch', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
}

function updateFloatingTag(exec, floatingTag, releaseTag) {
  if (!floatingTag) return false
  validateTagName(floatingTag)
  validateTagName(releaseTag)
  const expected = remoteTagObjectId(exec, floatingTag)
  exec('git', ['tag', '-fa', floatingTag, `${releaseTag}^{}`, '-m', `Floating tag for ${releaseTag}`])
  exec('git', [
    'push',
    '--no-verify',
    'origin',
    `refs/tags/${floatingTag}:refs/tags/${floatingTag}`,
    `--force-with-lease=refs/tags/${floatingTag}:${expected}`,
  ])
  return true
}

// Release orchestration

// runRelease orchestrates the release. Git operations run synchronously through exec; the GitHub REST operations
// (auth check, release lookup, release creation with asset upload) run through the injected async api client, so the
// whole function is async.
async function runRelease(inputs, exec, api, cwd = process.cwd()) {
  if (!inputs.releaseTag) throw new Error('release-tag is required')
  validateTagName(inputs.releaseTag, 'release-tag')
  validateOptionalTagName(inputs.majorTag, 'major-tag')
  validateOptionalTagName(inputs.minorTag, 'minor-tag')
  guardReleaseContext(inputs)
  validateFloatingTags(inputs)
  if (!inputs.createRelease && (inputs.majorTag || inputs.minorTag)) {
    throw new Error(
      'floating tags require create-release to be true; omit major-tag/minor-tag when another tool owns the release.',
    )
  }
  const expectedReleaseSha = guardReleaseHead(exec, inputs)
  const repo = inputs.releaseContext?.repository

  let cleanupSigning = () => {}
  try {
    return await withGitHubToken(exec, inputs.githubToken, async (releaseExec) => {
      logInfo(`preparing release ${inputs.releaseTag}`)
      if (isNonDefaultBranchRelease(inputs.releaseContext)) {
        logInfo(
          `releasing from non-default branch ${inputs.releaseContext.refName} (allowed by allow-non-default-branch)`,
        )
      }
      configureGitUser(releaseExec, inputs.gitUserName, inputs.gitUserEmail)
      if (inputs.signingKey) {
        cleanupSigning = setupSigning(releaseExec, inputs.signingKey)
        logInfo('tag signing enabled')
      }
      if (inputs.createRelease) await api.checkAuth(repo)

      let tagCreated = false
      if (tagExists(releaseExec, inputs.releaseTag)) {
        fetchTag(releaseExec, inputs.releaseTag)
        verifyExistingReleaseTag(releaseExec, inputs.releaseTag, expectedReleaseSha, Boolean(inputs.signingKey))
        logInfo(`tag ${inputs.releaseTag} already exists; reusing it`)
      } else if (inputs.createTag) {
        createTag(releaseExec, inputs.releaseTag)
        tagCreated = true
        logInfo(`created and pushed tag ${inputs.releaseTag}`)
      } else {
        throw new Error(`release tag ${inputs.releaseTag} does not exist and create-tag is false`)
      }

      let releaseCreated = false
      let releaseUrl = ''
      let assetsUploaded = 0
      if (inputs.createRelease) {
        const existing = await api.getReleaseByTag(repo, inputs.releaseTag)
        if (existing.exists) {
          if (existing.isDraft) {
            throw new Error(
              `release ${inputs.releaseTag} exists but is still a draft; delete or publish it before rerunning`,
            )
          }
          releaseUrl = existing.url
          logInfo(`release ${inputs.releaseTag} already exists; reusing it`)
          if (inputs.assets.length > 0) {
            throw new Error(
              `release ${inputs.releaseTag} already exists, but assets were requested. Dispatch does not upload assets to an existing release because immutable releases cannot be repaired after publish.`,
            )
          }
        } else {
          // Resolve to absolute paths against the same cwd that validated them, so the REST client reads the exact
          // files that asset validation approved rather than re-resolving relative paths against process.cwd().
          const assets = resolveAssets(inputs.assets, cwd).map((asset) => path.resolve(cwd, asset))
          releaseUrl = await api.createRelease(repo, inputs.releaseTag, assets, inputs)
          releaseCreated = true
          assetsUploaded = assets.length
          logInfo(
            `created GitHub Release ${inputs.releaseTag}${assets.length ? ` with ${assets.length} asset(s)` : ''}`,
          )
        }
      } else {
        logInfo('create-release=false; tag-only run, skipping GitHub Release')
        if (inputs.assets.length > 0) {
          writeWarning('assets specified but create-release is false; assets will not be uploaded')
        }
      }

      const majorTagUpdated = updateFloatingTag(releaseExec, inputs.majorTag, inputs.releaseTag)
      if (majorTagUpdated) logInfo(`updated floating tag ${inputs.majorTag} -> ${inputs.releaseTag}`)
      const minorTagUpdated = updateFloatingTag(releaseExec, inputs.minorTag, inputs.releaseTag)
      if (minorTagUpdated) logInfo(`updated floating tag ${inputs.minorTag} -> ${inputs.releaseTag}`)

      return {
        tagCreated,
        releaseCreated,
        releaseUrl,
        assetsUploaded,
        majorTagUpdated,
        minorTagUpdated,
      }
    })
  } finally {
    cleanupSigning()
  }
}

// Export small helpers to keep command-heavy behavior unit-testable without touching the network.
module.exports = {
  createTag,
  fetchTag,
  guardReleaseHead,
  guardReleaseContext,
  localTagTargetObjectId,
  parseAssets,
  parseBool,
  parseMakeLatest,
  remoteTagObjectId,
  runRelease,
  tagExists,
  updateFloatingTag,
  verifyExistingReleaseTag,
  verifyTagSignature,
}
