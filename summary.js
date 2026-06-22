'use strict'

const { ASSET_HELP } = require('./assets.js')
const { TAG_HELP } = require('./tags.js')

const RELEASE_CONTEXT_HELP =
  'Run dispatch from push, workflow_dispatch, or schedule on the default branch, or set allow-non-default-branch to true for an intentional branch release.'

// GitHub Actions command and summary formatting

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
  const text = value === undefined || value === null || value === '' ? '-' : String(value)
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
  return url.protocol === 'http:' || url.protocol === 'https:'
    ? `<a href="${attributeValue(url.href)}">${text}</a>`
    : text
}

function statusValue(done, active = true) {
  if (!active) return 'skipped by input'
  return done ? 'created' : 'reused'
}

function assetsValue(inputs, result) {
  if (result.assetsUploaded > 0) return codeValue(result.assetsUploaded)

  const requestedAssets = Array.isArray(inputs.assets) && inputs.assets.length > 0
  if (!requestedAssets) return codeValue(0)
  if (!inputs.createRelease) return 'not uploaded (GitHub Release skipped by input)'
  if (!result.releaseCreated) return 'not uploaded (GitHub Release already existed)'
  return codeValue(0)
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
    ['Assets uploaded', assetsValue(inputs, result)],
    ['Major floating tag', floatingTagValue(inputs.majorTag, result.majorTagUpdated)],
    ['Minor floating tag', floatingTagValue(inputs.minorTag, result.minorTagUpdated)],
  ])
}

function failureNextStep(error) {
  const message = String(error?.message || '')

  if (/still a draft/i.test(message)) {
    return 'Publish or delete the draft release, then rerun dispatch.'
  }
  if (/create-tag is false/i.test(message)) {
    return 'Create the tag before running dispatch, or set create-tag to true.'
  }
  if (/asset .*does not exist/i.test(message)) {
    return 'Check that a build step creates the asset before dispatch runs and that the path is relative to the checkout root.'
  }
  if (/asset pattern .*matched no files/i.test(message)) {
    return 'Check that the glob pattern is correct and that a build step creates matching files before dispatch runs.'
  }
  if (/asset .*workspace|asset .*regular file|asset pattern .*workspace/i.test(message)) {
    return ASSET_HELP
  }
  if (/assets were requested/i.test(message)) {
    return 'Use a new release tag for new immutable assets, or rerun without assets if the existing release is intentional.'
  }
  if (/(release-tag|major-tag|minor-tag).*?(tag name|must not|not allowed|required)/i.test(message)) {
    return TAG_HELP
  }
  if (/bad credentials|must authenticate|could not read Username|HTTP 401|HTTP 403/i.test(message)) {
    return 'Check the github-token input and repository permissions, then rerun dispatch.'
  }
  if (/force-with-lease/i.test(message)) {
    return 'Another run updated the floating tag first. Rerun dispatch after the newer release finishes.'
  }
  if (/pull request events|branch refs|default branch|current branch/i.test(message)) {
    return RELEASE_CONTEXT_HELP
  }
  if (/checked-out commit|expected release commit|release tag .* points to/i.test(message)) {
    return 'Check the checkout ref and existing release tag before rerunning dispatch.'
  }
  if (/major-tag|minor-tag|floating tags/i.test(message)) {
    return 'Use floating tags that match the release version, or omit them for tag-only releases.'
  }

  return ''
}

function buildFailureSummary(error, inputs = {}) {
  const rows = [
    ['Status', 'failed'],
    ['Release tag', inputs.releaseTag ? codeValue(inputs.releaseTag) : '-'],
    ['Error', tableValue(error.message)],
  ]
  const nextStep = failureNextStep(error)
  if (nextStep) rows.push(['Next step', tableValue(nextStep)])
  return renderSummaryTable(rows)
}

module.exports = {
  RELEASE_CONTEXT_HELP,
  buildFailureSummary,
  buildStepSummary,
  escapeWorkflowCommand,
  failureNextStep,
  writeWarning,
}
