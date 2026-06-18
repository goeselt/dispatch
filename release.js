'use strict'

const fs = require('node:fs')
const path = require('node:path')

function parseBool(value, name) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`${name} must be true or false, got ${JSON.stringify(value)}`)
}

function parseAssets(input) {
  return String(input ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function escapeWorkflowCommand(value) {
  return String(value ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
}

function writeWarning(message) {
  process.stdout.write(`::warning title=Dispatch::${escapeWorkflowCommand(message)}\n`)
}

function tableValue(value) {
  const text = String(value || '-')
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
}

function codeValue(value) {
  return `<code>${tableValue(value)}</code>`
}

function attributeValue(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function linkValue(value) {
  const text = tableValue(value)
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    return text
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? `<a href="${attributeValue(url.href)}">${text}</a>` : text
}

function statusValue(done, active = true) {
  if (!active) return 'skipped'
  return done ? 'created' : 'reused'
}

function hasGlobMeta(pattern) {
  return /[*?[]/.test(pattern)
}

function assertInsideWorkspace(workspace, target, description) {
  const relative = path.relative(workspace, target)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return
  throw new Error(`${description} must stay inside the workspace`)
}

function realWorkspace(cwd) {
  return fs.realpathSync(cwd)
}

function validateTagName(tag, name = 'tag') {
  if (!tag) throw new Error(`${name} is required`)
  if (tag !== tag.trim()) throw new Error(`${name} must not have leading or trailing whitespace`)
  if (/[\x00-\x20\x7f]/.test(tag)) throw new Error(`${name} must not contain whitespace or control characters`)
  if (tag.startsWith('-')) throw new Error(`${name} must not start with -`)
  if (tag.startsWith('/') || tag.endsWith('/') || tag.includes('//')) throw new Error(`${name} must be a valid tag name`)
  if (tag.includes('..')) throw new Error(`${name} must not contain ..`)
  if (tag.includes('@{') || tag === '@') throw new Error(`${name} must be a valid tag name`)
  if (/[~^:?*[\]\\{}]/.test(tag)) throw new Error(`${name} contains characters that are not allowed in git tags`)
  if (tag.endsWith('.') || tag.endsWith('.lock')) throw new Error(`${name} must be a valid tag name`)
  for (const part of tag.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) {
      throw new Error(`${name} must be a valid tag name`)
    }
  }
  return tag
}

function validateOptionalTagName(tag, name) {
  if (!tag) return ''
  return validateTagName(tag, name)
}

function globToRegExp(pattern) {
  let out = '^'
  for (const ch of pattern) {
    if (ch === '*') {
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[\\^$+?.()|{}[\]]/g, '\\$&')
    }
  }
  return new RegExp(`${out}$`)
}

function walk(dir) {
  const entries = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      entries.push(...walk(fullPath))
    } else {
      entries.push(fullPath)
    }
  }
  return entries
}

function expandGlob(pattern, cwd = process.cwd()) {
  if (path.isAbsolute(pattern)) throw new Error(`asset pattern ${pattern} must be relative to the workspace`)
  const normalized = pattern.split(path.sep).join('/')
  const segments = normalized.split('/')
  const firstGlob = segments.findIndex((segment) => hasGlobMeta(segment))
  const baseSegments = firstGlob === -1 ? segments.slice(0, -1) : segments.slice(0, firstGlob)
  const baseDir = baseSegments.length === 0 ? '.' : baseSegments.join('/')
  const absoluteBase = path.resolve(cwd, baseDir)

  if (!fs.existsSync(absoluteBase)) return []

  assertInsideWorkspace(realWorkspace(cwd), fs.realpathSync(absoluteBase), `asset pattern ${pattern}`)

  const re = globToRegExp(normalized)
  return walk(absoluteBase)
    .map((file) => path.relative(cwd, file).split(path.sep).join('/'))
    .filter((file) => re.test(file))
    .sort()
}

function validateAssetPath(entry, cwd = process.cwd()) {
  if (path.isAbsolute(entry)) throw new Error(`asset ${entry} must be relative to the workspace`)

  const workspace = realWorkspace(cwd)
  const absolute = path.resolve(cwd, entry)
  let realAsset
  try {
    realAsset = fs.realpathSync(absolute)
  } catch (err) {
    throw new Error(`asset ${entry} does not exist`, { cause: err })
  }

  assertInsideWorkspace(workspace, realAsset, `asset ${entry}`)

  const stat = fs.statSync(realAsset)
  if (!stat.isFile()) throw new Error(`asset ${entry} must be a regular file`)

  return path.relative(cwd, absolute).split(path.sep).join('/')
}

function resolveAssets(entries, cwd = process.cwd()) {
  const assets = []
  for (const entry of entries) {
    if (!hasGlobMeta(entry)) {
      assets.push(validateAssetPath(entry, cwd))
      continue
    }

    const matches = expandGlob(entry, cwd)
    if (matches.length === 0) {
      writeWarning(`asset pattern matched no files: ${entry}`)
    }
    assets.push(...matches.map((match) => validateAssetPath(match, cwd)))
  }
  return [...new Set(assets)]
}

function setupSigning(exec, signingKey) {
  exec('gpg', ['--import', '--batch'], { input: Buffer.from(signingKey, 'base64') })
  exec('git', ['config', 'tag.gpgsign', 'true'])
}

function configureGitUser(exec, name, email) {
  if (name) exec('git', ['config', 'user.name', name])
  if (email) exec('git', ['config', 'user.email', email])
}

function checkReleaseAuth(exec) {
  exec('gh', ['auth', 'status'])
}

function remoteTagObjectId(exec, tag) {
  validateTagName(tag)
  const result = exec('git', ['ls-remote', '--tags', '--refs', 'origin', `refs/tags/${tag}`], { allowFailure: true })
  if (result.status !== 0) throw new Error(`could not check remote tag ${tag}: ${result.stderr || result.stdout}`)
  return result.stdout.trim().split(/\s+/)[0] || ''
}

function tagExists(exec, tag) {
  return remoteTagObjectId(exec, tag) !== ''
}

function createTag(exec, tag) {
  validateTagName(tag)
  exec('git', ['tag', '-a', tag, '-m', `Release ${tag}`])
  try {
    exec('git', ['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
  } catch (err) {
    exec('git', ['tag', '-d', tag], { allowFailure: true })
    throw err
  }
}

function fetchTag(exec, tag) {
  validateTagName(tag)
  exec('git', ['fetch', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
}

// `gh release view` exits non-zero with "release not found" (or an HTTP 404 from the underlying API call) when the
// tag has no release. Any other non-zero exit (auth, rate limit, network) must not be mistaken for a missing
// release, or this action would try to create a release that already exists.
function isMissingReleaseError(output) {
  return /(^|[\s:])(?:release )?not found(?:[\s.]|$)|HTTP 404/i.test(output)
}

function releaseView(exec, tag) {
  validateTagName(tag)
  const result = exec('gh', ['release', 'view', tag, '--json', 'url,isDraft'], { allowFailure: true })
  if (result.status !== 0) {
    const output = result.stderr || result.stdout
    if (isMissingReleaseError(output)) return { exists: false, url: '' }
    throw new Error(`could not check release ${tag}: ${output}`)
  }
  let release
  try {
    release = JSON.parse(result.stdout)
  } catch (err) {
    throw new Error(`could not parse release ${tag} response: ${result.stdout}`, { cause: err })
  }
  return { exists: true, url: release.url || '', isDraft: Boolean(release.isDraft) }
}

// Assets are passed to `gh release create` directly so GitHub CLI can create a draft, upload assets, and publish it.
// With release immutability on, a separate upload after publishing fails because assets can no longer be modified.
function createRelease(exec, tag, assets = []) {
  validateTagName(tag)
  const assetArgs = assets.length > 0 ? ['--', ...assets] : []
  const result = exec('gh', ['release', 'create', tag, '--generate-notes', '--verify-tag', ...assetArgs])
  return result.stdout.trim()
}

function updateFloatingTag(exec, floatingTag, releaseTag) {
  if (!floatingTag) return false
  validateTagName(floatingTag)
  validateTagName(releaseTag)
  const expected = remoteTagObjectId(exec, floatingTag)
  exec('git', ['tag', '-fa', floatingTag, `${releaseTag}^{}`, '-m', `Floating tag for ${releaseTag}`])
  exec('git', [
    'push',
    'origin',
    `refs/tags/${floatingTag}:refs/tags/${floatingTag}`,
    `--force-with-lease=refs/tags/${floatingTag}:${expected}`,
  ])
  return true
}

function renderSummaryTable(rows) {
  const lines = [
    '## Dispatch Release',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
    '',
  ]
  return lines.join('\n')
}

function floatingTagValue(tag, updated) {
  return tag ? `${tableValue(tag)} ${updated ? 'updated' : 'not updated'}` : '-'
}

function buildStepSummary(inputs, result) {
  const releaseUrl = result.releaseUrl ? linkValue(result.releaseUrl) : '-'
  return renderSummaryTable([
    ['Release tag', codeValue(inputs.releaseTag)],
    ['Tag', statusValue(result.tagCreated)],
    ['GitHub Release', statusValue(result.releaseCreated, inputs.createRelease)],
    ['Release URL', releaseUrl],
    ['Assets uploaded', codeValue(result.assetsUploaded)],
    ['Major floating tag', floatingTagValue(inputs.majorTag, result.majorTagUpdated)],
    ['Minor floating tag', floatingTagValue(inputs.minorTag, result.minorTagUpdated)],
  ])
}

function buildFailureSummary(error, inputs = {}) {
  return renderSummaryTable([
    ['Status', 'failed'],
    ['Release tag', inputs.releaseTag ? codeValue(inputs.releaseTag) : '-'],
    ['Error', tableValue(error.message)],
  ])
}

function runRelease(inputs, exec, cwd = process.cwd()) {
  if (!inputs.releaseTag) throw new Error('release-tag is required')
  validateTagName(inputs.releaseTag, 'release-tag')
  validateOptionalTagName(inputs.majorTag, 'major-tag')
  validateOptionalTagName(inputs.minorTag, 'minor-tag')

  configureGitUser(exec, inputs.gitUserName, inputs.gitUserEmail)
  if (inputs.signingKey) setupSigning(exec, inputs.signingKey)
  if (inputs.createRelease) checkReleaseAuth(exec)

  let tagCreated = false
  if (tagExists(exec, inputs.releaseTag)) {
    fetchTag(exec, inputs.releaseTag)
    process.stdout.write(`tag ${inputs.releaseTag} already exists; reusing it\n`)
  } else if (inputs.createTag) {
    createTag(exec, inputs.releaseTag)
    tagCreated = true
  } else {
    throw new Error(`release tag ${inputs.releaseTag} does not exist and create-tag is false`)
  }

  let releaseCreated = false
  let releaseUrl = ''
  let assetsUploaded = 0
  if (inputs.createRelease) {
    const existing = releaseView(exec, inputs.releaseTag)
    if (existing.exists) {
      if (existing.isDraft) {
        throw new Error(
          `release ${inputs.releaseTag} exists but is still a draft; delete or publish it before rerunning`,
        )
      }
      releaseUrl = existing.url
      process.stdout.write(`release ${inputs.releaseTag} already exists; reusing it\n`)
    } else {
      const assets = resolveAssets(inputs.assets, cwd)
      releaseUrl = createRelease(exec, inputs.releaseTag, assets)
      releaseCreated = true
      assetsUploaded = assets.length
    }
  } else if (inputs.assets.length > 0) {
    writeWarning('assets specified but create-release is false; assets will not be uploaded')
  }

  const majorTagUpdated = updateFloatingTag(exec, inputs.majorTag, inputs.releaseTag)
  const minorTagUpdated = updateFloatingTag(exec, inputs.minorTag, inputs.releaseTag)

  return {
    tagCreated,
    releaseCreated,
    releaseUrl,
    assetsUploaded,
    majorTagUpdated,
    minorTagUpdated,
  }
}

module.exports = {
  buildFailureSummary,
  buildStepSummary,
  checkReleaseAuth,
  createRelease,
  createTag,
  escapeWorkflowCommand,
  expandGlob,
  fetchTag,
  isMissingReleaseError,
  parseAssets,
  parseBool,
  releaseView,
  remoteTagObjectId,
  resolveAssets,
  runRelease,
  setupSigning,
  tagExists,
  updateFloatingTag,
  validateAssetPath,
  validateTagName,
}
