'use strict'

const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { parseAssets, parseBool, runRelease } = require('./release.js')

function input(name, fallback = '') {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? fallback
}

function setOutput(name, value) {
  const outputFile = process.env['GITHUB_OUTPUT']
  if (!outputFile) return
  fs.appendFileSync(outputFile, `${name}=${value}\n`)
}

function exec(name, args, { allowFailure = false, input } = {}) {
  try {
    const opts = { encoding: 'utf8', stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] }
    if (input !== undefined) opts.input = input
    const stdout = execFileSync(name, args, opts)
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const stdout = err.stdout?.toString() ?? ''
    const stderr = err.stderr?.toString() ?? err.message
    if (allowFailure) return { status: err.status ?? 1, stdout, stderr }
    throw new Error(`${name} ${args.join(' ')}: ${stderr.trim() || stdout.trim() || err.message}`)
  }
}

try {
  const token = input('GITHUB-TOKEN')
  if (token) {
    process.env['GH_TOKEN'] = token
  }

  const actor = process.env['GITHUB_ACTOR'] || 'github-actions[bot]'
  const inputs = {
    releaseTag: input('RELEASE-TAG'),
    createTag: parseBool(input('CREATE-TAG', 'true'), 'create-tag'),
    createRelease: parseBool(input('CREATE-RELEASE', 'true'), 'create-release'),
    signingKey: input('SIGNING-KEY'),
    assets: parseAssets(input('ASSETS')),
    majorTag: input('MAJOR-TAG'),
    minorTag: input('MINOR-TAG'),
    gitUserName: input('GIT-USER-NAME', actor),
    gitUserEmail: input('GIT-USER-EMAIL', `${actor}@users.noreply.github.com`),
  }

  const result = runRelease(inputs, exec)
  setOutput('tag-created', String(result.tagCreated))
  setOutput('release-created', String(result.releaseCreated))
  setOutput('release-url', result.releaseUrl)
  setOutput('assets-uploaded', String(result.assetsUploaded))
  setOutput('major-tag-updated', String(result.majorTagUpdated))
  setOutput('minor-tag-updated', String(result.minorTagUpdated))

  process.stdout.write(
    `tag-created=${result.tagCreated} release-created=${result.releaseCreated} assets-uploaded=${result.assetsUploaded}\n`,
  )
} catch (err) {
  process.stdout.write(`::error title=Shipit::${err.message}\n`)
  process.exit(1)
}
