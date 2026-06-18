'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildFailureSummary, buildStepSummary, escapeWorkflowCommand, failureNextStep } = require('./summary.js')

function inputs(overrides = {}) {
  return {
    releaseTag: 'v1.2.3',
    createRelease: true,
    assets: [],
    majorTag: '',
    minorTag: '',
    ...overrides,
  }
}

test('escapeWorkflowCommand escapes runner command separators', () => {
  assert.equal(escapeWorkflowCommand('bad%value\r\n::error::owned'), 'bad%25value%0D%0A::error::owned')
})

test('buildStepSummary describes the release result', () => {
  const summary = buildStepSummary(inputs({ majorTag: 'v1', minorTag: 'v1.2' }), {
    tagCreated: true,
    releaseCreated: true,
    releaseUrl: 'https://github.com/org/repo/releases/tag/v1.2.3',
    assetsUploaded: 2,
    majorTagUpdated: true,
    minorTagUpdated: true,
  })

  assert.match(summary, /## Dispatch Release/)
  assert.match(summary, /\| Release tag \| <code>v1\.2\.3<\/code> \|/)
  assert.match(summary, /\| Tag \| created \|/)
  assert.match(summary, /\| GitHub Release \| created \|/)
  assert.match(
    summary,
    /\| Release URL \| <a href="https:\/\/github\.com\/org\/repo\/releases\/tag\/v1\.2\.3">https:\/\/github\.com\/org\/repo\/releases\/tag\/v1\.2\.3<\/a> \|/,
  )
  assert.match(summary, /\| Assets uploaded \| <code>2<\/code> \|/)
  assert.match(summary, /\| Major floating tag \| v1 updated \|/)
  assert.match(summary, /\| Minor floating tag \| v1\.2 updated \|/)
})

test('buildStepSummary marks GitHub Release as skipped when create-release is false', () => {
  const summary = buildStepSummary(inputs({ createRelease: false }), {
    tagCreated: true,
    releaseCreated: false,
    releaseUrl: '',
    assetsUploaded: 0,
    majorTagUpdated: false,
    minorTagUpdated: false,
  })

  assert.match(summary, /\| GitHub Release \| skipped by input \|/)
  assert.match(summary, /\| Release URL \| - \|/)
  assert.match(summary, /\| Assets uploaded \| <code>0<\/code> \|/)
})

test('buildStepSummary explains why requested assets were not uploaded', () => {
  const skippedByInput = buildStepSummary(inputs({ createRelease: false, assets: ['dist/*.zip'] }), {
    tagCreated: true,
    releaseCreated: false,
    releaseUrl: '',
    assetsUploaded: 0,
    majorTagUpdated: false,
    minorTagUpdated: false,
  })
  const existingRelease = buildStepSummary(inputs({ assets: ['dist/*.zip'] }), {
    tagCreated: false,
    releaseCreated: false,
    releaseUrl: 'https://github.com/org/repo/releases/tag/v1.2.3',
    assetsUploaded: 0,
    majorTagUpdated: false,
    minorTagUpdated: false,
  })

  assert.match(skippedByInput, /\| Assets uploaded \| not uploaded \(GitHub Release skipped by input\) \|/)
  assert.match(existingRelease, /\| Assets uploaded \| not uploaded \(GitHub Release already existed\) \|/)
})

test('buildFailureSummary describes release failures', () => {
  const summary = buildFailureSummary(new Error('token | denied'), inputs())

  assert.match(summary, /## Dispatch Release/)
  assert.match(summary, /\| Status \| failed \|/)
  assert.match(summary, /\| Release tag \| <code>v1\.2\.3<\/code> \|/)
  assert.match(summary, /\| Error \| token \\\| denied \|/)
})

test('buildFailureSummary escapes summary HTML from untrusted text', () => {
  const summary = buildFailureSummary(new Error('<script>alert(1)</script>'), inputs({ releaseTag: 'v1.2.3' }))

  assert.match(summary, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(summary, /<script>/)
})

test('buildFailureSummary includes a next step for actionable failures', () => {
  const summary = buildFailureSummary(new Error('asset dist/tool.zip does not exist'), inputs())

  assert.match(summary, /\| Next step \| Check that a build step creates the asset before dispatch runs/)
})

test('failureNextStep maps common release failures to recovery guidance', () => {
  assert.match(failureNextStep(new Error('release v1.2.3 exists but is still a draft')), /Publish or delete/)
  assert.match(
    failureNextStep(new Error('release tag v1.2.3 does not exist and create-tag is false')),
    /Create the tag/,
  )
  assert.match(failureNextStep(new Error('gh auth status: not logged in')), /github-token/)
  assert.match(failureNextStep(new Error('dispatch cannot create releases from pull request events')), /default branch/)
})
