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

function hasGlobMeta(pattern) {
  return /[*?[]/.test(pattern)
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
  const normalized = pattern.split(path.sep).join('/')
  const segments = normalized.split('/')
  const firstGlob = segments.findIndex((segment) => hasGlobMeta(segment))
  const baseSegments = firstGlob === -1 ? segments.slice(0, -1) : segments.slice(0, firstGlob)
  const baseDir = baseSegments.length === 0 ? '.' : baseSegments.join('/')
  const absoluteBase = path.resolve(cwd, baseDir)

  if (!fs.existsSync(absoluteBase)) return []

  const re = globToRegExp(normalized)
  return walk(absoluteBase)
    .map((file) => path.relative(cwd, file).split(path.sep).join('/'))
    .filter((file) => re.test(file))
    .sort()
}

function resolveAssets(entries, cwd = process.cwd()) {
  const assets = []
  for (const entry of entries) {
    if (!hasGlobMeta(entry)) {
      assets.push(entry)
      continue
    }

    const matches = expandGlob(entry, cwd)
    if (matches.length === 0) {
      process.stdout.write(`::warning title=Shipit::asset pattern matched no files: ${entry}\n`)
    }
    assets.push(...matches)
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

function tagExists(exec, tag) {
  const result = exec('git', ['ls-remote', '--tags', 'origin', tag], { allowFailure: true })
  if (result.status !== 0) throw new Error(`could not check remote tag ${tag}: ${result.stderr || result.stdout}`)
  return result.stdout.trim() !== ''
}

function createTag(exec, tag) {
  exec('git', ['tag', '-a', tag, '-m', `Release ${tag}`])
  exec('git', ['push', 'origin', tag])
}

function releaseView(exec, tag) {
  const result = exec('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'], { allowFailure: true })
  if (result.status !== 0) return { exists: false, url: '' }
  return { exists: true, url: result.stdout.trim() }
}

// Assets are passed to `gh release create` directly rather than uploaded in a follow-up `gh release upload` call.
// With "Enable release immutability" on, GitHub freezes the release immediately after creation, so a separate upload
// fails with "Cannot upload assets to an immutable release".
// Attaching assets at creation time is a single atomic operation and works either way.
function createRelease(exec, tag, assets = []) {
  const result = exec('gh', ['release', 'create', tag, ...assets, '--generate-notes'])
  return result.stdout.trim()
}

function updateFloatingTag(exec, floatingTag, releaseTag) {
  if (!floatingTag) return false
  exec('git', ['tag', '-fa', floatingTag, `${releaseTag}^{}`, '-m', `Floating tag for ${releaseTag}`])
  exec('git', ['push', 'origin', floatingTag, '--force'])
  return true
}

function runRelease(inputs, exec, cwd = process.cwd()) {
  if (!inputs.releaseTag) throw new Error('release-tag is required')

  configureGitUser(exec, inputs.gitUserName, inputs.gitUserEmail)
  if (inputs.signingKey) setupSigning(exec, inputs.signingKey)

  let tagCreated = false
  if (tagExists(exec, inputs.releaseTag)) {
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
      releaseUrl = existing.url
      process.stdout.write(`release ${inputs.releaseTag} already exists; reusing it\n`)
    } else {
      const assets = resolveAssets(inputs.assets, cwd)
      releaseUrl = createRelease(exec, inputs.releaseTag, assets)
      releaseCreated = true
      assetsUploaded = assets.length
    }
  } else if (inputs.assets.length > 0) {
    process.stdout.write(
      `::warning title=Shipit::assets specified but create-release is false; assets will not be uploaded\n`,
    )
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
  createRelease,
  createTag,
  expandGlob,
  parseAssets,
  parseBool,
  releaseView,
  resolveAssets,
  runRelease,
  setupSigning,
  tagExists,
  updateFloatingTag,
}
