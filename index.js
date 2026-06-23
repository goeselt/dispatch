'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { parseAssets, parseBool, parseMakeLatest, runRelease } = require('./release.js')
const { createClient } = require('./github-api.js')
const { buildFailureSummary, buildStepSummary, escapeWorkflowCommand, logInfo } = require('./summary.js')

// GitHub Actions adapter helpers

// input reads an action input. GitHub Actions sets INPUT_<NAME> to an empty string for any input declared with an empty
// default, so an absent input arrives as '' rather than undefined. We treat empty as "not provided" (|| not ??) so a
// caller-supplied fallback -- such as the bot identity for git-user-name/email -- actually applies.
function input(name, fallback = '') {
  return process.env[`INPUT_${name.toUpperCase()}`] || fallback
}

function setOutput(name, value) {
  const outputFile = process.env['GITHUB_OUTPUT']
  if (!outputFile) return
  const delimiter = `dispatch_${crypto.randomUUID()}`
  fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

function appendStepSummary(markdown) {
  const summaryFile = process.env['GITHUB_STEP_SUMMARY']
  if (!summaryFile) return
  fs.appendFileSync(summaryFile, `${markdown}\n`)
}

function readDefaultBranch(eventPath) {
  if (!eventPath) return ''
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    return event?.repository?.default_branch || ''
  } catch {
    return ''
  }
}

function exec(name, args, { allowFailure = false, input, env } = {}) {
  try {
    const opts = { encoding: 'utf8', stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] }
    if (input !== undefined) opts.input = input
    if (env) opts.env = env
    const stdout = execFileSync(name, args, opts)
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const stdout = err.stdout?.toString() ?? ''
    const stderr = err.stderr?.toString() ?? err.message
    if (allowFailure) return { status: err.status ?? 1, stdout, stderr }
    throw new Error(`${name} ${args.join(' ')}: ${stderr.trim() || stdout.trim() || err.message}`, { cause: err })
  }
}

// Entry point

let inputs = {}

async function main() {
  const token = input('GITHUB-TOKEN')
  const actor = process.env['GITHUB_ACTOR'] || 'github-actions[bot]'
  inputs = {
    releaseTag: input('RELEASE-TAG'),
    createTag: parseBool(input('CREATE-TAG', 'true'), 'create-tag'),
    createRelease: parseBool(input('CREATE-RELEASE', 'true'), 'create-release'),
    allowNonDefaultBranch: parseBool(input('ALLOW-NON-DEFAULT-BRANCH', 'false'), 'allow-non-default-branch'),
    makeLatest: parseMakeLatest(input('MAKE-LATEST', 'default-branch')),
    signingKey: input('SIGNING-KEY'),
    assets: parseAssets(input('ASSETS')),
    majorTag: input('MAJOR-TAG'),
    minorTag: input('MINOR-TAG'),
    githubToken: token,
    gitUserName: input('GIT-USER-NAME', actor),
    gitUserEmail: input('GIT-USER-EMAIL', `${actor}@users.noreply.github.com`),
    releaseContext: {
      eventName: process.env['GITHUB_EVENT_NAME'] || '',
      ref: process.env['GITHUB_REF'] || '',
      refName: process.env['GITHUB_REF_NAME'] || '',
      refType: process.env['GITHUB_REF_TYPE'] || '',
      sha: process.env['GITHUB_SHA'] || '',
      repository: process.env['GITHUB_REPOSITORY'] || '',
      defaultBranch: readDefaultBranch(process.env['GITHUB_EVENT_PATH']),
    },
  }

  const api = createClient(token, {
    onRetry: ({ method, status, attempt, maxAttempts, delayMs }) =>
      logInfo(
        `retrying ${method} after ${status ? `HTTP ${status}` : 'network error'} (attempt ${attempt}/${maxAttempts}) in ${delayMs}ms`,
      ),
  })
  const result = await runRelease(inputs, exec, api)
  setOutput('tag-created', String(result.tagCreated))
  setOutput('release-created', String(result.releaseCreated))
  setOutput('release-url', result.releaseUrl)
  setOutput('assets-uploaded', String(result.assetsUploaded))
  setOutput('major-tag-updated', String(result.majorTagUpdated))
  setOutput('minor-tag-updated', String(result.minorTagUpdated))
  appendStepSummary(buildStepSummary(inputs, result))

  const releaseState = inputs.createRelease ? (result.releaseCreated ? 'created' : 'reused') : 'skipped'
  logInfo(
    `done -- tag=${result.tagCreated ? 'created' : 'reused'} release=${releaseState} assets=${result.assetsUploaded}`,
  )
}

// Run only when invoked directly (the action entry point), so tests can require this file for its helpers without
// triggering a release.
if (require.main === module) {
  main().catch((err) => {
    appendStepSummary(buildFailureSummary(err, inputs))
    logInfo(`release failed: ${err.message}`)
    process.stdout.write(`::error title=Dispatch::${escapeWorkflowCommand(err.message)}\n`)
    process.exit(1)
  })
}

module.exports = { input }
