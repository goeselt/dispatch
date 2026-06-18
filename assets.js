'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ASSET_HELP = 'Use a path to an existing regular file under the checked-out workspace.'

// Asset resolution

function hasGlobMeta(pattern) {
  return /[*?[]/.test(pattern)
}

function assertInsideWorkspace(workspace, target, description) {
  const relative = path.relative(workspace, target)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return
  throw new Error(`${description} must stay inside the workspace. ${ASSET_HELP}`)
}

function realWorkspace(cwd) {
  return fs.realpathSync(cwd)
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
  if (path.isAbsolute(pattern))
    throw new Error(`asset pattern ${pattern} must be relative to the workspace. ${ASSET_HELP}`)
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
  if (path.isAbsolute(entry)) throw new Error(`asset ${entry} must be relative to the workspace. ${ASSET_HELP}`)

  const workspace = realWorkspace(cwd)
  const absolute = path.resolve(cwd, entry)
  let realAsset
  try {
    realAsset = fs.realpathSync(absolute)
  } catch (err) {
    throw new Error(
      `asset ${entry} does not exist. Check that a build step creates it before dispatch runs and that the path is relative to the checkout root.`,
      { cause: err },
    )
  }

  assertInsideWorkspace(workspace, realAsset, `asset ${entry}`)

  const stat = fs.statSync(realAsset)
  if (!stat.isFile()) throw new Error(`asset ${entry} must be a regular file. ${ASSET_HELP}`)

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
      throw new Error(
        `asset pattern ${entry} matched no files. Check that a build step creates the files before dispatch runs and that the path is relative to the checkout root.`,
      )
    }
    assets.push(...matches.map((match) => validateAssetPath(match, cwd)))
  }
  return [...new Set(assets)]
}

module.exports = {
  ASSET_HELP,
  expandGlob,
  resolveAssets,
  validateAssetPath,
}
